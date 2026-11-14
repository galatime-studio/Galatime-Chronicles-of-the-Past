import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ElementIcon } from '../../../../assets/GalatimeIcon';
import type { ElementData } from '../../../../types/ElementDataType';

interface TestElementInfoProps {
    /** The element the panel has selected. */
    element: ElementData;
    /** Every element of the catalogue, so the relations and the trees can be named. */
    elements: readonly ElementData[];
    /** How the element's kind is spelled out. */
    typeLabel: string;
}

/** The relation kinds the catalogue may author, from the strongest to the weakest. */
const RELATIONS = [
    { key: 'immune', labelKey: 'relationImmune' },
    { key: 'super_strong', labelKey: 'relationSuperStrong' },
    { key: 'strong', labelKey: 'relationStrong' },
    { key: 'weak', labelKey: 'relationWeak' },
    { key: 'super_weak', labelKey: 'relationSuperWeak' },
] as const;

/**
 * The badge a kind wears.
 *
 * The catalogue may grow kinds the game has no colour for; those keep the quiet
 * neutral badge instead of borrowing the ones of the kinds that exist.
 */
const TYPE_BADGES: Record<string, string> = {
    natural: 'border-galatime-successHover text-galatime-successHover',
    corrupted: 'border-galatime-errorHover text-galatime-errorHover',
};

/**
 * What the catalogue says about the selected element: what it is, what it does and how it
 * fares against the other elements.
 */
export function TestElementInfo({ element, elements, typeLabel }: TestElementInfoProps) {
    const { t } = useTranslation('playground');

    const elementsById = useMemo(
        () => new Map(elements.map((candidate) => [candidate.id, candidate])),
        [elements],
    );

    const trees = element.skillTrees
        .map((treeId) => elementsById.get(treeId))
        .filter((tree): tree is ElementData => tree !== undefined);

    return (
        <div className="flex flex-col gap-4">
            <header className="flex items-center gap-3">
                <ElementIcon id={element.id} className="h-14 w-14" />
                <div className="flex flex-col gap-1">
                    <h2 className="text-2xl uppercase tracking-[0.15em] text-white">{element.name}</h2>
                    <span
                        className={`w-fit border-game px-2 py-0.5 text-xs uppercase tracking-[0.15em] ${TYPE_BADGES[element.type] ?? 'border-white/30 text-white/60'}`}
                    >
                        {typeLabel}
                    </span>
                </div>
            </header>

            <section className="flex flex-col gap-1">
                <h3 className="text-sm uppercase tracking-[0.15em] text-white/50">
                    {t('playground.elements.info.description')}
                </h3>
                <p className="text-base text-white/80">{element.description}</p>
            </section>

            <section className="flex flex-col gap-1">
                <h3 className="text-sm uppercase tracking-[0.15em] text-white/50">
                    {t('playground.elements.info.skillTrees')}
                </h3>
                {trees.length === 0 ? (
                    <p className="text-base text-white/40">{t('playground.elements.info.noSkillTrees')}</p>
                ) : (
                    <ul className="flex flex-wrap gap-2">
                        {trees.map((tree) => (
                            <li
                                key={tree.id}
                                className="flex items-center gap-2 border-game border-white/10 px-3 py-1.5 text-base text-white/80"
                            >
                                <ElementIcon id={tree.id} className="h-5 w-5" />
                                {tree.name}
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="flex flex-col gap-2">
                <h3 className="text-sm uppercase tracking-[0.15em] text-white/50">
                    {t('playground.elements.info.relations')}
                </h3>
                {RELATIONS.every((relation) => (element.relations[relation.key] ?? []).length === 0) ? (
                    <p className="text-base text-white/40">{t('playground.elements.info.noRelations')}</p>
                ) : (
                    RELATIONS.map((relation) => {
                        const targets = element.relations[relation.key] ?? [];
                        if (targets.length === 0) return null;

                        return (
                            <div key={relation.key} className="flex flex-col gap-1">
                                <span className="text-sm uppercase tracking-[0.15em] text-white/50">
                                    {t(`playground.elements.info.${relation.labelKey}`)}
                                </span>
                                <ul className="flex flex-wrap gap-2">
                                    {targets.map((targetId) => {
                                        const target = elementsById.get(targetId);

                                        return (
                                            <li
                                                key={targetId}
                                                className="flex items-center gap-2 border-game border-white/10 px-3 py-1.5 text-base text-white/80"
                                            >
                                                <ElementIcon id={targetId} className="h-5 w-5" />
                                                {target?.name ?? targetId}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        );
                    })
                )}
            </section>
        </div>
    );
}
