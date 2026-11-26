import type { EntityInventoryState, ItemRarity } from '../types/InventoryType';
import type { SurvivalRun } from '../types/SurvivalType';

/** Entity id of the player character in Survival Mode. */
export const SURVIVAL_CHARACTER_ID = 'arthur';

/** Coins charged for one Fountain of Life heal. */
export const SURVIVAL_HEAL_COST = 10;

/** Fraction of maximum health restored by one Fountain of Life heal. */
export const SURVIVAL_HEAL_FRACTION = 0.5;

/** How much every enemy stat grows per round, on top of the previous round. */
export const SURVIVAL_ROUND_SCALING = 0.12;

/** Difficulty points a round-1 wave starts with. */
export const SURVIVAL_WAVE_BUDGET_BASE = 4;

/** Extra difficulty points every round adds to the wave budget. */
export const SURVIVAL_WAVE_BUDGET_GROWTH = 3;

/** Threat points that make up one wave difficulty point. */
export const SURVIVAL_WAVE_COST_DIVISOR = 50;

/** Coins paid for every enemy left defeated when a wave is cleared. */
export const SURVIVAL_COIN_PER_DEFEATED_MOB = 1;

/** How many distinct supplies a round's shelf holds. */
export const SURVIVAL_SHOP_SIZE = 6;

/**
 * Relative odds of each rarity being drawn onto a shelf.
 *
 * Common supplies dominate so the shelf is usually affordable; the best items
 * stay rare enough that finding one is a decision, not a routine.
 */
export const SURVIVAL_SHOP_RARITY_WEIGHTS: Record<ItemRarity, number> = {
    common: 60,
    uncommon: 25,
    rare: 10,
    epic: 4,
    legendary: 1,
};

/**
 * First round a rarity may appear on a shelf.
 *
 * The weight table alone would let a legendary slip into round 1; gating by
 * round turns the weights into a proper difficulty curve.
 */
export const SURVIVAL_SHOP_RARITY_MIN_ROUND: Record<ItemRarity, number> = {
    common: 1,
    uncommon: 1,
    rare: 2,
    epic: 4,
    legendary: 6,
};

/** A run that has not started yet. */
export function createDefaultSurvivalRun(): SurvivalRun {
    return {
        round: 1,
        hp: null,
        maxHp: 0,
        coins: 0,
        inventory: {},
        bestRound: 0,
        active: false,
    };
}

function wholeNumber(value: unknown, fallback: number, minimum = 0): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(minimum, Math.round(value))
        : fallback;
}

/** Keeps only positive whole stacks, so a malformed save cannot smuggle junk in. */
function normalizeInventory(raw: unknown): EntityInventoryState {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

    const inventory: EntityInventoryState = {};
    for (const [itemId, quantity] of Object.entries(raw as Record<string, unknown>)) {
        const amount = wholeNumber(quantity, 0);
        if (itemId && amount > 0) inventory[itemId] = amount;
    }
    return inventory;
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
        inventory: normalizeInventory(data.inventory),
        bestRound: wholeNumber(data.bestRound, 0),
        active: data.active === true,
    };
}
