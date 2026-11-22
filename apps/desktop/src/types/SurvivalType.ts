import type { EntityInventoryState } from './InventoryType';

/**
 * The durable state of a Survival Mode run.
 *
 * It lives on the save because it survives between sessions: the round reached,
 * the health carried into the next wave, the coins earned from loot, the
 * supplies carried between waves and the best round ever reached. Mana and
 * stamina are deliberately absent — they are restored in full at the start of
 * every wave.
 */
export interface SurvivalRun {
    /** The next wave to fight, one-based. */
    round: number;
    /** Health carried into the next wave, or `null` for untouched full health. */
    hp: number | null;
    /** Arthur's maximum health when the run last touched it; `0` while unknown. */
    maxHp: number;
    /** Coins earned from `gold_coin` loot in this run, spent on healing. */
    coins: number;
    /** Supplies Arthur carries into the next wave, keyed by item id. */
    inventory: EntityInventoryState;
    /** Highest round reached in any run on this save. */
    bestRound: number;
    /** Whether a run has been started; a fresh save opens on its first camp. */
    active: boolean;
}
