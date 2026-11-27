/**
 * Experience and skill points.
 *
 * A defeated enemy is worth experience proportional to the threat it carried in
 * the fight, using the same reading Survival prices its waves with. Experience
 * fills a bar; when the bar fills it resets, the player earns one skill point,
 * and the bar's limit grows.
 */

import {
    PLAYER_STAT_COST,
    PLAYER_STAT_GAINS,
    PLAYER_STAT_ORDER,
    PLAYER_XP_THREAT_DIVISOR,
    xpThresholdAfter,
} from '../constants/ProgressionConstants';
import type { CombatState, CombatStats } from '../types/CombatType';
import type { PlayerProgression, PlayerStatKey } from '../types/ProgressionType';
import { threatScore } from './combat/threatScore';

/** What one award of experience did to the bar. */
export interface ExperienceGain {
    /** The progression after the award. */
    progression: PlayerProgression;
    /** Experience added before any threshold was consumed. */
    xpGained: number;
    /** Skill points earned by filling the bar, possibly more than one. */
    skillPointsGained: number;
}

/** What one skill point bought. */
export interface StatImprovement {
    /** The progression after the purchase. */
    progression: PlayerProgression;
    /** Whether a skill point was actually spent. */
    improved: boolean;
    /** The stat raised. */
    stat: PlayerStatKey;
    /** How much the stat rose. */
    amount: number;
}

/** How much one skill point raises the given stat. */
export function statGain(stat: PlayerStatKey): number {
    return PLAYER_STAT_GAINS[stat];
}

/** Whether the player has a skill point to spend. */
export function canImproveStat(progression: PlayerProgression): boolean {
    return progression.skillPoints >= PLAYER_STAT_COST;
}

/**
 * Spends one skill point on a permanent stat increase.
 *
 * An unaffordable purchase returns the progression untouched, so callers can
 * persist only when `improved` is true.
 */
export function improveStat(progression: PlayerProgression, stat: PlayerStatKey): StatImprovement {
    const amount = statGain(stat);
    if (!canImproveStat(progression)) {
        return { progression, improved: false, stat, amount };
    }

    return {
        progression: {
            ...progression,
            skillPoints: progression.skillPoints - PLAYER_STAT_COST,
            statBonuses: {
                ...progression.statBonuses,
                [stat]: (progression.statBonuses[stat] ?? 0) + amount,
            },
        },
        improved: true,
        stat,
        amount,
    };
}

/**
 * The bought stat increases as a combat-unit overlay.
 *
 * `PlayerStatKey` uses the same names as the matching `CombatStats` fields, so
 * the overlay is the bonuses themselves; only positive entries are carried.
 */
export function combatStatBonuses(bonuses: PlayerProgression['statBonuses']): Partial<CombatStats> {
    const overlay: Partial<CombatStats> = {};

    for (const stat of PLAYER_STAT_ORDER) {
        const amount = bonuses[stat] ?? 0;
        if (amount > 0) overlay[stat] = amount;
    }

    return overlay;
}

/** Experience a body of the given threat is worth; every body pays at least one. */
export function experienceForThreat(threat: number): number {
    return Math.max(1, Math.round(Math.max(0, threat) / PLAYER_XP_THREAT_DIVISOR));
}

/** Experience a combat stat block is worth. */
export function experienceForStats(stats: CombatStats): number {
    return experienceForThreat(threatScore({
        hp: stats.maxHp,
        physicalAttack: stats.physicalAttack,
        magicalAttack: stats.magicalAttack,
        physicalDefense: stats.physicalDefense,
        magicalDefense: stats.magicalDefense,
    }));
}

/**
 * Experience earned from every enemy left defeated on the field.
 *
 * Unlike the round purse, this counts the bodies actually killed: a slime that
 * split still pays for the slimes born from it, because those are bodies the
 * player had to defeat.
 */
export function defeatedEnemyExperience(state: CombatState): number {
    return state.units.reduce((total, unit) => (
        unit.side === 'enemies' && unit.status === 'defeated'
            ? total + experienceForStats(unit.stats)
            : total
    ), 0);
}

/**
 * Adds experience to the bar, consuming as many thresholds as it fills.
 *
 * The remainder carries, so a large award can earn several skill points at once
 * instead of wasting the overflow.
 */
export function gainExperience(progression: PlayerProgression, amount: number): ExperienceGain {
    const xpGained = Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
    let xp = progression.xp + xpGained;
    let xpToNext = Math.max(1, progression.xpToNext);
    let skillPoints = progression.skillPoints;
    let skillPointsGained = 0;

    while (xp >= xpToNext) {
        xp -= xpToNext;
        skillPoints += 1;
        skillPointsGained += 1;
        xpToNext = xpThresholdAfter(xpToNext);
    }

    return {
        progression: { ...progression, xp, xpToNext, skillPoints },
        xpGained,
        skillPointsGained,
    };
}
