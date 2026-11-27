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
    SURVIVAL_COIN_PER_DEFEATED_MOB,
    SURVIVAL_HEAL_COST,
    SURVIVAL_HEAL_FRACTION,
    SURVIVAL_ROUND_SCALING,
    SURVIVAL_SHOP_RARITY_MIN_ROUND,
    SURVIVAL_SHOP_RARITY_WEIGHTS,
    SURVIVAL_SHOP_SIZE,
    SURVIVAL_WAVE_BUDGET_BASE,
    SURVIVAL_WAVE_BUDGET_GROWTH,
    SURVIVAL_WAVE_COST_DIVISOR,
} from '../../../constants/SurvivalConstants';
import { threatScore } from '../../../services/combat/threatScore';
import { createSeededCombatRandom } from '../../../services/combat/ai/training/seededRandom';
import { addItem } from '../../../services/inventory/entityInventoryService';
import type { MobData } from '../../../types/EntityDataType';
import type { EntityInventoryState, ItemDefinition } from '../../../types/InventoryType';
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
    /** The mob catalogue (`src/data/entities/mobs`); every entry may be drawn. */
    mobs: readonly MobData[];
    /** The encounter name shown in the arena. */
    name: string;
    /** Bought stat increases applied to Arthur on top of his authored stats. */
    characterStats?: Partial<CombatStats>;
    /** Injectable randomness, so tests can pin a composition. */
    random?: () => number;
}

/**
 * Adds a bought health increase to the carried run.
 *
 * The new maximum has to live on the run, not only on the next combat unit:
 * the camp bar and the Fountain of Life read `run.maxHp` between rounds. The
 * current health rises by the same amount so the purchase is felt immediately;
 * an untouched run (`hp === null`) stays at full health.
 */
export function raiseSurvivalMaxHp(run: SurvivalRun, amount: number, fallbackMaxHp: number): SurvivalRun {
    const gain = Math.max(0, Math.round(amount));
    if (gain <= 0) return run;

    const maxHp = Math.max(1, run.maxHp > 0 ? run.maxHp : fallbackMaxHp) + gain;
    return {
        ...run,
        maxHp,
        hp: run.hp === null ? null : Math.min(maxHp, run.hp + gain),
    };
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

/** How heavily a rarity is favoured on this round's shelves; `0` hides it. */
function shopWeight(rarity: ItemDefinition['rarity'], round: number): number {
    if ((SURVIVAL_SHOP_RARITY_MIN_ROUND[rarity] ?? 1) > round) return 0;
    return SURVIVAL_SHOP_RARITY_WEIGHTS[rarity] ?? 0;
}

/**
 * The supplies a round's shelf offers.
 *
 * The catalogue is the only source of stock: every consumable usable in combat
 * may appear (ammunition and key items are excluded), gated by its rarity's
 * first round and weighted against the rest. The draw is seeded by the round
 * and, when the save has one, by its chronicle seed, so the shelf is stable
 * while the player shops, differs between chronicles, and rolls over only when
 * the run advances. The first slot prefers a common supply, so a shelf is
 * never six luxury items the player cannot afford.
 */
export function survivalShopStock(
    round: number,
    catalogue: readonly ItemDefinition[],
    seed?: number,
): ItemDefinition[] {
    const safeRound = Math.max(1, Math.round(round));
    const pool = catalogue
        .filter((item) => (
            item.category === 'consumable'
            && !item.item_type
            && item.usable_in_combat
            && item.price > 0
            && shopWeight(item.rarity, safeRound) > 0
        ))
        .sort((a, b) => a.id.localeCompare(b.id));

    if (pool.length === 0) return [];

    const random = createSeededCombatRandom(
        seed === undefined ? `survival-shop:${safeRound}` : `survival-shop:${seed}:${safeRound}`,
    );
    const remaining = [...pool];
    const stock: ItemDefinition[] = [];

    while (stock.length < SURVIVAL_SHOP_SIZE && remaining.length > 0) {
        const commons = remaining.filter((item) => item.rarity === 'common');
        const candidates = stock.length === 0 && commons.length > 0 ? commons : remaining;

        const totalWeight = candidates.reduce(
            (total, item) => total + shopWeight(item.rarity, safeRound),
            0,
        );
        let roll = random() * totalWeight;
        let chosen = candidates[candidates.length - 1];

        for (const item of candidates) {
            roll -= shopWeight(item.rarity, safeRound);
            if (roll < 0) {
                chosen = item;
                break;
            }
        }

        stock.push(chosen);
        remaining.splice(remaining.indexOf(chosen), 1);
    }

    return stock;
}

/** Whether the run can pay for one more of an item and still carry it. */
export function canBuySurvivalItem(run: SurvivalRun, item: ItemDefinition): boolean {
    if (run.coins < item.price) return false;
    const owned = run.inventory[item.id] ?? 0;
    return item.max_stack === null || owned < item.max_stack;
}

/** Buys one item into the run's bag; returns the run unchanged when illegal. */
export function buySurvivalItem(run: SurvivalRun, item: ItemDefinition): SurvivalRun {
    if (!canBuySurvivalItem(run, item)) return run;

    const inventory = { ...run.inventory };
    const added = addItem(inventory, item.id, 1);
    if (!added.ok) return run;

    return { ...run, coins: run.coins - item.price, inventory };
}

/** Gold coins found in the fight's final log. */
export function countGoldCoins(state: CombatState): number {
    return state.log.reduce((total, event: CombatEvent) => (
        event.type === 'loot_gained' && event.itemId === 'gold_coin'
            ? total + event.quantity
            : total
    ), 0);
}

/**
 * The round-completion purse: one coin for every enemy the wave placed.
 *
 * The authored roster is the unit of payment, not the final battlefield. A big
 * slime that splits leaves several slimes behind, but it was still one enemy
 * placed at the start; split units must never inflate the reward.
 */
export function survivalRoundCoinReward(enemiesPlaced: number): number {
    return Math.max(0, Math.floor(enemiesPlaced)) * SURVIVAL_COIN_PER_DEFEATED_MOB;
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

/** The stat block a mob fights with at this round's scale. */
function scaledMobStats(mob: MobData, scale: number): Partial<CombatStats> {
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

/**
 * How much pressure a mob applies before it dies — the wave's threat score.
 *
 * Both terms ride the engine's own mitigation ratio
 * (`attackDefenseFactor`, see `combat-damage-formula`), so the score reads
 * like the combat it describes:
 *
 * - **pressure** — the mob's strongest attack (`max(physical, magical)`)
 *   against a reference defence, because the mob swings with its best stat
 *   while Arthur's player exploits the weaker axis.
 * - **durability** — the mob's HP divided by the hits-to-kill through its
 *   weakest defence against a reference attack: effective HP against Arthur.
 *
 * The product approximates how much damage the mob can apply over its
 * lifetime, which is what a wave budget should buy.
 */
export function mobThreat(mob: MobData): number {
    const base = mob.base_stats;

    return threatScore({
        hp: base.hp,
        physicalAttack: base.physical_attack,
        magicalAttack: base.magical_attack,
        physicalDefense: base.physical_defense,
        magicalDefense: base.magical_defense,
    });
}

/** A mob's price in wave difficulty points; every mob costs at least one. */
export function mobWaveCost(mob: MobData): number {
    return Math.max(1, Math.round(mobThreat(mob) / SURVIVAL_WAVE_COST_DIVISOR));
}

/** The difficulty points a round's wave may spend on enemies. */
export function survivalWaveBudget(round: number): number {
    return SURVIVAL_WAVE_BUDGET_BASE + Math.max(0, round - 1) * SURVIVAL_WAVE_BUDGET_GROWTH;
}

/**
 * The wave pool, weakest first.
 *
 * The catalogue the caller passes *is* the pool — no id list lives here — so a
 * new mob in `src/data/entities/mobs` joins the waves without a code change.
 * Sorting by threat gives the draws a stable order (and reads like a bestiary
 * entry order: fodder first, bosses last).
 */
function wavePool(mobs: readonly MobData[]): MobData[] {
    return [...mobs].sort((a, b) => mobThreat(a) - mobThreat(b) || a.id.localeCompare(b.id));
}

/**
 * One random mob the remaining budget can afford.
 *
 * No pick may cost more than half of what is left, so a wave is never one
 * expensive body eating the whole round: the budget always buys at least two
 * mobs while the pool has anything cheap enough.
 */
function pickWaveMob(pool: readonly MobData[], remaining: number, random: () => number): MobData | null {
    if (pool.length === 0 || remaining <= 0) return null;

    const cap = Math.ceil(remaining / 2);
    const affordable = pool.filter((mob) => mobWaveCost(mob) <= cap);
    if (affordable.length === 0) return null;

    const index = Math.min(affordable.length - 1, Math.floor(random() * affordable.length));
    return affordable[index];
}

function memberOf(mob: MobData, line: 'front' | 'rear', scale: number, hold?: number): CombatEncounterMember {
    return {
        entityId: mob.id,
        entityType: 'mob',
        line,
        ...(hold === undefined ? {} : { hold }),
        stats: scaledMobStats(mob, scale),
    };
}

/**
 * Builds the encounter for one round.
 *
 * Arthur stands alone, controlled by the player, with the health the run
 * carried over. The enemies are drawn from the mob catalogue the caller passes
 * until the round's difficulty budget runs out: a growing field group plus,
 * from the third round on, off-field waves that deploy as the rear line
 * empties. Each pick costs {@link mobWaveCost} points and may cost at most half
 * of the remaining budget, so stronger bodies only appear on later rounds — and
 * only alongside cheaper ones.
 */
export function createSurvivalEncounter({
    round,
    run,
    mobs,
    name,
    characterStats,
    random = Math.random,
}: SurvivalWaveOptions): CombatEncounter {
    const scale = 1 + Math.max(0, round - 1) * SURVIVAL_ROUND_SCALING;
    const fieldCount = fieldEnemyCount(Math.max(1, round));
    const frontCount = Math.ceil(fieldCount / 2);
    const pool = wavePool(mobs);
    let remaining = survivalWaveBudget(Math.max(1, round));

    const takeMob = (): MobData | null => {
        const mob = pickWaveMob(pool, remaining, random);
        if (mob) remaining -= mobWaveCost(mob);
        return mob;
    };

    const enemies: CombatEncounterMember[] = [];
    for (let index = 0; index < fieldCount; index += 1) {
        const mob = takeMob();
        if (!mob) break;
        enemies.push(memberOf(mob, index < frontCount ? 'front' : 'rear', scale));
    }

    const lanes = holdLaneCount(Math.max(1, round));
    const laneSize = holdLaneSize(Math.max(1, round));
    for (let lane = 1; lane <= lanes; lane += 1) {
        for (let index = 0; index < laneSize; index += 1) {
            const mob = takeMob();
            if (!mob) break;
            enemies.push(memberOf(mob, 'rear', scale, lane));
        }
    }

    // A pool whose cheapest mob exceeds the cap still has to field a fight.
    if (enemies.length === 0 && pool.length > 0) {
        const cheapest = pool.reduce((best, mob) => (mobWaveCost(mob) < mobWaveCost(best) ? mob : best));
        enemies.push(memberOf(cheapest, 'front', scale));
    }

    return {
        id: `survival_round_${round}`,
        name,
        allies: [{
            entityId: SURVIVAL_CHARACTER_ID,
            entityType: 'character',
            line: 'front',
            isPlayerControlled: true,
            inventory: { ...run.inventory },
            ...(characterStats ? { stats: characterStats } : {}),
            ...(run.hp === null ? {} : { currentHp: run.hp }),
        }],
        enemies,
    };
}

/**
 * The run after clearing one wave: health, coins and whatever is left in the
 * bag carry; everything else resets. The purse gains the loot log plus the
 * round-completion reward for the enemies the wave placed.
 *
 * `enemiesPlaced` is the encounter's authored enemy roster, not the final field:
 * a split adds units mid-fight but does not add enemies to pay for.
 */
export function resolveSurvivalVictory(
    run: SurvivalRun,
    state: CombatState,
    round: number,
    enemiesPlaced: number,
    inventory: EntityInventoryState = run.inventory,
): SurvivalRun {
    const arthur = state.units.find((unit) => (
        unit.side === 'allies' && unit.entityId === SURVIVAL_CHARACTER_ID
    ));

    return {
        ...run,
        round: round + 1,
        hp: arthur ? Math.max(1, Math.round(arthur.currentHp)) : run.hp,
        maxHp: arthur ? Math.max(1, Math.round(arthur.stats.maxHp)) : run.maxHp,
        coins: run.coins + countGoldCoins(state) + survivalRoundCoinReward(enemiesPlaced),
        inventory: { ...inventory },
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
        inventory: {},
        bestRound: Math.max(run.bestRound, round),
        active: false,
    };
}
