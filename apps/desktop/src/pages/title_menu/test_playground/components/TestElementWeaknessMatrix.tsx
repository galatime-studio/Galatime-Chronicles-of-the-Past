import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ElementIcon } from '../../../../assets/GalatimeIcon';
import CommonTooltip from '../../../../components/common/CommonTooltip';
import type { ElementData } from '../../../../types/ElementDataType';
import { combineDefenseScores, scoreToMultiplier, scoreToType } from '../../../../utils/elementUtils';

interface TestElementWeaknessMatrixProps {
    /** The element the panel has selected; the matrix is built around it. */
    element: ElementData;
    /** Every element of the catalogue: the attackers and the partners. */
    elements: readonly ElementData[];
}

/** One column of the matrix: the selected element alone, or combined with a partner. */
interface MatrixColumn {
    key: string;
    /** The element added to the selected one; `null` for the "alone" column. */
    partner: ElementData | null;
}

/** The efficacy of one combination against one attacker. */
interface MatrixCell {
    /** Summed defensive score of the combination. */
    score: number;
    /** Damage multiplier the attacker gets against the combination. */
    multiplier: number;
    /** Efficacy band the summed score falls into. */
    band: string;
}

/**
 * Chip colour of an efficacy band.
 *
 * The palette is the one the element tooltip and the combat board already use: green means the
 * defender shrugs the attack off, red means it lands harder, black is the neutral rung.
 */
function bandChip(band: string): string {
    switch (band) {
        case 'immune':
            return 'bg-galatime-element-immune text-white';
        case 'super_strong':
            return 'bg-galatime-element-superStrong text-white';
        case 'strong':
            return 'bg-galatime-element-strong text-galatime-dark';
        case 'weak':
            return 'bg-galatime-element-weak text-white';
        case 'super_weak':
            return 'bg-galatime-element-superWeak text-white';
        default:
            return 'bg-black/80 text-white/70';
    }
}

/** `1`, `1.3`, `0.65` … trimmed to at most two decimals. */
function formatMultiplier(multiplier: number): string {
    return String(Math.round(multiplier * 100) / 100);
}

/**
 * The weakness table of the selected element.
 *
 * Rows are the attackers; columns are the defender side: the selected element alone, then the
 * selected element combined with every other element. A cell is the damage multiplier the
 * attacker gets against that combination, which is the rule combat uses — the defending elements
 * add their scores together before the total is mapped to a multiplier.
 */
export function TestElementWeaknessMatrix({ element, elements }: TestElementWeaknessMatrixProps) {
    const { t } = useTranslation('playground');

    const columns = useMemo<MatrixColumn[]>(() => [
        { key: element.id, partner: null },
        ...elements
            .filter((candidate) => candidate.id !== element.id)
            .map((partner) => ({ key: `${element.id}+${partner.id}`, partner })),
    ], [elements, element]);

    const cells = useMemo(() => elements.map((attacker) => columns.map((column) => {
        const defenders = column.partner ? [element, column.partner] : [element];
        const score = combineDefenseScores(defenders, attacker.id);
        return { score, multiplier: scoreToMultiplier(score), band: scoreToType(score) };
    })), [elements, columns, element]);

    const selectedLabel = t('playground.elements.weaknesses.columnAlone', { element: element.name });
    const columnLabel = (column: MatrixColumn) => column.partner
        ? t('playground.elements.weaknesses.columnCombined', { element: element.name, partner: column.partner.name })
        : selectedLabel;

    return (
        <div className="flex flex-col gap-2">
            <p className="shrink-0 text-sm text-white/40">
                {t('playground.elements.weaknesses.hint')}
            </p>

            <div className="max-h-[26rem] overflow-auto border-game border-white/10">
                <table className="w-max border-separate border-spacing-0 text-sm">
                    <thead>
                        <tr>
                            <th
                                scope="col"
                                className="sticky left-0 top-0 z-20 border-b border-r border-white/10 bg-galatime-background px-3 py-2 text-left text-xs uppercase tracking-[0.15em] text-white/50"
                            >
                                {t('playground.elements.weaknesses.attacker')}
                            </th>
                            {columns.map((column, columnIndex) => (
                                <th
                                    key={column.key}
                                    scope="col"
                                    className="sticky top-0 z-10 border-b border-r border-white/10 bg-galatime-background px-2 py-2 text-center font-normal"
                                >
                                    <CommonTooltip content={columnLabel(column)}>
                                        <span className="flex items-center justify-center gap-1">
                                            {columnIndex > 0 && (
                                                <span className="text-xs text-white/30">+</span>
                                            )}
                                            <ElementIcon
                                                id={column.partner ? column.partner.id : element.id}
                                                className="h-6 w-6"
                                            />
                                        </span>
                                    </CommonTooltip>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {elements.map((attacker, rowIndex) => (
                            <tr key={attacker.id}>
                                <th
                                    scope="row"
                                    className="sticky left-0 z-10 border-b border-r border-white/10 bg-galatime-background px-3 py-1 text-left font-normal text-white/70"
                                >
                                    <span className="flex items-center gap-2 whitespace-nowrap">
                                        <ElementIcon id={attacker.id} className="h-5 w-5" />
                                        {attacker.name}
                                    </span>
                                </th>
                                {columns.map((column, columnIndex) => {
                                    const cell: MatrixCell = cells[rowIndex][columnIndex];
                                    const defenders = column.partner
                                        ? `${element.name} + ${column.partner.name}`
                                        : element.name;

                                    return (
                                        <td
                                            key={column.key}
                                            className="border-b border-r border-white/5 p-0 text-center"
                                            title={t('playground.elements.weaknesses.cell', {
                                                defender: defenders,
                                                attacker: attacker.name,
                                                band: t(`playground.elements.weaknesses.bands.${cell.band}`),
                                                score: cell.score > 0 ? `+${cell.score}` : cell.score,
                                                value: formatMultiplier(cell.multiplier),
                                            })}
                                        >
                                            <span
                                                className={`inline-flex min-w-[3.25rem] justify-center px-2 py-1 ${bandChip(cell.band)}`}
                                            >
                                                ×{formatMultiplier(cell.multiplier)}
                                            </span>
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
