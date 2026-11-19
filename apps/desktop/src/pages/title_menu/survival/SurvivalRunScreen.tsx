import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { CombatEncounter } from '@/components/game/combat/CombatEncounter';
import { PAGE_FADE_TRANSITION } from '@/constants/AnimationConstants';
import { SURVIVAL_SLIME_IDS } from '@/constants/SurvivalConstants';
import { fetchAllMobs, fetchCharacter } from '@/controllers/entityController';
import { resolveUnitSprite } from '@/services/combatSpriteService';
import type { SaveData } from '@/services/saveService';
import type { MobData } from '@/types/EntityDataType';
import type {
    CombatEncounter as CombatEncounterData,
    CombatOutcome,
    CombatState,
} from '@/types/CombatType';
import type { SurvivalRun } from '@/types/SurvivalType';
import { SurvivalDefeat, type SurvivalDefeatSummary } from './SurvivalDefeat';
import { SurvivalMarket } from './SurvivalMarket';
import {
    canHealSurvivalRun,
    countGoldCoins,
    createSurvivalEncounter,
    healSurvivalRun,
    resolveSurvivalDefeat,
    resolveSurvivalVictory,
    survivalCurrentHp,
    survivalMaxHp,
} from './survivalModel';

interface SurvivalRunScreenProps {
    save: SaveData;
    onSave: (data: SaveData) => Promise<void>;
    onExit: () => void;
}

type SurvivalPhase = 'market' | 'combat' | 'defeat';

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
export function SurvivalRunScreen({ save, onSave, onExit }: SurvivalRunScreenProps) {
    const { t } = useTranslation(['survival', 'common']);
    const [record, setRecord] = useState(save);
    const [phase, setPhase] = useState<SurvivalPhase>('market');
    const [encounter, setEncounter] = useState<CombatEncounterData | null>(null);
    const [summary, setSummary] = useState<SurvivalDefeatSummary | null>(null);
    const [clearedRound, setClearedRound] = useState<number | null>(null);
    const [slimes, setSlimes] = useState<MobData[] | null>(null);
    const [arthurMaxHp, setArthurMaxHp] = useState<number | null>(null);
    // The first-round launch must happen once, even across the state updates it causes.
    const autoStarted = useRef(false);

    const run = record.survival;

    useEffect(() => {
        let active = true;

        void Promise.all([fetchAllMobs(), fetchCharacter('arthur')]).then(([mobs, arthur]) => {
            if (!active) return;
            setSlimes(mobs.filter((mob) => (SURVIVAL_SLIME_IDS as readonly string[]).includes(mob.id)));
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
    const ready = arthurMaxHp !== null && slimes !== null && slimes.length > 0;

    const startRound = useCallback(() => {
        if (!ready || !slimes) return;

        const nextRun: SurvivalRun = {
            ...run,
            maxHp: run.maxHp > 0 ? run.maxHp : maxHp,
            active: true,
        };
        const nextRecord: SaveData = { ...record, survival: nextRun };

        setClearedRound(null);
        setSummary(null);
        setEncounter(createSurvivalEncounter({
            round: nextRun.round,
            run: nextRun,
            mobs: slimes,
            name: t('survival.round', { round: nextRun.round }),
        }));
        setPhase('combat');
        void persist(nextRecord);
    }, [ready, slimes, run, maxHp, record, t, persist]);

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
        setEncounter(null);

        if (outcome === 'victory') {
            const nextRun = resolveSurvivalVictory(run, state, run.round);
            setClearedRound(run.round);
            setPhase('market');
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
                    onFinish={finishRound}
                    className="h-full"
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
                onHeal={heal}
                onStart={startRound}
            />
        </motion.div>
    );
}
