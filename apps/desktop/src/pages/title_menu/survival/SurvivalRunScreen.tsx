import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { CombatEncounter } from '@/components/game/combat/CombatEncounter';
import { PAGE_FADE_TRANSITION } from '@/constants/AnimationConstants';
import { SURVIVAL_CHARACTER_ID } from '@/constants/SurvivalConstants';
import { fetchCombatInventory } from '@/controllers/combatController';
import { fetchAllMobs, fetchCharacter } from '@/controllers/entityController';
import { resolveUnitSprite } from '@/services/combatSpriteService';
import { getEntityImages } from '@/services/entityImageService';
import { getItemDefinition, loadItemCatalogue } from '@/services/inventory/itemService';
import type { SaveData } from '@/services/saveService';
import type { MobData } from '@/types/EntityDataType';
import type {
    CombatEncounter as CombatEncounterData,
    CombatOutcome,
    CombatState,
} from '@/types/CombatType';
import type { SurvivalRun } from '@/types/SurvivalType';
import { useControlListener } from '@/context/GameContext';
import { SettingsScreen } from '../SettingsScreen';
import { SurvivalDefeat, type SurvivalDefeatSummary } from './SurvivalDefeat';
import { SurvivalMarket } from './SurvivalMarket';
import { SurvivalVictory, type SurvivalVictorySummary } from './SurvivalVictory';
import {
    buySurvivalItem,
    canHealSurvivalRun,
    countGoldCoins,
    createSurvivalEncounter,
    healSurvivalRun,
    resolveSurvivalDefeat,
    resolveSurvivalVictory,
    survivalCurrentHp,
    survivalMaxHp,
    survivalRoundCoinReward,
    survivalShopStock,
} from './survivalModel';

interface SurvivalRunScreenProps {
    save: SaveData;
    onSave: (data: SaveData) => Promise<void>;
    onExit: () => void;
    /** Leaves the run for the title menu, used by the in-run Settings screen. */
    onQuit: () => void;
}

type SurvivalPhase = 'market' | 'combat' | 'victory' | 'defeat';

/**
 * Survival Mode: fight a wave, return to the marketplace, fight the next one.
 *
 * The screen owns only navigation and persistence. The wave composition lives
 * in `survivalModel`, the fight itself in `CombatEncounter`; the save is written
 * after every decision that changes the run (heal, start, victory, defeat).
 *
 * The first round has no marketplace: opening a fresh run drops the player
 * straight into the fight, and the market appears only after a wave has been
 * cleared.
 */
export function SurvivalRunScreen({ save, onSave, onExit, onQuit }: SurvivalRunScreenProps) {
    const { t } = useTranslation(['survival', 'common']);
    const [record, setRecord] = useState(save);
    const [phase, setPhase] = useState<SurvivalPhase>('market');
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [encounter, setEncounter] = useState<CombatEncounterData | null>(null);
    const [summary, setSummary] = useState<SurvivalDefeatSummary | null>(null);
    const [victory, setVictory] = useState<SurvivalVictorySummary | null>(null);
    const [clearedRound, setClearedRound] = useState<number | null>(null);
    const [waveMobs, setWaveMobs] = useState<MobData[] | null>(null);
    const [arthurMaxHp, setArthurMaxHp] = useState<number | null>(null);
    // The first-round launch must happen once, even across the state updates it causes.
    const autoStarted = useRef(false);
    /** Enemies authored into the current wave, fixed before any split can add units. */
    const waveEnemiesPlaced = useRef(0);

    const run = record.survival;

    useEffect(() => {
        let active = true;

        void Promise.all([fetchAllMobs(), fetchCharacter('arthur')]).then(([mobs, arthur]) => {
            if (!active) return;
            // Waves draw from the mob folder; only mobs that actually ship
            // sprites in `public/images/entities/mobs` can stand in the arena.
            setWaveMobs(mobs.filter((mob) => (
                getEntityImages({ type: 'mob', id: mob.id, name: mob.name }).length > 0
            )));
            setArthurMaxHp(arthur ? arthur.base_stats.hp : 0);
        });

        return () => { active = false; };
    }, []);

    const persist = useCallback(async (next: SaveData) => {
        setRecord(next);
        await onSave(next);
    }, [onSave]);

    const maxHp = survivalMaxHp(run, arthurMaxHp ?? 1);
    const currentHp = survivalCurrentHp(run, maxHp);
    const ready = arthurMaxHp !== null && waveMobs !== null && waveMobs.length > 0;
    // The shelf is derived from the round alone, so it changes only when the
    // run advances — never between two renders of the same visit.
    const shopStock = useMemo(
        () => survivalShopStock(run.round, [...loadItemCatalogue().values()]),
        [run.round],
    );

    const buyItem = useCallback((itemId: string) => {
        const item = getItemDefinition(itemId);
        if (!item) return;

        const nextRun = buySurvivalItem(run, item);
        if (nextRun === run) return;
        void persist({ ...record, survival: nextRun });
    }, [run, record, persist]);

    const startRound = useCallback(() => {
        if (!ready || !waveMobs) return;

        const nextRun: SurvivalRun = {
            ...run,
            maxHp: run.maxHp > 0 ? run.maxHp : maxHp,
            active: true,
        };
        const nextRecord: SaveData = { ...record, survival: nextRun };

        setClearedRound(null);
        setSummary(null);
        setVictory(null);
        const nextEncounter = createSurvivalEncounter({
            round: nextRun.round,
            run: nextRun,
            mobs: waveMobs,
            name: t('survival.round', { round: nextRun.round }),
        });
        waveEnemiesPlaced.current = nextEncounter.enemies.length;
        setEncounter(nextEncounter);
        setPhase('combat');
        void persist(nextRecord);
    }, [ready, waveMobs, run, maxHp, record, t, persist]);

    // A fresh run opens directly on round 1; later rounds open on the market.
    useEffect(() => {
        if (autoStarted.current || !ready || phase !== 'market' || run.round !== 1) return;
        autoStarted.current = true;
        startRound();
    }, [ready, phase, run.round, startRound]);

    const heal = () => {
        if (!canHealSurvivalRun(run, maxHp)) return;
        void persist({ ...record, survival: healSurvivalRun(run, maxHp) });
    };

    const finishRound = (outcome: CombatOutcome, state: CombatState) => {
        // The authored roster, not `state.units`: a slime that split added units
        // that must not be paid for again.
        const enemiesPlaced = waveEnemiesPlaced.current;
        setEncounter(null);

        if (outcome === 'victory') {
            // The picker spent items straight into the combat session, so the
            // remaining bag has to be read back before the session is closed.
            const arthur = state.units.find((unit) => (
                unit.side === 'allies' && unit.entityId === SURVIVAL_CHARACTER_ID
            ));
            const carried = arthur ? fetchCombatInventory(state.sessionId, arthur.id) : null;
            const inventory = carried?.ok
                ? Object.fromEntries(
                    carried.data
                        .filter((entry) => entry.quantity > 0)
                        .map((entry) => [entry.itemId, entry.quantity]),
                )
                : undefined;

            const nextRun = resolveSurvivalVictory(run, state, run.round, enemiesPlaced, inventory);
            setVictory({
                round: run.round,
                defeated: enemiesPlaced,
                roundReward: survivalRoundCoinReward(enemiesPlaced),
                loot: countGoldCoins(state),
                coins: nextRun.coins,
                nextRound: nextRun.round,
            });
            setClearedRound(run.round);
            setPhase('victory');
            void persist({ ...record, survival: nextRun });
            return;
        }

        const bestRound = Math.max(run.bestRound, run.round);
        setSummary({
            round: run.round,
            bestRound,
            coins: run.coins + countGoldCoins(state),
            retreated: outcome === 'fled',
        });
        setPhase('defeat');
        void persist({ ...record, survival: resolveSurvivalDefeat(run, run.round) });
    };

    /**
     * `deny` (Escape / the east face button) opens Settings over the run — in the
     * marketplace and behind the fight alike.
     *
     * Combat keeps first claim on the key: its own Escape capture still cancels a
     * pending selection or a pinned unit, so Settings is only reached with nothing
     * left to back out of. A popup mutes this the same way it mutes Back.
     */
    useControlListener(
        settingsOpen || (phase !== 'combat' && phase !== 'market')
            ? {}
            : { deny: () => setSettingsOpen(true) },
        { mutedByModal: true },
    );

    const settingsScreen = (
        <SettingsScreen
            onBack={() => setSettingsOpen(false)}
            onExitGame={onQuit}
        />
    );

    if (phase === 'combat' && encounter) {
        return (
            <motion.div
                key="survival-combat"
                className="relative h-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={PAGE_FADE_TRANSITION}
            >
                <CombatEncounter
                    key={encounter.id}
                    encounter={encounter}
                    resolveSpriteUrl={resolveUnitSprite}
                    leftSide="enemies"
                    animationsEnabled={record.combatAnimations}
                    tooltipVisible={record.tooltips.fighting}
                    startOptions={{ difficulty: record.difficulty, persistInventories: false }}
                    inventoryPicker
                    paused={settingsOpen}
                    onFinish={finishRound}
                    className="h-full"
                />
                {/* Settings covers the fight instead of replacing it: unmounting the
                    encounter ends the session, and closing Settings would restart the
                    wave from the beginning. */}
                {settingsOpen && (
                    <div className="absolute inset-0 z-9999 bg-galatime-background">
                        {settingsScreen}
                    </div>
                )}
            </motion.div>
        );
    }

    if (settingsOpen) {
        return settingsScreen;
    }

    if (phase === 'victory' && victory) {
        return (
            <motion.div
                key="survival-victory"
                className="relative h-full overflow-hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={PAGE_FADE_TRANSITION}
            >
                <SurvivalVictory
                    summary={victory}
                    onContinue={() => {
                        setVictory(null);
                        setPhase('market');
                    }}
                />
            </motion.div>
        );
    }

    if (phase === 'defeat' && summary) {
        return (
            <motion.div
                key="survival-defeat"
                className="relative h-full overflow-hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={PAGE_FADE_TRANSITION}
            >
                <SurvivalDefeat summary={summary} onExit={onExit} />
            </motion.div>
        );
    }

    // Round 1 waits for its automatic launch; later rounds wait for Arthur's data.
    if (!ready || run.round === 1) {
        return (
            <motion.div
                key="survival-loading"
                className="flex h-full items-center justify-center bg-galatime-background"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={PAGE_FADE_TRANSITION}
            >
                <p className="text-xs uppercase tracking-[0.3em] text-white/50">
                    {t('survival.loading')}
                </p>
            </motion.div>
        );
    }

    return (
        <motion.div
            key="survival-market"
            className="relative h-full overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={PAGE_FADE_TRANSITION}
        >
            <SurvivalMarket
                run={run}
                currentHp={currentHp}
                maxHp={maxHp}
                ready={ready}
                canHeal={canHealSurvivalRun(run, maxHp)}
                clearedRound={clearedRound}
                stock={shopStock}
                onHeal={heal}
                onBuy={buyItem}
                onStart={startRound}
                onSettings={() => setSettingsOpen(true)}
            />
        </motion.div>
    );
}
