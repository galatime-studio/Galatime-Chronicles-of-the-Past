import type {
    PlayerProgression,
    PlayerStatBonuses,
    PlayerStatKey,
} from '../types/ProgressionType';

/** Experience the first skill point needs. */
export const PLAYER_XP_BASE_THRESHOLD = 100;

/** How much the bar's limit grows after each skill point is earned. */
export const PLAYER_XP_THRESHOLD_GROWTH = 1.25;

/** Threat points that buy one experience point. */
export const PLAYER_XP_THREAT_DIVISOR = 2;

/** How many skill points one stat increase costs. */
export const PLAYER_STAT_COST = 1;

/**
 * The order the character page prints the stats in.
 *
 * Pools first, then the offensive and defensive axes, then speed, so the page
 * reads from what keeps Arthur alive to how fast he acts.
 */
export const PLAYER_STAT_ORDER: readonly PlayerStatKey[] = [
    'maxHp',
    'maxMana',
    'maxStamina',
    'physicalAttack',
    'magicalAttack',
    'physicalDefense',
    'magicalDefense',
    'speed',
];

/**
 * What one skill point buys in each stat.
 *
 * Health is paid in a larger chunk because its pool is an order of magnitude
 * above the rest; raising it by one point would be invisible. The two attacks
 * and defences share a value so neither damage axis is favoured, and speed is
 * the scarcest point of all.
 */
export const PLAYER_STAT_GAINS: Record<PlayerStatKey, number> = {
    maxHp: 25,
    maxMana: 5,
    maxStamina: 5,
    physicalAttack: 2,
    magicalAttack: 2,
    physicalDefense: 2,
    magicalDefense: 2,
    speed: 1,
};

/** A chronicle that has not bought any stat increases yet. */
export function createDefaultStatBonuses(): PlayerStatBonuses {
    return {};
}

/** The bar's limit after one more skill point. */
export function xpThresholdAfter(threshold: number): number {
    return Math.max(1, Math.round(threshold * PLAYER_XP_THRESHOLD_GROWTH));
}

/** A chronicle that has not earned any experience yet. */
export function createDefaultProgression(): PlayerProgression {
    return {
        xp: 0,
        xpToNext: PLAYER_XP_BASE_THRESHOLD,
        skillPoints: 0,
        statBonuses: createDefaultStatBonuses(),
    };
}

function wholeNumber(value: unknown, fallback: number, minimum = 0): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(minimum, Math.round(value))
        : fallback;
}

/** Normalises bought stat increases, dropping unknown stats and non-positive values. */
export function normalizeStatBonuses(raw: unknown): PlayerStatBonuses {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return createDefaultStatBonuses();
    }

    const data = raw as Record<string, unknown>;
    const bonuses: PlayerStatBonuses = {};

    for (const stat of PLAYER_STAT_ORDER) {
        const amount = wholeNumber(data[stat], 0);
        if (amount > 0) bonuses[stat] = amount;
    }

    return bonuses;
}

/** Normalises progression read from a save, so old chronicles still open. */
export function normalizeProgression(raw: unknown): PlayerProgression {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return createDefaultProgression();
    }

    const data = raw as Partial<PlayerProgression>;
    const xpToNext = wholeNumber(data.xpToNext, 0);
    return {
        xp: wholeNumber(data.xp, 0),
        xpToNext: xpToNext > 0 ? xpToNext : PLAYER_XP_BASE_THRESHOLD,
        skillPoints: wholeNumber(data.skillPoints, 0),
        statBonuses: normalizeStatBonuses(data.statBonuses),
    };
}
