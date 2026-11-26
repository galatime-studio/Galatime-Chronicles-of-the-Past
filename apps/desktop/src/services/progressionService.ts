/**
 * Experience and skill points.
 *
 * A defeated enemy is worth experience proportional to the threat it carried in
 * the fight, using the same reading Survival prices its waves with. Experience
 * fills a bar; when the bar fills it resets, the player earns one skill point,
 * and the bar's limit grows.
 */

import {
    PLAYER_XP_THREAT_DIVISOR,
    xpThresholdAfter,
} from '../constants/ProgressionConstants';
import type { CombatState, CombatStats } from '../types/CombatType';
import type { PlayerProgression } from '../types/ProgressionType';
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
        progression: { xp, xpToNext, skillPoints },
        xpGained,
        skillPointsGained,
    };
}
