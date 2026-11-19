import type { SurvivalRun } from '../types/SurvivalType';

/** Entity id of the player character in Survival Mode. */
export const SURVIVAL_CHARACTER_ID = 'arthur';

/** Coins charged for one Fountain of Life heal. */
export const SURVIVAL_HEAL_COST = 10;

/** Fraction of maximum health restored by one Fountain of Life heal. */
export const SURVIVAL_HEAL_FRACTION = 0.5;

/** How much every enemy stat grows per round, on top of the previous round. */
export const SURVIVAL_ROUND_SCALING = 0.12;

/** The slime family Survival Mode draws its waves from. */
export const SURVIVAL_SLIME_IDS = ['small_slime', 'slime', 'big_slime'] as const;

/** One of the six supplies shown in the marketplace. */
export interface SurvivalShopItem {
    itemId: string;
    price: number;
}

/**
 * The marketplace stock: six catalogue items, in shelf order.
 *
 * Buying is deliberately unavailable until the inventory exists; the prices are
 * already here so the shelf can show them without inventing a second item list.
 */
export const SURVIVAL_SHOP_ITEMS: readonly SurvivalShopItem[] = [
    { itemId: 'hp_potion', price: 3 },
    { itemId: 'hp_potion_plus', price: 6 },
    { itemId: 'mega_hp_potion', price: 12 },
    { itemId: 'mn_potion', price: 3 },
    { itemId: 'sn_potion', price: 3 },
    { itemId: 'elixir', price: 8 },
];

/** A run that has not started yet. */
export function createDefaultSurvivalRun(): SurvivalRun {
    return {
        round: 1,
        hp: null,
        maxHp: 0,
        coins: 0,
        bestRound: 0,
        active: false,
    };
}

function wholeNumber(value: unknown, fallback: number, minimum = 0): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(minimum, Math.round(value))
        : fallback;
}

/** Normalises a run read from a save, so old or malformed saves still open. */
export function normalizeSurvivalRun(raw: unknown): SurvivalRun {
    if (!raw || typeof raw !== 'object') return createDefaultSurvivalRun();

    const data = raw as Partial<SurvivalRun>;
    return {
        round: wholeNumber(data.round, 1, 1),
        hp: typeof data.hp === 'number' && Number.isFinite(data.hp)
            ? Math.max(0, Math.round(data.hp))
            : null,
        maxHp: wholeNumber(data.maxHp, 0),
        coins: wholeNumber(data.coins, 0),
        bestRound: wholeNumber(data.bestRound, 0),
        active: data.active === true,
    };
}
