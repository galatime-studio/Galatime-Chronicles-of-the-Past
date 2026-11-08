/**
 * Damage maths — the single damage calculation of the game.
 *
 * The authored formula is:
 *
 *     dano = (ATK_TIPO / RES_TIPO) x EFFECT x (PWR / POWER_DIVISOR) x VARIANCE
 *
 * `POWER_DIVISOR` is the constant in `CombatConstants` (currently `1`); read it
 * before reasoning about balance — this comment used to hard-code `/5`, which
 * stopped being true and quietly misled a whole balance pass.
 *
 * `VARIANCE` is a random multiplier; an action that authors no `damage_variance`
 * falls back to {@link DAMAGE_VARIANCE_RANGE} (0.9 … 1.1). A hit that lands never
 * deals less than {@link MINIMUM_DAMAGE}.
 *
 * `EFFECT` is the element efficacy taken from the shared element matrix, so the
 * existing `elementUtils` scaling (x0 … x1.6) is reused rather than duplicated.
 * The lane (position) modifier, the bracing reduction and the ability modifier
 * folded from the defender's passives are applied on top. The whole efficacy
 * ladder lives in `CombatConstants.ELEMENT_DAMAGE_MULTIPLIERS`.
 *
 * On top of that sit the *traits* the skill catalogue authors — the ones the
 * skill forger writes and the engine reads:
 *
 * - `solar` / `lunar` — the hour of the day the fight happens at (full strength
 *   for a solar skill by day, a quarter of it at night; the lunar mirror).
 * - `defense_pierce` — the fraction of the target's defence the hit ignores.
 * - `bonus_vs_elements` — an extra multiplier per element of the defender.
 * - `bonus_vs_hp_below` — an extra multiplier against a wounded target.
 * - `crit_chance` / `guaranteed_crit_vs_status` — the critical hit (x1.75).
 * - `accuracy` / `evasion` — the attacker's aim and the defender's dodge.
 * - `ignore_accuracy` — the hit lands whatever the roll says.
 * - `ignore_position_penalty` — the lane (front/rear) multiplier is skipped.
 *
 * Every consumer — the turn resolver and the HUD preview — goes through
 * {@link resolveDamage}, so this chain exists exactly once.
 */

import {
    CRIT_MULTIPLIER,
    DAMAGE_VARIANCE_RANGE,
    DEFEND_DAMAGE_REDUCTION,
    DEFAULT_ACCURACY,
    MIN_EFFECTIVE_ACCURACY,
    MINIMUM_DAMAGE,
    MINIMUM_DEFENSE,
    LUNAR_DAY_MULTIPLIER,
    LUNAR_NIGHT_MULTIPLIER,
    POWER_DIVISOR,
    RANDOMIZE_POWER_RANGE,
    SOLAR_DAY_MULTIPLIER,
    SOLAR_NIGHT_MULTIPLIER,
} from '../../constants/CombatConstants';
import type {
    AttackModifier,
    CombatAction,
    CombatElementIndex,
    CombatLine,
    CombatRandom,
    CombatStats,
    CombatUnit,
    DamageType,
    EffectiveCombatTimePhase,
} from '../../types/CombatType';
import type { ElementData } from '../../types/ElementDataType';
import { clamp } from '../../utils/combatUtils';
import { elementDefenseScore, scoreToMultiplier } from '../../utils/elementUtils';
import { elementModulationFor, isImmuneToDamageType } from './effectResolver';
import { positionDamageModifier } from './positionRules';

/**
 * Precomputes the RAW defensive score of every target element against every
 * offensive element, so a fight never re-walks the matrix while resolving hits.
 *
 * Raw scores (not multipliers) are stored on purpose: a multi-element defender
 * has to ADD its elements' scores before the total is mapped, and averaging
 * multipliers would give a different — wrong — answer.
 */
export function buildElementDamageIndex(elements: readonly ElementData[]): CombatElementIndex {
    const defenseScores: Record<string, Record<string, number>> = {};

    for (const target of elements) {
        const against: Record<string, number> = {};
        for (const offensive of elements) {
            against[offensive.id] = elementDefenseScore(target, offensive.id);
        }
        defenseScores[target.id] = against;
    }

    return { defenseScores };
}

/**
 * Efficacy of one offensive element against a target that may carry several.
 *
 * The defender's elements ADD their raw scores together — an element that does
 * not mention the offence contributes `0` — and the total is mapped once to a
 * multiplier. So `immune (-3) + unmentioned (0) = -3 -> x0`, while
 * `immune (-3) + weak (+1) = -2 -> x0.65`. This is the same rule the
 * tooltips use (`elementController`), so a preview and a real hit can never
 * disagree.
 */
export function elementMultiplier(
    index: CombatElementIndex,
    offensiveElementId: string,
    targetElementIds: readonly string[],
): number {
    if (!offensiveElementId || targetElementIds.length === 0) return 1;

    let total = 0;
    for (const targetElementId of targetElementIds) {
        total += index.defenseScores[targetElementId]?.[offensiveElementId] ?? 0;
    }

    return scoreToMultiplier(total);
}

/** The attack stat a damage channel reads. */
export function attackStat(stats: CombatStats, damageType: DamageType): number {
    return damageType === 'physical' ? stats.physicalAttack : stats.magicalAttack;
}

/** The defence stat a damage channel reads. */
export function defenseStat(stats: CombatStats, damageType: DamageType): number {
    return damageType === 'physical' ? stats.physicalDefense : stats.magicalDefense;
}

/**
 * The combat time-state multiplier an action gets.
 *
 * A `solar` skill is worth its full strength only when the state is exactly
 * `day` and is penalised otherwise; a `lunar` skill only when the state is
 * exactly `night`. Blocked states (`day_no_solar` / `night_no_lunar`) suppress
 * their body's bonus. A skill with neither flag is unchanged.
 */
export function phaseDamageMultiplier(
    action: Pick<CombatAction, 'solar' | 'lunar'>,
    timePhase: EffectiveCombatTimePhase,
): number {
    let multiplier = 1;

    if (action.solar) {
        multiplier *= timePhase === 'day' ? SOLAR_DAY_MULTIPLIER : SOLAR_NIGHT_MULTIPLIER;
    }
    if (action.lunar) {
        multiplier *= timePhase === 'night' ? LUNAR_NIGHT_MULTIPLIER : LUNAR_DAY_MULTIPLIER;
    }

    return multiplier;
}

/**
 * The hour-of-the-day multiplier an action's effects get.
 *
 * The same curve as direct damage ({@link phaseDamageMultiplier}): a `solar`
 * effect is stronger by day and weaker at night, a `lunar` one the mirror.
 * An action with neither trait is unaffected (`1`).
 */
export function phaseEffectMultiplier(
    action: Pick<CombatAction, 'solar' | 'lunar'>,
    timePhase: EffectiveCombatTimePhase,
): number {
    return phaseDamageMultiplier(action, timePhase);
}

/**
 * The chance of a hit, in percent.
 *
 * The authored chance of the action, plus the attacker's `accuracy` modifier,
 * minus the defender's `evasion` modifier. The defender's *accuracy* is
 * irrelevant here: it governs the defender's own attacks, not how well it is
 * hit.
 *
 * An action that ignores accuracy always lands.
 */
export function effectiveAccuracy(
    action: Pick<CombatAction, 'accuracy' | 'ignoreAccuracy'>,
    attackerStats: CombatStats,
    defenderStats: CombatStats,
): number {
    if (action.ignoreAccuracy) return 100;

    const authored = normalizeAccuracy(action.accuracy);
    const value = authored + (attackerStats.accuracy ?? 0) - (defenderStats.evasion ?? 0);

    return clamp(value, MIN_EFFECTIVE_ACCURACY, 100);
}

/**
 * The chance of a critical hit, in percent.
 *
 * The skill's own `crit_chance` plus the attacker's `crit_chance` stat. A
 * skill that guarantees a critical against a status crits every time it hits
 * a target carrying that status.
 */
export function critChanceFor(
    action: Pick<CombatAction, 'critChance' | 'guaranteedCritVsStatus'>,
    attackerStats: CombatStats,
    defender?: CombatUnit | null,
): number {
    if (action.guaranteedCritVsStatus && defender && hasStatusEffect(defender, action.guaranteedCritVsStatus)) {
        return 100;
    }

    return clamp((action.critChance ?? 0) + (attackerStats.critChance ?? 0), 0, 100);
}

/**
 * The extra multiplier an action gets against a defender's elements.
 *
 * The strongest bonus declared for one of the defender's elements wins — a
 * skill that says "x1.5 against umbra" does not stack with itself.
 */
export function bonusVsElementsMultiplier(
    action: Pick<CombatAction, 'bonusVsElements'>,
    defenderElementIds: readonly string[],
): number {
    const bonuses = action.bonusVsElements;
    if (!bonuses) return 1;

    let best = 1;
    for (const elementId of defenderElementIds) {
        const value = bonuses[elementId];
        if (typeof value === 'number' && Number.isFinite(value) && value > best) best = value;
    }

    return best;
}

/**
 * The extra multiplier an action gets against a wounded target.
 *
 * `bonus_vs_hp_below: { threshold: 0.5, multiplier: 1.25 }` bites only while
 * the defender is under half its health.
 */
export function bonusVsHpBelowMultiplier(
    action: Pick<CombatAction, 'bonusVsHpBelow'>,
    defenderHpFraction: number,
): number {
    const spec = action.bonusVsHpBelow;
    if (!spec) return 1;

    const threshold = spec.threshold;
    const multiplier = spec.multiplier;
    if (!Number.isFinite(threshold) || threshold <= 0) return 1;
    if (!Number.isFinite(multiplier) || multiplier <= 0) return 1;

    return defenderHpFraction < threshold ? multiplier : 1;
}

/** The defence the hit actually faces, after the pierce takes its share. */
export function piercedDefense(defenseValue: number, pierce: number): number {
    const fraction = clamp(pierce ?? 0, 0, 1);
    return defenseValue * (1 - fraction);
}

/** Whether a unit carries a status, by id or by label. */
function hasStatusEffect(unit: CombatUnit, statusId: string): boolean {
    return unit.effects.some(
        (effect) => effect.effectId === statusId || effect.statusEffect === statusId,
    );
}

/** Damage before the lane, bracing and variance steps. */
interface BaseDamageParams {
    attackValue: number;
    defenseValue: number;
    power: number;
    elementMultiplier: number;
    positionModifier: number;
    /** Reduction from the target bracing (`0` … `0.9`). */
    defenseReduction: number;
    /** Random multiplier applied to each hit (`1` when not rolling). */
    variance: number;
    /** Ability multiplier folded from the target's passive abilities (`1` = none). */
    attackMultiplier: number;
    /** `true` when an ability makes the target immune to the hit. */
    immune: boolean;
    /**
     * John II's `atk_def_ratio`: the hit is scaled again by `ATK / RES`, so a
     * fragile target takes far more and an armoured one far less.
     */
    atkDefRatio?: boolean;
    /**
     * The skill's traits, folded into one multiplier.
     *
     * The hour of the day, the bonus against the defender's elements, the
     * bonus against a wounded target and the critical hit all land here.
     */
    traits?: number;
}

/** The intermediate values of one hit, kept so the log can show the chain. */
interface DamageBreakdown {
    /** Damage before the lane and bracing steps. */
    base: number;
    /** Damage after the lane and bracing reductions. */
    positioned: number;
    /** Damage after the variance multiplier. */
    varied: number;
    /** Rounded damage actually applied. */
    final: number;
}

/**
 * The damage chain: `(ATK / RES) x EFFECT x (PWR / POWER_DIVISOR)`, then the
 * skill's traits, the lane and the bracing, then the variance, then rounded.
 *
 * Defence is a divisor, so it can never drop below {@link MINIMUM_DEFENSE}. A hit
 * that lands always deals at least {@link MINIMUM_DAMAGE} — except against an
 * immune target (effect `x0`), which takes nothing.
 */
function calculateDamage(params: BaseDamageParams): DamageBreakdown {
    const { attackValue, defenseValue, power, elementMultiplier: effect } = params;
    if (power <= 0) return { base: 0, positioned: 0, varied: 0, final: 0 };

    const defense = Math.max(MINIMUM_DEFENSE, defenseValue);
    const base = (attackValue / defense) * effect * (power / POWER_DIVISOR);
    const reduction = 1 - clamp(params.defenseReduction, 0, 0.9);
    const positioned = base * (params.traits ?? 1) * params.positionModifier * reduction;
    // A `royal` weapon (John II) scales the hit by the same ATK/RES ratio again.
    const ratio = params.atkDefRatio ? attackValue / defense : 1;
    const varied = positioned * params.variance * params.attackMultiplier * ratio;
    const final = params.immune || effect === 0 ? 0 : Math.max(MINIMUM_DAMAGE, Math.round(varied));
    return { base, positioned, varied, final };
}

/** Everything one attacker/target damage resolution needs. */
export interface DamageRequest {
    action: CombatAction;
    attackerStats: CombatStats;
    defenderStats: CombatStats;
    /** Elements of the unit being hit; drives the efficacy multiplier. */
    defenderElementIds: readonly string[];
    /**
     * The unit being hit.
     *
     * Read for the statuses it carries, which decide whether a critical is
     * guaranteed. Optional: a preview may only have the numbers.
     */
    defender?: CombatUnit | null;
    elementIndex: CombatElementIndex;
    attackerLine: CombatLine;
    defenderLine: CombatLine;
    /** `true` when attacker and defender fight for the same side. */
    sameSide: boolean;
    /** `true` when the defender is bracing (`defend`). */
    defenderDefending: boolean;
    /**
     * Passive modifier folded from the defender's abilities.
     *
     * Required (not defaulted) on purpose: every caller has to decide, and both
     * callers read it through `foldAttackModifiers`, so the HUD preview and the
     * real hit can never fold different numbers.
     */
    modifier: AttackModifier;
    random: CombatRandom;
    /**
     * The effective combat time state.
     *
     * It decides what a `solar` or `lunar` action is worth (exact `day`/`night`
     * required for the bonus), so it has to be part of the chain.
     */
    timePhase: EffectiveCombatTimePhase;
    /**
     * The defender's remaining health, as a fraction of its maximum.
     *
     * Read by `bonus_vs_hp_below`. Defaults to `1` (a healthy target).
     */
    defenderHpFraction?: number;
    /**
     * Extra trait multiplier contributed by the attacker's live statuses
     * (`1` when none apply).
     *
     * Blood Moon-style effects add damage against wounded targets; folding it
     * here keeps a preview and a real hit reading the same number.
     */
    attackerTraits?: number;
    /**
     * `true` (the default) rolls accuracy and variance, producing the numbers a
     * real hit would use. `false` returns the deterministic expectation of a
     * single hit — no accuracy roll, variance `1` — for target previews.
     */
    roll?: boolean;
    /**
     * Hits this request rolls, overriding `action.hitCount`.
     *
     * A scatter ray asks for exactly one: the action's ray count lives in the
     * resolver, which decides who each ray hits, so the damage chain must not
     * re-multiply it.
     */
    attempts?: number;
}

/** The full damage accounting of one attacker/target pair. */
export interface DamageResult {
    /** `false` when every hit missed. */
    isHit: boolean;
    /** Hits that landed (`1` for a non-rolling preview). */
    hits: number;
    /** Attack stat the action read from the attacker. */
    attackValue: number;
    /** Defence stat the action read from the defender. */
    defenseValue: number;
    /** Authored power. */
    power: number;
    /** Damage channel the action used. */
    damageType: DamageType;
    /** Ability multiplier folded from the target's passive abilities (`1` = none). */
    attackMultiplier: number;
    /** `true` when an ability made the target immune to the hit. */
    immune: boolean;
    /** Element efficacy (`x0` … `x1.6`; see `ELEMENT_DAMAGE_MULTIPLIERS`). */
    elementMultiplier: number;
    /**
     * Modulation the defender's own statuses imposed (`Wet` quarters ignis);
     * `1` when none applies.
     */
    statusModulation: number;
    /** `bonus_vs_status` trait multiplier against the defender (`1` = none). */
    statusMultiplier: number;
    /** Variance multiplier applied (`1` when not rolling). */
    variance: number;
    /** Lane modifier (`1`, `0.85` or `0.8`). */
    positionModifier: number;
    /** Reduction from the defender bracing (`0` … `0.9`). */
    defenseReduction: number;
    /** One hit before the lane, bracing and variance steps. */
    baseDamage: number;
    /** Rounded damage applied across every hit. */
    finalDamage: number;
    /** Chance of a critical hit, in percent. */
    critChance: number;
    /** `true` when at least one of the hits was critical. */
    isCrit: boolean;
    /** Chance of a hit landing, in percent. */
    hitChance: number;
}

/**
 * Resolves the damage an action deals to one target.
 *
 * The only place a damage number is produced: the turn resolver and the HUD
 * preview both call it, so they can never drift apart.
 */
export function resolveDamage(request: DamageRequest): DamageResult {
    const { action, elementIndex, random } = request;
    const rolling = request.roll ?? true;

    const attackValue = attackStat(request.attackerStats, action.damageType);
    const rawDefense = defenseStat(request.defenderStats, action.damageType);
    // A pierce takes its share of the defence before the division, so the hit
    // faces a smaller number from the start. The reported defence stays the
    // target's own, so the log does not claim it was weaker than it is. A
    // `bonus_vs_status` trait (hydro_lance versus Wet) deepens it further.
    const statusBonus = bonusVsStatusFor(action, request.defender);
    const pierced = piercedDefense(rawDefense, (action.defensePierce ?? 0) + statusBonus.defensePierce);
    // A modulation the defender carries (Wet versus ignis) compounds into the
    // element chain, so attacks, previews and every derived reader agree.
    const statusModulation = elementModulationFor(request.defender, action.elementId);
    const effect = elementMultiplier(elementIndex, action.elementId, request.defenderElementIds) * statusModulation;
    const positionModifier = action.ignorePositionPenalty
        ? 1
        : positionDamageModifier(
            request.attackerLine,
            request.defenderLine,
            request.sameSide,
        );
    const defenseReduction = request.defenderDefending ? DEFEND_DAMAGE_REDUCTION : 0;
    const variance = rolling ? rollVariance(random, action.damageVariance) : 1;

    // Per-range accuracy (staff/bow): the target's line stands in for distance,
    // so a shot at the back line is judged by the `rear` value and a swing at the
    // front line by `front`.
    const byRange = action.weapon?.accuracyByRange;
    const authoredAccuracy = byRange
        ? (request.defenderLine === 'front' ? byRange.front : byRange.rear)
        : action.accuracy;
    const accuracy = effectiveAccuracy(
        { accuracy: authoredAccuracy, ignoreAccuracy: action.ignoreAccuracy },
        request.attackerStats,
        request.defenderStats,
    );
    const critChance = critChanceFor(action, request.attackerStats, request.defender ?? null);
    // A live `damage_immunities` status voids the hit the same way an ability
    // does, so a preview and a real hit read the same immunity.
    const immune = request.modifier.immune
        || (request.defender ? isImmuneToDamageType(request.defender, action.damageType) : false);
    const atkDefRatio = action.weapon?.damageModifiers?.atk_def_ratio === true;
    // Bazar goods (`randomize_power`) wager the authored power on every swing.
    const randomizePower = action.weapon?.randomizePower === true;
    const [powerMin, powerMax] = RANDOMIZE_POWER_RANGE;

    // The skill's traits, folded once so every hit of the same action reads
    // the same numbers. A `bonus_per_charge` trait (`avalanche`) trades each
    // bearing charge of the target for extra damage, then spends them.
    const chargeCount = chargesHeld(request.defender, action.bonusPerCharge?.status);
    const traitMultiplier = phaseDamageMultiplier(action, request.timePhase)
        * bonusVsElementsMultiplier(action, request.defenderElementIds)
        * bonusVsHpBelowMultiplier(action, request.defenderHpFraction ?? 1)
        * statusBonus.multiplier
        * (request.attackerTraits ?? 1)
        * (1 + (chargeCount > 0 && action.bonusPerCharge
            ? action.bonusPerCharge.multiplierPerCharge * chargeCount
            : 0));

    const attempts = rolling ? Math.max(1, request.attempts ?? action.hitCount) : 1;
    let baseDamage = 0;
    let finalDamage = 0;
    let hits = 0;
    let isCrit = false;

    for (let hit = 0; hit < attempts; hit += 1) {
        if (rolling && !rollHit(random, accuracy)) continue;

        const hitPower = rolling && randomizePower
            ? action.power * (powerMin + random() * (powerMax - powerMin))
            : action.power;

        // A critical hit is rolled per hit: a skill that hits four times can
        // crit once and miss the rest.
        const critical = rolling && critChance > 0 && random() * 100 < critChance;
        if (critical) isCrit = true;

        const breakdown = calculateDamage({
            attackValue,
            defenseValue: pierced,
            power: hitPower,
            elementMultiplier: effect,
            positionModifier,
            defenseReduction,
            variance,
            attackMultiplier: request.modifier.multiplier,
            immune,
            atkDefRatio,
            traits: traitMultiplier * (critical ? CRIT_MULTIPLIER : 1),
        });

        baseDamage = breakdown.base;
        finalDamage += breakdown.final;
        hits += 1;
    }

    return {
        isHit: hits > 0,
        hits,
        attackValue,
        defenseValue: rawDefense,
        power: action.power,
        damageType: action.damageType,
        elementMultiplier: effect,
        statusModulation,
        statusMultiplier: statusBonus.multiplier,
        variance,
        positionModifier,
        defenseReduction,
        attackMultiplier: request.modifier.multiplier,
        immune,
        baseDamage,
        finalDamage,
        critChance,
        isCrit,
        hitChance: accuracy,
    };
}

/**
 * The extra numbers a `bonus_vs_status` trait carries against the target.
 *
 * Only damage-dealing reads: the strongest matching trait wins, and a target
 * carrying the named status (by id or label) unlocks the trait's bonus.
 */
function bonusVsStatusFor(action: CombatAction, defender: CombatUnit | null | undefined): {
    multiplier: number;
    defensePierce: number;
} {
    const specs = action.bonusVsStatus;
    if (!specs?.length || !defender) return { multiplier: 1, defensePierce: 0 };

    let multiplier = 1;
    let defensePierce = 0;
    let matched = false;

    for (const spec of specs) {
        const wanted = spec.status.trim().toLowerCase();
        const carries = defender.effects.some((effect) => (
            (effect.statusEffect ?? '').trim().toLowerCase() === wanted
            || effect.effectId.trim().toLowerCase() === wanted
        ));
        if (!carries) continue;

        matched = true;
        multiplier *= spec.multiplier > 1 ? spec.multiplier : 1;
        defensePierce += Math.max(0, spec.defensePierce);
    }

    return matched ? { multiplier, defensePierce } : { multiplier: 1, defensePierce: 0 };
}

/**
 * How many charges the target holds of a stacking status (`Freezing`), for a
 * `bonus_per_charge` trait. Requires the charges the holder actually bears.
 */
export function chargesHeld(
    defender: CombatUnit | null | undefined,
    status: string | null | undefined,
): number {
    if (!defender || !status) return 0;
    const wanted = status.trim().toLowerCase();

    for (const effect of defender.effects) {
        if (!effect.chargeMax) continue;
        if ((effect.statusEffect ?? '').trim().toLowerCase() === wanted) {
            return Math.max(1, effect.stacks);
        }
    }

    return 0;
}

/** Normalises an authored accuracy to a `0 … 100` percentage. */
export function normalizeAccuracy(accuracy: number): number {
    const value = Number.isFinite(accuracy) ? accuracy : DEFAULT_ACCURACY;
    const percent = value > 0 && value <= 1 ? value * 100 : value;
    return clamp(percent, 0, 100);
}

/** Rolls a single hit against an authored accuracy. */
export function rollHit(random: CombatRandom, accuracy: number): boolean {
    return random() * 100 < normalizeAccuracy(accuracy);
}

/**
 * Rolls a multiplier inside a damage-variance range.
 *
 * An action that authors no `damage_variance` uses {@link DAMAGE_VARIANCE_RANGE}.
 */
export function rollVariance(random: CombatRandom, variance: [number, number] | null): number {
    const [min, max] = variance ?? DAMAGE_VARIANCE_RANGE;
    return min + random() * (max - min);
}

/**
 * Randomness for HUD previews.
 *
 * A preview must not consume the fight's RNG stream, and a chance-gated passive
 * should read as "could apply" rather than "never applies" — `0` satisfies every
 * `chance` roll, so the preview stays optimistic and side-effect free.
 */
export const DETERMINISTIC_PREVIEW_RANDOM: CombatRandom = () => 0;
