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
}
