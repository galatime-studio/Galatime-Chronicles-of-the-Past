import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import CommonButton from '../../../components/common/CommonButton';
import CommonSlider from '../../../components/common/CommonSlider';
import { AI_DIFFICULTY_LEVELS } from '../../../constants/AiConstants';
import type { Difficulty } from '../../../constants/DifficultyConstants';
import {
    SETUP_LINES,
    SETUP_SIDES,
    SLOTS_PER_LINE,
    catalogueKey,
    countSide,
    defaultWeaponIds,
    isSetupValid,
    slotAt,
    type CatalogueEntity,
    type CombatSetup,
} from './combatSetupModel';
import type { CombatLine, CombatSide } from '../../../types/CombatType';
import type { EntityInventoryState } from '../../../types/InventoryType';
import { TestCombatPickerPopup } from './components/TestCombatPickerPopup';
import { TestCombatSlot } from './components/TestCombatSlot';
import { TestSlotInventoryPopup } from './components/TestSlotInventoryPopup';

/** Roster position the entity picker is currently filling. */
interface PickerTarget {
    side: CombatSide;
    line: CombatLine;
    index: number;
}

interface TestCombatSetupProps {
    setup: CombatSetup;
    /** Catalogue indexed by {@link catalogueKey}, so a filled slot can show its sprite. */
    entities: ReadonlyMap<string, CatalogueEntity>;
    /** The hour of the day the fight will happen at. */
    hour: number;
    /** Moves the world's clock, and with it the hour of the next fight. */
    onHourChange: (hour: number) => void;
    /** How well the opponents will play. Sent to the fight, not saved anywhere. */
    difficulty: Difficulty;
    onDifficultyChange: (difficulty: Difficulty) => void;
    onFill: (side: CombatSide, line: CombatLine, index: number, entity: CatalogueEntity) => void;
    onClear: (side: CombatSide, line: CombatLine, index: number) => void;
    onToggleControl: (side: CombatSide, line: CombatLine, index: number) => void;
    onSetLoadout: (
        side: CombatSide,
        line: CombatLine,
        index: number,
        inventory: EntityInventoryState,
        weapons: string[],
    ) => void;
    onStart: () => void;
}

/**
 * Roster setup of the combat tab.
 *
 * Both sides get one row per battle line, each row a fixed number of positions that
 * mirror what the formation board can draw. Which position holds which character is
 * the player's call, and so is which of them they play: the control mark is the only
 * thing that decides whose actions the battle's HUD shows. Each filled slot also
 * carries an inventory the player stocks item by item — the only stock the fight
 * will know, because playground entities exist for one battle.
 */
export function TestCombatSetup({
    setup,
    entities,
    hour,
    onHourChange,
    difficulty,
    onDifficultyChange,
    onFill,
    onClear,
    onToggleControl,
    onSetLoadout,
    onStart,
}: TestCombatSetupProps) {
    const { t } = useTranslation(['playground', 'game']);
    const [target, setTarget] = useState<PickerTarget | null>(null);
    const [inventoryTarget, setInventoryTarget] = useState<PickerTarget | null>(null);

    const valid = isSetupValid(setup);
    const inventorySlot = inventoryTarget ? slotAt(setup, inventoryTarget.side, inventoryTarget.line, inventoryTarget.index) : null;
    const inventoryEntity = inventorySlot
        ? entities.get(catalogueKey(inventorySlot.entityType, inventorySlot.entityId))
        : undefined;

    return (
        <div className="flex h-full min-h-0 flex-col gap-4">
            <div className="min-h-0 flex-1 overflow-y-auto pb-1">
                <div className="grid gap-4 md:grid-cols-2">
                    {SETUP_SIDES.map((side) => (
                        <section
                            key={side}
                            aria-label={t(`playground.combat.${side}`)}
                            className="flex flex-col gap-3 border-game border-white/10 bg-white/5 p-3"
                        >
                            <div className="flex items-baseline justify-between gap-2">
                                <h3 className="text-sm uppercase tracking-[0.15em] text-white/80">
                                    {t(`playground.combat.${side}`)}
                                </h3>
                                <span className="font-pixel text-xl text-white/75">
                                    {countSide(setup, side)}
                                </span>
                            </div>

                            {SETUP_LINES.map((line) => {
                                if (line === 'rear' && !setup[side].front.some((slot) => slot !== null)) {
                                    return null;
                                }

                                const filledCount = setup[side][line].filter((slot) => slot !== null).length;
                                const showAddButton = filledCount < SLOTS_PER_LINE;
                                /** First open position, so the lone "add" slot always lands in a gap. */
                                const nextIndex = setup[side][line].findIndex((slot) => slot === null);

                                return (
                                    <div key={line}>
                                        <p className="mb-1 text-[0.65rem] uppercase tracking-[0.15em] text-white/40">
                                            {t(`playground.combat.${line}`)}
                                        </p>

                                        <div className="flex gap-2 overflow-x-auto pt-2 pr-2 pb-2">
                                            {setup[side][line].map((slot, index) => {
                                                if (!slot) return null;

                                                const entity = entities.get(catalogueKey(slot.entityType, slot.entityId));
                                                const label = `${t(`playground.combat.${side}`)} ${t(`playground.combat.${line}`)} ${index + 1}`;

                                                return (
                                                    <TestCombatSlot
                                                        key={index}
                                                        slot={slot}
                                                        entity={entity}
                                                        label={label}
                                                        onAdd={() => setTarget({ side, line, index })}
                                                        onRemove={() => onClear(side, line, index)}
                                                        onToggleControl={() => onToggleControl(side, line, index)}
                                                        onOpenInventory={() => setInventoryTarget({ side, line, index })}
                                                    />
                                                );
                                            })}

                                            {showAddButton && nextIndex >= 0 && (
                                                <TestCombatSlot
                                                    slot={null}
                                                    label={`${t(`playground.combat.${side}`)} ${t(`playground.combat.${line}`)} ${nextIndex + 1}`}
                                                    onAdd={() => setTarget({ side, line, index: nextIndex })}
                                                    onRemove={() => {}}
                                                    onToggleControl={() => {}}
                                                    onOpenInventory={() => {}}
                                                />
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </section>
                    ))}
                </div>
            </div>

            <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t-game border-white/10 pt-3">
                <div className="flex flex-wrap items-center gap-4">
                    {/* The hour of the day: a solar skill bites harder by day and a
                        lunar one at night, so the fight is worth setting up in
                        the light the author had in mind. */}
                    <div className="flex flex-wrap items-center gap-3">
                        <CommonSlider
                            title={t('playground.combat.hour')}
                            titleClassName="text-xs uppercase tracking-[0.15em] text-white/50"
                            variant="uniform"
                            min={0}
                            max={23}
                            step={1}
                            numBars={12}
                            barWidth={4}
                            barGap={5}
                            maxBarHeight={14}
                            snapToGrid={false}
                            value={hour}
                            onChange={onHourChange}
                            formatValue={(next) => `${String(next).padStart(2, '0')}:00`}
                            className="max-w-80 gap-2"
                        />
                        <span className="text-xs uppercase tracking-[0.15em] text-white/40">
                            {hour >= 6 && hour < 18 ? t('playground.combat.day') : t('playground.combat.night')}
                        </span>
                    </div>

                    {/* How well the opponents play. The level is handed to the fight
                        and never written to the save, so the same roster can be tried
                        at every level without touching the game's own setting. */}
                    <div
                        role="group"
                        aria-label={t('playground.combat.difficulty')}
                        className="flex items-center gap-2"
                    >
                        <span className="text-xs uppercase tracking-[0.15em] text-white/50">
                            {t('playground.combat.difficulty')}
                        </span>
                        <div className="flex gap-1">
                            {AI_DIFFICULTY_LEVELS.map((level) => (
                                <CommonButton
                                    key={level}
                                    variant={level === difficulty ? 'primary' : 'ghost'}
                                    size="sm"
                                    aria-pressed={level === difficulty}
                                    onPress={() => onDifficultyChange(level)}
                                >
                                    {t(`game.settings.difficulty.${level}.label`)}
                                </CommonButton>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Only a blocked start needs saying; a ready setup speaks for itself. */}
                <p aria-live="polite" className="text-sm text-galatime-warning">
                    {valid ? '' : t('playground.combat.needsBothSides')}
                </p>

                <CommonButton
                    variant="primary"
                    size="md"
                    disabled={!valid}
                    onPress={() => {
                        onStart();
                    }}
                >
                    {t('playground.combat.start')}
                </CommonButton>
            </footer>

            <TestCombatPickerPopup
                open={target !== null}
                catalogue={[...entities.values()]}
                onDismiss={() => setTarget(null)}
                onPick={(entity) => {
                    if (target) onFill(target.side, target.line, target.index, entity);
                    setTarget(null);
                }}
            />

            <TestSlotInventoryPopup
                open={inventoryTarget !== null && inventorySlot !== null}
                entityName={inventoryEntity?.name ?? inventorySlot?.entityId ?? ''}
                inventory={inventorySlot?.inventory ?? {}}
                weapons={inventorySlot ? (inventorySlot.weapons ?? (inventoryEntity ? defaultWeaponIds(inventoryEntity) : [])) : []}
                onDismiss={() => setInventoryTarget(null)}
                onConfirm={(inventory, weapons) => {
                    if (inventoryTarget) {
                        onSetLoadout(inventoryTarget.side, inventoryTarget.line, inventoryTarget.index, inventory, weapons);
                    }
                    setInventoryTarget(null);
                }}
            />
        </div>
    );
}

export default TestCombatSetup;
