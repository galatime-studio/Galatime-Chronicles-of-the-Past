import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CommonButton from '../../../components/common/CommonButton';
import { CombatEncounter } from '../../../components/game/combat/CombatEncounter';
import { useGame } from '../../../context/GameContext';
import { AI_DIFFICULTY_LEVELS } from '../../../constants/AiConstants';
import type { Difficulty } from '../../../constants/DifficultyConstants';
import type {
    CombatEncounter as CombatEncounterData,
    CombatEvent,
    CombatState,
    CombatUnit,
} from '../../../types/CombatType';
import { TestCombatLog } from './components/TestCombatLog';
import { getWorldHour, setWorldHour } from '../../../services/state/worldClock';
import {
    buildEncounter,
    catalogueKey,
    clearSlot,
    createEmptySetup,
    fillSlot,
    loadEntityCatalogue,
    resolveUnitSprite,
    setSlotInventory,
    setSlotWeapons,
    toggleControlled,
    type CatalogueEntity,
    type CombatSetup,
} from './combatSetupModel';
import { TestCombatSetup } from './TestCombatSetup';

/**
 * Combat tab of the Test Playground.
 *
 * Two steps, because a fight cannot be shown before it is composed: the setup screen,
 * where both rosters are filled and the player marks which characters they play, and
 * then the battle itself — one `CombatEncounter`, which owns the session, the turn
 * queue and the opponent's moves, beside a log of everything the fight resolved.
 */
export function TestCombatPanel() {
    const { t } = useTranslation(['playground', 'game']);
    const { gameState } = useGame();
    const [catalogue, setCatalogue] = useState<CatalogueEntity[] | null>(null);
    const [setup, setSetup] = useState<CombatSetup>(createEmptySetup);
    const [encounter, setEncounter] = useState<CombatEncounterData | null>(null);
    const [logEvents, setLogEvents] = useState<CombatEvent[]>([]);
    const [logUnits, setLogUnits] = useState<CombatUnit[]>([]);
    /**
     * The hour of the day the next fight happens at.
     *
     * The fight takes the world clock's hour, so moving it here moves the
     * world's clock — which is how a solar or lunar skill is tried out.
     */
    const [hour, setHour] = useState(getWorldHour());
    /**
     * How well the opponents play in the next fight.
     *
     * Starts on the game's own setting so the first try matches what the player
     * would meet in the story, then stays local: changing it here changes only
     * the playground's next fight, never the save.
     */
    const [difficulty, setDifficulty] = useState<Difficulty>(() => {
        const saved = gameState.settings.difficulty ?? 'normal';
        // `hardcore` plays exactly like `hard` here — the level only removes the
        // player's retries — so the bench opens on the behaviour it really gets.
        return AI_DIFFICULTY_LEVELS.includes(saved) ? saved : 'hard';
    });

    useEffect(() => {
        let cancelled = false;

        void loadEntityCatalogue().then((entries) => {
            if (!cancelled) setCatalogue(entries);
        });

        return () => {
            cancelled = true;
        };
    }, []);

    /** Catalogue indexed the way a roster slot looks its entity up. */
    const entities = useMemo(
        () => new Map((catalogue ?? []).map((entry) => [catalogueKey(entry.entityType, entry.entityId), entry])),
        [catalogue],
    );

    /**
     * Adds to the combat log: the events of one resolved step, plus the roster
     * that turns their unit ids back into names.
     */
    const handleEvents = useCallback((events: readonly CombatEvent[], next: CombatState) => {
        setLogEvents((current) => [...current, ...events]);
        setLogUnits(next.units);
    }, []);

    const handleStart = () => {
        if (!catalogue) return;
        setLogEvents([]);
        setLogUnits([]);
        setEncounter(buildEncounter(setup, t('playground.tabs.combat')));
    };

    if (catalogue === null) {
        return <p className="text-sm text-white/60">{t('playground.combat.loading')}</p>;
    }

    if (encounter) {
        return (
            <div className="flex h-full min-h-0 flex-col gap-2">
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    {/* What the opponents are playing at, so the log is read in
                        the right light: an easy CPU and a hardcore one explain
                        very different decisions. */}
                    <span className="mr-auto text-xs uppercase tracking-[0.15em] text-white/40">
                        {t('playground.combat.difficulty')}
                        {': '}
                        <span className="text-white/70">{t(`game.settings.difficulty.${difficulty}.label`)}</span>
                    </span>
                    <CommonButton
                        variant="ghost"
                        size="sm"
                        onPress={() => {
                            setEncounter(null);
                        }}
                    >
                        {t('playground.combat.reconfigure')}
                    </CommonButton>
                </div>

                <div className="relative min-h-0 flex-1">
                    <CombatEncounter
                        encounter={encounter}
                        resolveSpriteUrl={resolveUnitSprite}
                        onEvents={handleEvents}
                        inventoryPicker
                        startOptions={{ persistInventories: false, difficulty }}
                        className="h-full"
                    />

                    {/* Where the maths is read back: a panel over the battle's right
                        edge, opened and closed from its own header. */}
                    <TestCombatLog
                        events={logEvents}
                        units={logUnits}
                        onClear={() => setLogEvents([])}
                    />
                </div>
            </div>
        );
    }

    return (
        <TestCombatSetup
            setup={setup}
            entities={entities}
            hour={hour}
            onHourChange={(next) => {
                setHour(next);
                setWorldHour(next);
            }}
            difficulty={difficulty}
            onDifficultyChange={(next) => {
                setDifficulty(next);
            }}
            onFill={(side, line, index, entity) => setSetup((current) => fillSlot(current, side, line, index, entity))}
            onClear={(side, line, index) => setSetup((current) => clearSlot(current, side, line, index))}
            onToggleControl={(side, line, index) => setSetup((current) => toggleControlled(current, side, line, index))}
            onSetLoadout={(side, line, index, inventory, weapons) =>
                setSetup((current) => setSlotWeapons(
                    setSlotInventory(current, side, line, index, inventory),
                    side,
                    line,
                    index,
                    weapons,
                ))
            }
            onStart={handleStart}
        />
    );
}

export default TestCombatPanel;

