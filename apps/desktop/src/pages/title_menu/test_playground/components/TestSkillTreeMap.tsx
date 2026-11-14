import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react';
import { useTranslation } from 'react-i18next';
import { AddIcon, FitIcon, RemoveIcon, UNKNOWN_ELEMENT_ICON } from '../../../../assets/GalatimeIcon';
import CommonImage from '../../../../components/common/CommonImage';
import CommonButton from '../../../../components/common/CommonButton';
import { SkillNodeTooltip } from '../../../../components/game/skills/SkillNodeTooltip';
import type { PublicAttack } from '../../../../types/AttackDataType';
import {
    FIT_ZOOM_FLOOR,
    FIT_ZOOM_RATIO,
    MAX_ZOOM,
    MIN_ZOOM,
    SKILL_ICON_SIZE,
    SKILL_NODE_SIZE,
    ZOOM_BUTTON_STEP,
    ZOOM_WHEEL_SENSITIVITY,
    type SkillTreeLayout,
    type SkillTreeLayoutNode,
} from '../../../../utils/skillTreeLayout';

const SKILL_IMAGE_FALLBACK = UNKNOWN_ELEMENT_ICON;

/** Camera of the map: a scale plus the translation applied to the laid-out world. */
interface SkillTreeView {
    zoom: number;
    x: number;
    y: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** Rescales the map around a point, so whatever sits under that point stays put. */
function zoomAbout(view: SkillTreeView, zoom: number, pointX: number, pointY: number): SkillTreeView {
    if (zoom === view.zoom) return view;
    const ratio = zoom / view.zoom;
    return {
        zoom,
        x: pointX - (pointX - view.x) * ratio,
        y: pointY - (pointY - view.y) * ratio,
    };
}

/**
 * The skill tree map: the laid-out skills, the connectors between them and the camera
 * the user drives (drag, wheel, the zoom buttons). The tree on screen is chosen by the
 * panel; this component only draws what it is handed.
 */
export function TestSkillTreeMap({ layout }: { layout: SkillTreeLayout }) {
    const { t } = useTranslation('playground');
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const activeDrag = useRef<{ pointerId: number; startX: number; startY: number; viewX: number; viewY: number } | null>(null);
    const [view, setView] = useState<SkillTreeView>({ zoom: 1, x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);

    /** Frames the whole map; runs on every new layout and from the "fit" button. */
    const fitToView = useCallback(() => {
        const viewport = viewportRef.current;
        if (!viewport || layout.width <= 0 || layout.height <= 0) return;

        const zoom = clamp(
            Math.min(viewport.clientWidth / layout.width, viewport.clientHeight / layout.height) * FIT_ZOOM_RATIO,
            FIT_ZOOM_FLOOR,
            MAX_ZOOM,
        );
        setView({
            zoom,
            x: (viewport.clientWidth - layout.width * zoom) / 2,
            y: (viewport.clientHeight - layout.height * zoom) / 2,
        });
    }, [layout.width, layout.height]);

    useEffect(() => {
        fitToView();
    }, [fitToView]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return undefined;

        // A resize keeps the zoom the user picked and only re-centres the map.
        const observer = new ResizeObserver(() => {
            setView((current) => ({
                ...current,
                x: (viewport.clientWidth - layout.width * current.zoom) / 2,
                y: (viewport.clientHeight - layout.height * current.zoom) / 2,
            }));
        });
        observer.observe(viewport);
        return () => observer.disconnect();
    }, [layout.width, layout.height]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return undefined;

        // Registered natively: React's wheel handler cannot reliably preventDefault, and the page
        // must not scroll while the map is being zoomed.
        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            const rect = viewport.getBoundingClientRect();
            const cursorX = event.clientX - rect.left;
            const cursorY = event.clientY - rect.top;
            setView((current) => zoomAbout(
                current,
                clamp(current.zoom * Math.exp(-event.deltaY * ZOOM_WHEEL_SENSITIVITY), MIN_ZOOM, MAX_ZOOM),
                cursorX,
                cursorY,
            ));
        };

        viewport.addEventListener('wheel', handleWheel, { passive: false });
        return () => viewport.removeEventListener('wheel', handleWheel);
    }, []);

    /** One zoom step around the middle of the viewport, for the `+` / `-` buttons. */
    function zoomByStep(factor: number) {
        const viewport = viewportRef.current;
        if (!viewport) return;
        setView((current) => zoomAbout(
            current,
            clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM),
            viewport.clientWidth / 2,
            viewport.clientHeight / 2,
        ));
    }

    function startDragging(event: ReactPointerEvent<HTMLDivElement>) {
        if (event.button !== 0) return;
        activeDrag.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            viewX: view.x,
            viewY: view.y,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsDragging(true);
    }

    function moveMap(event: ReactPointerEvent<HTMLDivElement>) {
        const drag = activeDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        setView((current) => ({
            ...current,
            x: drag.viewX + event.clientX - drag.startX,
            y: drag.viewY + event.clientY - drag.startY,
        }));
    }

    function stopDragging(event: ReactPointerEvent<HTMLDivElement>) {
        if (activeDrag.current?.pointerId !== event.pointerId) return;
        activeDrag.current = null;
        setIsDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }

    const nodeById = new Map(layout.nodes.map((node) => [node.skill.id, node]));
    const edges = useMemo(() => layout.edges.flatMap(({ parentId, childId }) => {
        const parent = nodeById.get(parentId);
        const child = nodeById.get(childId);
        return parent && child ? [{ parentId, childId, parent, child }] : [];
    }), [layout.edges, nodeById]);
    const nodeSize = SKILL_NODE_SIZE * view.zoom;
    const iconSize = SKILL_ICON_SIZE * view.zoom;

    return (
        <div
            ref={viewportRef}
            className={`relative h-full w-full overflow-hidden touch-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            onPointerDown={startDragging}
            onPointerMove={moveMap}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
        >
            {/* The world div is sized in screen pixels, so the zoom is plain arithmetic on the
                node boxes and positions. A CSS transform would instead scale the sprite canvases
                without making CommonImage re-measure, and they would come out blurry. */}
            <div
                className="absolute left-0 top-0"
                style={{
                    width: layout.width * view.zoom,
                    height: layout.height * view.zoom,
                    transform: `translate(${view.x}px, ${view.y}px)`,
                }}
            >
                <svg
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                    preserveAspectRatio="none"
                >
                    <defs>
                        {edges.map(({ parentId, childId, parent, child }) => (
                            <linearGradient
                                key={edgeGradientId(parentId, childId)}
                                id={edgeGradientId(parentId, childId)}
                                gradientUnits="userSpaceOnUse"
                                x1={parent.x}
                                y1={parent.y}
                                x2={child.x}
                                y2={child.y}
                            >
                                {/* The line fades into both sprites instead of stopping against them. */}
                                <stop offset="0" stopColor="#a0a0a0" stopOpacity="0" />
                                <stop offset="0.18" stopColor="#a0a0a0" stopOpacity="0.85" />
                                <stop offset="0.82" stopColor="#a0a0a0" stopOpacity="0.85" />
                                <stop offset="1" stopColor="#a0a0a0" stopOpacity="0" />
                            </linearGradient>
                        ))}
                    </defs>

                    {edges.map(({ parentId, childId, parent, child }) => (
                        <path
                            key={`${parentId}:${childId}`}
                            d={buildSkillEdgePath(parent, child)}
                            fill="none"
                            stroke={`url(#${edgeGradientId(parentId, childId)})`}
                            strokeWidth={2}
                            strokeLinecap="round"
                            vectorEffect="non-scaling-stroke"
                        />
                    ))}
                </svg>

                {layout.nodes.map((node) => (
                    <SkillTreeNode
                        key={node.skill.id}
                        skill={node.skill}
                        x={node.x * view.zoom}
                        y={node.y * view.zoom}
                        size={nodeSize}
                        iconSize={iconSize}
                    />
                ))}
            </div>

            <div
                className="absolute bottom-3 right-3 z-10 flex items-center gap-1 border-game border-white/10 bg-black/50 p-1"
                onPointerDown={(event) => event.stopPropagation()}
            >
                <CommonButton
                    variant="ghost"
                    icon={<RemoveIcon className="h-4 w-4" />}
                    className="h-6 w-6 opacity-70 hover:opacity-100"
                    aria-label={t('playground.elements.skillTree.zoomOut')}
                    title={t('playground.elements.skillTree.zoomOut')}
                    onPress={() => zoomByStep(1 / ZOOM_BUTTON_STEP)}
                />
                <CommonButton
                    variant="ghost"
                    icon={<FitIcon className="h-4 w-4" />}
                    className="h-6 w-6 opacity-70 hover:opacity-100"
                    aria-label={t('playground.elements.skillTree.fitView')}
                    title={t('playground.elements.skillTree.fitView')}
                    onPress={fitToView}
                />
                <CommonButton
                    variant="ghost"
                    icon={<AddIcon className="h-4 w-4" />}
                    className="h-6 w-6 opacity-70 hover:opacity-100"
                    aria-label={t('playground.elements.skillTree.zoomIn')}
                    title={t('playground.elements.skillTree.zoomIn')}
                    onPress={() => zoomByStep(ZOOM_BUTTON_STEP)}
                />
            </div>
        </div>
    );
}

function SkillTreeNode({
    skill,
    x,
    y,
    size,
    iconSize,
}: {
    skill: PublicAttack;
    /** Centre of the node, already scaled by the map zoom. */
    x: number;
    y: number;
    size: number;
    iconSize: number;
}) {
    const [isTooltipOpen, setIsTooltipOpen] = useState(false);
    const { refs, floatingStyles } = useFloating({
        open: isTooltipOpen,
        onOpenChange: setIsTooltipOpen,
        placement: 'top',
        whileElementsMounted: autoUpdate,
        middleware: [offset(10), flip(), shift({ padding: 12 })],
    });

    return (
        <>
            <button
                ref={refs.setReference}
                type="button"
                data-skill-node="true"
                aria-label={`${skill.name} (${skill.element_id})`}
                onMouseEnter={() => setIsTooltipOpen(true)}
                onMouseLeave={() => setIsTooltipOpen(false)}
                onFocus={() => setIsTooltipOpen(true)}
                onBlur={() => setIsTooltipOpen(false)}
                className="absolute z-1 flex items-center justify-center border-0 bg-transparent p-0 outline-game outline-offset-2 outline-transparent transition-[outline-color] duration-150 hover:outline-white/60 focus-visible:outline-white"
                style={{ left: x - size / 2, top: y - size / 2, width: size, height: size }}
            >
                <CommonImage
                    src={`/images/skills/${skill.element_id}/${skill.id}.png`}
                    alt={skill.name}
                    className="shrink-0 drop-shadow-[0_0_7px_rgba(255,255,255,0.18)]"
                    style={{ width: iconSize, height: iconSize }}
                    fallbackSrc={SKILL_IMAGE_FALLBACK}
                />
            </button>

            <SkillNodeTooltip
                skill={skill}
                open={isTooltipOpen}
                floatingRef={refs.setFloating}
                floatingStyles={floatingStyles}
            />
        </>
    );
}

/** Unique id of the gradient that fades one connector into its two skills. */
function edgeGradientId(parentId: string, childId: string): string {
    return `skill-edge-${parentId}-${childId}`;
}

/**
 * Connector from a prerequisite to the skill it unlocks. Both control points sit on the vertical
 * axis of their node, so the line leaves and enters the sprites straight and only bends in the
 * middle — the curved links of the reference tree instead of straight diagonals.
 */
function buildSkillEdgePath(parent: SkillTreeLayoutNode, child: SkillTreeLayoutNode): string {
    const middleY = (parent.y + child.y) / 2;
    return `M ${parent.x} ${parent.y} C ${parent.x} ${middleY}, ${child.x} ${middleY}, ${child.x} ${child.y}`;
}
