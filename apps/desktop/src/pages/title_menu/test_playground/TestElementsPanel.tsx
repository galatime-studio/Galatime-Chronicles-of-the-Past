import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ElementIcon } from '../../../assets/GalatimeIcon';
import CommonButton from '../../../components/common/CommonButton';
import CommonInput from '../../../components/common/CommonInput';
import CommonTooltip from '../../../components/common/CommonTooltip';
import { fetchAttacks } from '../../../controllers/attackController';
import { getAllElementsDataService } from '../../../services/elementService';
import type { ElementData } from '../../../types/ElementDataType';
import type { PublicAttack } from '../../../types/AttackDataType';
import { buildSkillTreeLayout, getLearnableAttacks } from '../../../utils/skillTreeLayout';
import { TestElementInfo } from './components/TestElementInfo';
import { TestElementWeaknessMatrix } from './components/TestElementWeaknessMatrix';
import { TestSkillTreeMap } from './components/TestSkillTreeMap';
import { groupElementsByType, humanizeElementType } from './elementGroups';

/** The element the page opens on. */
const DEFAULT_ELEMENT_ID = 'aqua';

/**
 * How tall the skill tree map is drawn inside the scrolling page.
 *
 * The map pans and zooms on its own, so it needs a frame of its own: left to the
 * page it would grow with the tree and the page would never stop scrolling.
 */
const SKILL_TREE_FRAME = 'h-[30rem]';

/**
 * The heading each block of the page carries.
 *
 * The page is read on a small screen, so the headings follow the game's own body
 * size instead of the micro size: at the pixel font's scale, anything smaller
 * stops being read and starts being decoration.
 */
const SECTION_TITLE = 'text-sm uppercase tracking-[0.2em] text-white/50';

/**
 * The element page of the playground: every element of the catalogue, one at a time, and the
 * three things worth knowing about the selected one — what it is, how it fares against the
 * other elements and the skill trees it opens — all on one page, which scrolls.
 */
export function TestElementsPanel() {
    const { t } = useTranslation('playground');
    const [attacks, setAttacks] = useState<PublicAttack[]>([]);
    const [elements, setElements] = useState<ElementData[]>([]);
    const [selectedElementId, setSelectedElementId] = useState(DEFAULT_ELEMENT_ID);
    const [activeTreeId, setActiveTreeId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;

        Promise.all([fetchAttacks(), getAllElementsDataService()])
            .then(([attackList, elementList]) => {
                if (cancelled) return;
                setAttacks(attackList);
                setElements(elementList);
                setLoading(false);
            })
            .catch((error: unknown) => {
                console.error('Failed to load the element playground:', error);
                if (cancelled) return;
                setLoadFailed(true);
                setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    /**
     * The label a kind is shown under.
     *
     * A kind the game has no word for keeps its own name, spelled out: the bands of
     * the picker are read from the catalogue, not from a list written here.
     */
    const labelForType = useMemo(
        () => (type: string) => t(`playground.elements.groups.${type}`, {
            defaultValue: humanizeElementType(type),
        }),
        [t],
    );

    /** The catalogue, filtered by the search and grouped by kind. */
    const groups = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const matches = needle
            ? elements.filter((element) => element.name.toLowerCase().includes(needle)
                || element.id.toLowerCase().includes(needle))
            : elements;
        return groupElementsByType(matches, labelForType);
    }, [elements, query, labelForType]);

    const selectedElement = useMemo(
        () => elements.find((element) => element.id === selectedElementId) ?? elements[0] ?? null,
        [elements, selectedElementId],
    );

    /** The skill trees the selected element opens; each one is a page of its own. */
    const trees = selectedElement?.skillTrees ?? [];
    const activeTree = activeTreeId && trees.includes(activeTreeId) ? activeTreeId : trees[0] ?? null;

    const visibleAttacks = useMemo(() => {
        if (!selectedElement || !activeTree) return [];
        // The learnability rules stay shared: the set of learnable skills is computed against the
        // selected element, then filtered by the tree on screen.
        const learnable = getLearnableAttacks(attacks, [selectedElement]);
        return learnable.filter((attack) => attack.element_id === activeTree);
    }, [attacks, selectedElement, activeTree]);
    const layout = useMemo(() => buildSkillTreeLayout(visibleAttacks), [visibleAttacks]);

    function selectElement(element: ElementData) {
        setSelectedElementId(element.id);
        // The page follows the element just picked: it opens on the tree that element heads.
        setActiveTreeId(element.skillTrees[0] ?? null);
    }

    if (loading) {
        return <div className="flex h-full items-center justify-center text-base text-white/50">{t('playground.elements.loading')}</div>;
    }

    if (loadFailed) {
        return <div role="alert" className="flex h-full items-center justify-center text-base text-red-200/80">{t('playground.elements.loadError')}</div>;
    }

    if (!selectedElement) {
        return <div className="flex h-full items-center justify-center text-base text-white/45">{t('playground.elements.empty')}</div>;
    }

    return (
        <div className="flex h-full min-h-0 flex-col gap-3">
            {/* The picker holds the whole catalogue — the playground is a dev bench, so nothing
                is hidden from it — and only one element is selected at a time. It is a single
                horizontal strip: the catalogue is long, the information of the element is what
                the page is about, and a strip that only scrolls sideways leaves the height of
                the page to the thing the reader came for. */}
            <div className="flex shrink-0 items-center gap-3">
                <div className="w-56 shrink-0">
                    <CommonInput
                        variant="bare"
                        title={t('playground.elements.search')}
                        placeholder={t('playground.elements.search')}
                        value={query}
                        onChange={setQuery}
                        maxCharacters={40}
                        containerClassName="items-stretch"
                        inputClassName="text-base"
                    />
                </div>

                <div className="min-w-0 flex-1 overflow-x-auto pb-2 pl-1">
                    {groups.length === 0 ? (
                        <p className="text-sm text-white/45">{t('playground.elements.searchEmpty')}</p>
                    ) : (
                        <div className="flex items-center gap-4">
                            {groups.map((group) => (
                                <div key={group.type} className="flex shrink-0 items-center gap-2">
                                    {/* The band names its own elements: the header stands at the
                                        head of the band and scrolls with it. */}
                                    <span className="flex shrink-0 items-center gap-1.5 pr-1">
                                        <span className="text-xs uppercase tracking-[0.15em] text-white/50">
                                            {group.label}
                                        </span>
                                        <span className="text-xs text-white/30">{group.elements.length}</span>
                                    </span>
                                    <div className="flex shrink-0 items-center gap-1.5">
                                        {group.elements.map((element) => {
                                            const isSelected = element.id === selectedElement.id;

                                            return (
                                                <CommonButton
                                                    key={element.id}
                                                    variant="ghost"
                                                    size="md"
                                                    aria-pressed={isSelected}
                                                    onPress={() => selectElement(element)}
                                                    className={`normal-case tracking-normal gap-2 px-3 py-1.5 ${isSelected
                                                        ? 'border-game border-white/70 bg-white text-galatime-dark'
                                                        : 'border-game border-white/10 opacity-60 hover:opacity-100'
                                                        }`}
                                                >
                                                    <ElementIcon id={element.id} className="h-6 w-6" />
                                                    <span className="normal-case">{element.name}</span>
                                                </CommonButton>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* One page, one scroll: the information, the weakness table and the skill tree
                of the selected element, read from the top down. */}
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <section className="flex flex-col gap-2 pb-6">
                    <h3 className={SECTION_TITLE}>{t('playground.elements.sections.info')}</h3>
                    <TestElementInfo
                        element={selectedElement}
                        elements={elements}
                        typeLabel={labelForType(selectedElement.type)}
                    />
                </section>

                <section className="flex flex-col gap-2 pb-6">
                    <h3 className={SECTION_TITLE}>{t('playground.elements.sections.weaknesses')}</h3>
                    <TestElementWeaknessMatrix element={selectedElement} elements={elements} />
                </section>

                <section className="flex flex-col gap-2">
                    <h3 className={SECTION_TITLE}>{t('playground.elements.sections.skillTree')}</h3>
                    <div className={`relative ${SKILL_TREE_FRAME} overflow-hidden border-game border-white/10 bg-galatime-background`}>
                        <div className="pointer-events-none absolute inset-0 opacity-30 bg-[linear-gradient(to_right,rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-size-[32px_32px]" />
                        {visibleAttacks.length === 0 ? (
                            <div className="relative flex h-full items-center justify-center px-4 text-center text-base text-white/45">
                                {t('playground.elements.skillTree.empty')}
                            </div>
                        ) : (
                            <TestSkillTreeMap layout={layout} />
                        )}

                        {/* Pagination: one page per skill tree the element opens. It is the
                            same island the zoom controls use, standing on the other side of
                            the map and wrapping its own pages. */}
                        {trees.length > 0 && (
                            <nav
                                aria-label={t('playground.elements.skillTree.pages')}
                                className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-1 border-game border-white/10 bg-black/50 p-1"
                                onPointerDown={(event) => event.stopPropagation()}
                            >
                                {trees.map((treeId) => {
                                    const tree = elements.find((element) => element.id === treeId);
                                    const isActive = treeId === activeTree;

                                    return (
                                        <CommonTooltip key={treeId} content={tree?.name ?? treeId}>
                                            <CommonButton
                                                variant="ghost"
                                                aria-pressed={isActive}
                                                aria-label={tree?.name ?? treeId}
                                                onPress={() => setActiveTreeId(treeId)}
                                                className={`h-7 w-7 p-0 ${isActive
                                                    ? 'bg-white text-galatime-dark opacity-100'
                                                    : 'opacity-70 hover:opacity-100'
                                                    }`}
                                            >
                                                <ElementIcon id={treeId} className="h-5 w-5" />
                                            </CommonButton>
                                        </CommonTooltip>
                                    );
                                })}
                            </nav>
                        )}
                    </div>
                </section>
            </div>
        </div>
    );
}
