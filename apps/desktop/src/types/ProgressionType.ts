/**
 * Persistent player progression.
 *
 * Experience is a bar, not a wallet: every time it fills, it resets into the
 * next skill point and the bar's limit grows. Skill points are the spendable
 * currency, kept apart from the learning XP authored on skill nodes.
 */
export interface PlayerProgression {
    /** Experience banked toward the next skill point. */
    xp: number;
    /** Experience the next skill point needs. */
    xpToNext: number;
    /** Unspent skill points. */
    skillPoints: number;
    /** Permanent stat increases bought with skill points, keyed by combat stat. */
    statBonuses: PlayerStatBonuses;
}

/** The base combat stats a skill point can raise. */
export type PlayerStatKey =
    | 'maxHp'
    | 'maxMana'
    | 'maxStamina'
    | 'physicalAttack'
    | 'magicalAttack'
    | 'physicalDefense'
    | 'magicalDefense'
    | 'speed';

/**
 * How much each stat was raised through progression.
 *
 * Only raised stats are stored, so a clean chronicle writes `{}` instead of a
 * row of zeroes, and a missing key reads as no bonus.
 */
export type PlayerStatBonuses = Partial<Record<PlayerStatKey, number>>;
