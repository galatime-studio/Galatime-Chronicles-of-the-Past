import type { PlayerProgression } from '../types/ProgressionType';

/** Experience the first skill point needs. */
export const PLAYER_XP_BASE_THRESHOLD = 100;

/** How much the bar's limit grows after each skill point is earned. */
export const PLAYER_XP_THRESHOLD_GROWTH = 1.25;

/** Threat points that buy one experience point. */
export const PLAYER_XP_THREAT_DIVISOR = 2;

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
    };
}

function wholeNumber(value: unknown, fallback: number, minimum = 0): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(minimum, Math.round(value))
        : fallback;
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
    };
}
