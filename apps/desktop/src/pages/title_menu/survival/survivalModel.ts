/**
 * Survival Mode rules.
 *
 * The screen owns the presentation and the combat engine owns the fight; this
 * module is the small, testable seam between them: what a wave contains, what
 * carries over after a victory, what a camp heal costs, and what a defeat does
 * to the run.
 */

import {
    SURVIVAL_CHARACTER_ID,
    SURVIVAL_HEAL_COST,
    SURVIVAL_HEAL_FRACTION,
    SURVIVAL_ROUND_SCALING,
    SURVIVAL_SLIME_IDS,
} from '../../../constants/SurvivalConstants';
import type { MobData } from '../../../types/EntityDataType';
import type { SurvivalRun } from '../../../types/SurvivalType';
import type {
    CombatEncounter,
    CombatEncounterMember,
    CombatEvent,
    CombatState,
    CombatStats,
} from '../../../types/CombatType';

/** One randomly composed wave. */
export interface SurvivalWaveOptions {
    round: number;
    run: SurvivalRun;
    /** The whole mob catalogue; only the slime family is used. */
    mobs: readonly MobData[];
    /** The encounter name shown in the arena. */
    name: string;
    /** Injectable randomness, so tests can pin a composition. */
    random?: () => number;
}

/** Health shown in the camp; `0` means the run has not recorded it yet. */
export function survivalMaxHp(run: SurvivalRun, fallback: number): number {
    return run.maxHp > 0 ? run.maxHp : fallback;
}

/** Health the next wave starts with. `null` means untouched full health. */
export function survivalCurrentHp(run: SurvivalRun, maxHp: number): number {
    return run.hp === null ? maxHp : Math.max(0, Math.min(maxHp, Math.round(run.hp)));
}

/** Whether the camp heal is useful and affordable. */
export function canHealSurvivalRun(run: SurvivalRun, maxHp: number): boolean {
    return run.coins >= SURVIVAL_HEAL_COST && survivalCurrentHp(run, maxHp) < maxHp;
}

/** Spends coins for a fixed percentage of health. */
export function healSurvivalRun(run: SurvivalRun, maxHp: number): SurvivalRun {
    if (!canHealSurvivalRun(run, maxHp)) return run;

    const healed = survivalCurrentHp(run, maxHp) + Math.round(maxHp * SURVIVAL_HEAL_FRACTION);
    return {
        ...run,
        hp: Math.min(maxHp, healed),
        coins: run.coins - SURVIVAL_HEAL_COST,
    };
}

/** Gold coins found in the fight's final log. */
export function countGoldCoins(state: CombatState): number {
    return state.log.reduce((total, event: CombatEvent) => (
        event.type === 'loot_gained' && event.itemId === 'gold_coin'
            ? total + event.quantity
            : total
    ), 0);
}

/** How many enemies stand on the battlefield this round. */
function fieldEnemyCount(round: number): number {
    return Math.min(6, 2 + Math.ceil((round - 1) / 2));
}

/** How many off-field waves this round hides behind the battlefield. */
function holdLaneCount(round: number): number {
    return round < 3 ? 0 : Math.min(3, 1 + Math.floor((round - 3) / 3));
}

/** How many slimes wait in each off-field wave. */
function holdLaneSize(round: number): number {
    return Math.min(3, 1 + Math.floor((round - 3) / 4));
}

/** The stat block a slime fights with at this round's scale. */
function scaledSlimeStats(mob: MobData, scale: number): Partial<CombatStats> {
    const base = mob.base_stats;
    const scaled = (value: number) => Math.max(0, Math.round(value * scale));

    return {
        maxHp: Math.max(1, scaled(base.hp)),
        maxMana: Math.max(0, Math.round(base.mana)),
        maxStamina: Math.max(0, Math.round(base.stamina)),
        physicalAttack: scaled(base.physical_attack),
        magicalAttack: scaled(base.magical_attack),
        // Defences grow too, but never below the authored floor.
        physicalDefense: Math.max(1, scaled(base.physical_defense)),
        magicalDefense: Math.max(1, scaled(base.magical_defense)),
        speed: Math.max(1, scaled(base.speed)),
    };
}

/** The slime kinds available on a round, weighted towards bigger bodies later. */
function slimeForRound(round: number, mobs: readonly MobData[], random: () => number): MobData | null {
    const available = SURVIVAL_SLIME_IDS
        .map((id) => mobs.find((mob) => mob.id === id))
        .filter((mob): mob is MobData => mob !== undefined);

    if (available.length === 0) return null;

    const bigChance = round < 3 ? 0 : Math.min(0.35, (round - 2) * 0.05);
    const slimeChance = round < 3 ? 0.6 : 0.45;
    const roll = random();

    if (roll < bigChance) {
        return available.find((mob) => mob.id === 'big_slime')
            ?? available[available.length - 1];
    }
    if (roll < bigChance + slimeChance) {
        return available.find((mob) => mob.id === 'slime')
            ?? available[available.length - 1];
    }
    return available.find((mob) => mob.id === 'small_slime') ?? available[0];
}

function memberOf(mob: MobData, line: 'front' | 'rear', scale: number, hold?: number): CombatEncounterMember {
    return {
        entityId: mob.id,
        entityType: 'mob',
        line,
        ...(hold === undefined ? {} : { hold }),
        stats: scaledSlimeStats(mob, scale),
    };
}

/**
 * Builds the encounter for one round.
 *
 * Arthur stands alone, controlled by the player, with the health the run
 * carried over. The enemies are random slimes: a growing field group plus, from
 * the third round on, off-field waves that deploy as the rear line empties.
 */
export function createSurvivalEncounter({
    round,
    run,
    mobs,
    name,
    random = Math.random,
}: SurvivalWaveOptions): CombatEncounter {
    const scale = 1 + Math.max(0, round - 1) * SURVIVAL_ROUND_SCALING;
    const fieldCount = fieldEnemyCount(Math.max(1, round));
    const frontCount = Math.ceil(fieldCount / 2);

    const enemies: CombatEncounterMember[] = [];
    for (let index = 0; index < fieldCount; index += 1) {
        const slime = slimeForRound(round, mobs, random);
        if (!slime) break;
        enemies.push(memberOf(slime, index < frontCount ? 'front' : 'rear', scale));
    }

    const lanes = holdLaneCount(Math.max(1, round));
    const laneSize = holdLaneSize(Math.max(1, round));
    for (let lane = 1; lane <= lanes; lane += 1) {
        for (let index = 0; index < laneSize; index += 1) {
            const slime = slimeForRound(round, mobs, random);
            if (!slime) break;
            enemies.push(memberOf(slime, 'rear', scale, lane));
        }
    }

    return {
        id: `survival_round_${round}`,
        name,
        allies: [{
            entityId: SURVIVAL_CHARACTER_ID,
            entityType: 'character',
            line: 'front',
            isPlayerControlled: true,
            ...(run.hp === null ? {} : { currentHp: run.hp }),
        }],
        enemies,
    };
}

/** The run after clearing one wave: health and coins carry, everything else resets. */
export function resolveSurvivalVictory(run: SurvivalRun, state: CombatState, round: number): SurvivalRun {
    const arthur = state.units.find((unit) => (
        unit.side === 'allies' && unit.entityId === SURVIVAL_CHARACTER_ID
    ));

    return {
        ...run,
        round: round + 1,
        hp: arthur ? Math.max(1, Math.round(arthur.currentHp)) : run.hp,
        maxHp: arthur ? Math.max(1, Math.round(arthur.stats.maxHp)) : run.maxHp,
        coins: run.coins + countGoldCoins(state),
        bestRound: Math.max(run.bestRound, round),
        active: true,
    };
}

/** The run after a defeat: the best round is kept and the next run starts fresh. */
export function resolveSurvivalDefeat(run: SurvivalRun, round: number): SurvivalRun {
    return {
        ...run,
        round: 1,
        hp: null,
        coins: 0,
        bestRound: Math.max(run.bestRound, round),
        active: false,
    };
}
