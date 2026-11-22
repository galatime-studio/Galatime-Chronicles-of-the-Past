import { useState, useEffect, useRef } from 'react';

export interface CombatStatsBarProps {
    /** Current stat value */
    current: number;
    /** Maximum stat value */
    max: number;
    /** Optional title, it will appear at the start */
    title?: string;
    /** Whether to show the title */
    showTitle?: boolean;
    /** Optional className for the outer container */
    className?: string;
    /** Duration of the deplete animation in milliseconds */
    depleteDuration?: number;
    /** Duration of the restore animation in milliseconds */
    restoreDuration?: number;
    /** Amount of deplete to preview */
    previewDeplete?: number;
    /** Amount of restore to preview */
    previewRestore?: number;
    /** Orientation of the bar (left-to-right, right-to-left, top-to-bottom, bottom-to-top) */
    orientation?: 'ltr' | 'rtl' | 'ttb' | 'btt';
    /** Optional className for the health portion of the bar */
    healthClass?: string;
    /** Optional className for the deplete portion of the bar */
    depleteClass?: string;
    /** Optional className for the restore portion of the bar */
    restoreClass?: string;
    /** Optional className for the preview deplete portion of the bar */
    previewDepleteClass?: string;
    /** Optional className for the preview restore portion of the bar */
    previewRestoreClass?: string;
    /** Optional className for the track portion of the bar */
    trackClass?: string;
    /** Optional className for the title */
    titleClass?: string;
}

/** A reading clamped into the track it is drawn on. */
function clampValue(value: number, max: number): number {
    return Math.max(0, Math.min(value, max));
}

const CombatStatsBar = ({
    current,
    max,
    title = 'HP',
    showTitle = true,
    className = '',
    depleteDuration = 500,
    restoreDuration = 500,
    previewDeplete = 0,
    previewRestore = 0,
    orientation = 'ltr',
    healthClass = 'bg-galatime-stats-health',
    depleteClass = 'bg-galatime-stats-damage',
    restoreClass = 'bg-galatime-stats-gain-health',
    previewDepleteClass = 'bg-galatime-stats-damage/60',
    previewRestoreClass = 'bg-galatime-stats-gain-health/60',
    trackClass = 'bg-white/10',
    titleClass = '',
}: CombatStatsBarProps) => {
    const [displayedHp, setDisplayedHp] = useState(() => clampValue(current, max));

    /**
     * The `current` the bar was reading on the previous render.
     *
     * Every change is replayed as the deplete/restore band, so health lost
     * flashes red instead of the fill merely jumping to its new size. Reading
     * the prop from the previous render - rather than the state the bar has
     * already moved to - keeps a clamped or mid-animation value from hiding
     * part of the change. Remount the bar (`key`) to reseed it with no replay,
     * e.g. when the component starts reading a different character.
     */
    const previousCurrent = useRef(current);

    const [depleteAnim, setDepleteAnim] = useState<{
        start: number;
        size: number;
        phase: 'expand' | 'shrink';
    } | null>(null);

    const [restoreAnim, setRestoreAnim] = useState<{
        start: number;
        size: number;
    } | null>(null);

    const depleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const restoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const isHorizontal = orientation === 'ltr' || orientation === 'rtl';
    const isVertical = !isHorizontal;
    const isLTR = orientation === 'ltr';
    const isRTL = orientation === 'rtl';
    const isTTB = orientation === 'ttb';

    useEffect(() => {
        const from = clampValue(previousCurrent.current, max);
        const to = clampValue(current, max);
        previousCurrent.current = current;

        setDisplayedHp(to);

        if (to < from) {
            const start = (to / max) * 100;
            const size = ((from - to) / max) * 100;

            setDepleteAnim({ start, size, phase: 'expand' });

            if (depleteTimeoutRef.current) clearTimeout(depleteTimeoutRef.current);
            depleteTimeoutRef.current = setTimeout(() => {
                setDepleteAnim({ start, size, phase: 'shrink' });
                depleteTimeoutRef.current = setTimeout(() => {
                    setDepleteAnim(null);
                }, depleteDuration);
            }, depleteDuration);
            return;
        }

        if (to > from) {
            const startExpand = (from / max) * 100;
            const sizeExpand = ((to - from) / max) * 100;
            const startShrink = (to / max) * 100;

            setRestoreAnim({ start: startExpand, size: sizeExpand });

            if (restoreTimeoutRef.current) clearTimeout(restoreTimeoutRef.current);
            restoreTimeoutRef.current = setTimeout(() => {
                setRestoreAnim({ start: startShrink, size: 0 });
                restoreTimeoutRef.current = setTimeout(() => {
                    setRestoreAnim(null);
                }, restoreDuration);
            }, restoreDuration);
        }
    }, [current, max, depleteDuration, restoreDuration]);

    // A replay still in flight when the bar goes away has nobody left to paint.
    useEffect(() => () => {
        if (depleteTimeoutRef.current) clearTimeout(depleteTimeoutRef.current);
        if (restoreTimeoutRef.current) clearTimeout(restoreTimeoutRef.current);
    }, []);

    const hpPercent = (displayedHp / max) * 100;

    const dmgAmt = Math.min(previewDeplete, displayedHp);
    const restoreAmt = Math.min(previewRestore, max - displayedHp);

    // Orientation helpers
    const posProp = isLTR ? 'left' : isRTL ? 'right' : isTTB ? 'top' : 'bottom';
    const sizeProp = isHorizontal ? 'width' : 'height';
    const crossPosProp = isHorizontal ? 'top' : 'left';
    const crossSizeProp = isHorizontal ? 'height' : 'width';

    const buildStyle = (startPct: number, sizePct: number, extra: Record<string, string | number> = {}) => ({
        [posProp]: `${startPct}%`,
        [sizeProp]: `${sizePct}%`,
        [crossPosProp]: '0%',
        [crossSizeProp]: '100%',
        ...extra,
    });

    /**
     * Keeps an animated band from vanishing into a sub-pixel sliver.
     *
     * A band is measured in percent of `max`, so a 2-damage hit on a 445 HP
     * pool works out to a quarter of a pixel: technically drawn, invisible in
     * practice. Anything non-zero is given a floor so the change reads.
     * Only the overlays get this - the health fill must be free to reach 0%.
     */
    const bandFloor = (sizePct: number): Record<string, string> => (
        sizePct > 0 ? (isHorizontal ? { minWidth: '2px' } : { minHeight: '2px' }) : {}
    );

    const depleteOrigin = isLTR
        ? 'origin-right'
        : isRTL
            ? 'origin-left'
            : isTTB
                ? 'origin-bottom'
                : 'origin-top';

    const healthStyle = buildStyle(0, hpPercent, { transition: 'all 500ms ease-out' });

    const depleteStyle = depleteAnim
        ? buildStyle(
            depleteAnim.start,
            depleteAnim.phase === 'expand' ? depleteAnim.size : 0,
            {
                transitionDuration: `${depleteDuration}ms`,
                transitionProperty: sizeProp,
                transitionTimingFunction: 'ease-out',
                ...bandFloor(depleteAnim.phase === 'expand' ? depleteAnim.size : 0),
            }
        )
        : {};

    const restoreStyle = restoreAnim
        ? buildStyle(
            restoreAnim.start,
            restoreAnim.size,
            {
                transitionDuration: `${restoreDuration}ms`,
                transitionProperty: `${sizeProp}, ${posProp}`,
                transitionTimingFunction: 'ease-out',
                ...bandFloor(restoreAnim.size),
            }
        )
        : {};

    const previewDepleteStyle = buildStyle(
        ((displayedHp - dmgAmt) / max) * 100,
        (dmgAmt / max) * 100,
        bandFloor(dmgAmt)
    );

    const previewRestoreStyle = buildStyle(
        (displayedHp / max) * 100,
        (restoreAmt / max) * 100,
        bandFloor(restoreAmt)
    );

    // Layout classes based on orientation
    const outerFlexClass = isLTR
        ? 'flex flex-row items-center gap-2'
        : isRTL
            ? 'flex flex-row-reverse items-center gap-2'
            : isTTB
                ? 'flex flex-col items-center gap-2'
                : 'flex flex-col-reverse items-center gap-2';

    const trackDimensionClass = isHorizontal ? 'w-full h-1.5' : 'w-1.5 h-full';

    return (
        <div className={`w-full ${className} ${isVertical ? 'h-full' : ''}`}>
            <div className={`flex ${outerFlexClass} ${isVertical ? 'flex-col h-full' : 'flex-row'} justify-center items-center`}>
                {showTitle && (
                    <div className={`text-white/40 text-sm whitespace-nowrap ${titleClass}`}>
                        {title}
                    </div>
                )}
                <div className={`flex-1 relative ${isVertical ? 'w-full h-full' : ''} flex justify-center items-center`}>
                    <div className={`${trackDimensionClass} relative overflow-hidden ${trackClass}`}>
                        {/* Current health fill */}
                        <div className={`absolute ${healthClass}`} style={healthStyle} />

                        {/* Deplete animation overlay */}
                        {depleteAnim && (
                            <div
                                className={`absolute ${depleteClass} ${depleteOrigin}`}
                                style={depleteStyle}
                            />
                        )}

                        {/* Restore animation overlay */}
                        {restoreAnim && (
                            <div className={`absolute ${restoreClass}`} style={restoreStyle} />
                        )}

                        {/* Preview deplete overlay */}
                        {previewDeplete > 0 && dmgAmt > 0 && (
                            <div
                                className={`absolute ${previewDepleteClass} animate-stat-preview`}
                                style={previewDepleteStyle}
                            />
                        )}

                        {/* Preview restore overlay */}
                        {previewRestore > 0 && restoreAmt > 0 && (
                            <div
                                className={`absolute ${previewRestoreClass} animate-stat-preview`}
                                style={previewRestoreStyle}
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CombatStatsBar;
