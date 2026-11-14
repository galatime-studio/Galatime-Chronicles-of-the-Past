/**
 * `effect_value` — the worth of what an action does beyond dealing damage.
 *
 * Damage-per-turn (normalised by the target's health), action and skill locks
 * (worth a fixed, high amount: a turn taken from an enemy is a turn won), stat
 * changes, and the modern defensive/control payload the engine understands:
 * shields, barriers, taunts, intercepts, counters, cleanses, resource pressure,
 * turn-order manipulation, marks and delayed detonations.
 *
 * Named statuses get their own setup value. A status is not just its immediate
 * payload: Wet doubles aqua/chaos and quarters ignis, Mud denies a lane switch,
 * Freezing charges toward Frozen, and a Burn or Poison keeps paying after the
 * hit. The score therefore reads duration, whether the target already carries
 * the status, whether a recent attempt was resisted, and whether any living ally
 * has a payoff action (`bonus_vs_status`, `bonus_per_charge`, `consume_stacks`,
 * `guaranteed_crit_vs_status`) that the setup would enable.
 *
 * Direct healing is left to `heal_ally`/`heal_self`, so this never double-counts
 * a mend. Health regeneration is also excluded here for the same reason; the
 * healing estimators fold it in.
 */

import { AI_DAMAGE_REFERENCE_FRACTION, AI_EFFECT_REFERENCE, AI_HEAL_REFERENCE_FRACTION, AI_HORIZON_TURN_FLOOR, AI_STAT_EFFECT_CAP, AI_STAT_TURN_VALUE } from '../../../../constants/AiConstants';
import type { AiConsideration, AiDecisionContext } from '../../../../types/AiType';
import type { CombatUnit } from '../../../../types/CombatType';
import {
    asRecord,
    clamp,
    readChance,
    readNumber,
    readStatDelta,
} from '../../../../utils/combatUtils';
import { effectiveStats } from '../../effectResolver';
import { candidateTargetUnits } from '../aiCandidates';
import { expectedDamageFor, impactFor } from '../aiImpacts';
import { estimateThreatAgainst } from '../aiThreat';

/** Turns an authored `turns` field reads as, when it is a number. */
const DEFAULT_DOT_TURNS = 3;

export const effectValue: AiConsideration = {
    id: 'effect_value',
    evaluate(context, candidate) {
        const { action } = candidate;
        if (action.effects.length === 0) return 0;

        const targets = candidateTargetUnits(context, candidate);
        const primary = targets[0];
        const reference = primary ? effectiveStats(primary) : null;
        const referenceHp = Math.max(1, reference?.maxHp ?? 1);
        const referenceMana = Math.max(1, reference?.maxMana ?? 1);
        const referenceStamina = Math.max(1, reference?.maxStamina ?? 1);
        const negativeStatuses = targets.reduce((total, target) => (
            total + target.effects.filter((effect) => effect.polarity === 'negative').length
        ), 0);

        let score = 0;
        for (const effect of action.effects) {
            const record = asRecord(effect) ?? {};
            const turns = horizonTurns(context, readDotTurns(record.turns));

            let effectScore = 0;

            const damagePerTurn = readNumber(record.damage_per_turn, 0);
            if (damagePerTurn > 0) {
                effectScore += clamp(
                    (damagePerTurn * turns) / referenceHp / AI_DAMAGE_REFERENCE_FRACTION,
                    0,
                    1,
                );
            }

            if (Array.isArray(record.prevent_actions) && record.prevent_actions.length > 0) effectScore += 0.8;
            if (record.prevent_skills === true) effectScore += 0.4;
            if (hasEntries(record.prevent_ranges)) effectScore += 0.2;
            if (hasEntries(record.prevent_elements)) effectScore += 0.2;

            effectScore += statValue(context, record, targets, turns);

            effectScore += shieldValue(record.shield);
            effectScore += cleanseValue(record, negativeStatuses);
            effectScore += controlValue(record);
            effectScore += protectionValue(record) * protectionNeed(context, targets);
            effectScore += protectionCoverage(context, record, targets);
            effectScore += resourceValue(record, referenceMana, referenceStamina);
            effectScore += payoffValue(record, referenceHp);
            effectScore += statusValue(record, context, targets);

            score += renewalFactor(record, targets, turns) * effectScore;
        }

        return clamp(score, 0, 1);
    },
};

/**
 * How much of an effect is still worth paying a turn for.
 *
 * Re-casting a buff that is already up is how three units can spend a whole
 * fight decorating themselves: the payload was priced identically whether the
 * status was fresh or had three turns left. The reuse rule is that only the
 * *extension* has value — a three-turn buff re-applied with three turns left
 * gives nothing, and one re-applied on its last turn is worth two of the three.
 *
 * Charge and stack families keep a positive reuse value because every
 * application advances them, and an effect already on some but not all targets
 * keeps a partial value, since the rest of the board still gains.
 */
function renewalFactor(
    record: Record<string, unknown>,
    targets: readonly CombatUnit[],
    turns: number,
): number {
    if (targets.length === 0) return 1;

    const key = normalizeStatus(record.status_effect) ?? normalizeStatus(record.effect_id);
    if (!key) return 1;

    const carries = (target: CombatUnit): boolean => target.effects.some((active) => (
        (normalizeStatus(active.statusEffect) ?? normalizeStatus(active.effectId)) === key
    ));
    const carried = targets.filter(carries);
    if (carried.length === 0) return 1;
    if (carried.length < targets.length) return PARTIAL_RENEWAL;

    const stacking = record.can_stack === true || hasEntries(record.charges) || key.includes('freez');
    if (stacking) return STACKING_RENEWAL;

    let remaining = 0;
    for (const target of targets) {
        for (const active of target.effects) {
            if ((normalizeStatus(active.statusEffect) ?? normalizeStatus(active.effectId)) !== key) continue;
            // A null `turns` means "until the fight ends": no cast can extend it.
            const left = active.turns === null || active.turns === undefined
                ? Number.POSITIVE_INFINITY
                : active.turns;
            remaining = Math.max(remaining, left);
        }
    }
    if (!Number.isFinite(remaining)) return 0;
    return clamp((turns - remaining) / Math.max(1, turns), 0, 1);
}

/** Reuse value when only some of the targets already carry the effect. */
const PARTIAL_RENEWAL = 0.7;

/** Reuse value for charge and stack families, where each cast advances them. */
const STACKING_RENEWAL = 0.6;

/**
 * Named-status setup value.
 *
 * The engine's long-term mechanics mostly live in status names: Wet changes the
 * element table, Mud denies movement, Freezing builds toward Frozen, Burn and
 * Poison keep paying after the hit. A status-only effect previously scored near
 * zero because its raw payload was empty. This reads the payload as a plan.
 */
function statusValue(
    record: Record<string, unknown>,
    context: AiDecisionContext,
    targets: readonly CombatUnit[],
): number {
    const status = normalizeStatus(record.status_effect);
    if (!status) return 0;

    const turns = horizonTurns(context, readDotTurns(record.turns));
    const duration = clamp(turns / DEFAULT_DOT_TURNS, 0.5, 1.5);
    const applyTo = typeof record.apply_to === 'string' ? record.apply_to : '';
    const supportiveTarget = applyTo === 'self' || applyTo.startsWith('allies');

    let base = statusBaseValue(status, supportiveTarget);
    if (base <= 0) return 0;

    // A status that carries a payload the loop already priced (a stat buff, a
    // DoT, a shield) must not also be paid for by its name: Battle Fury was
    // counted once as "+18 attack for three turns" and once again as a named
    // buff, which alone made it worth sixty times an attack. The name value is
    // for bare statuses — Wet, Mud, Freezing — whose worth is the plan, not the
    // numbers.
    if (!hasNamedValue(status) && hasRatedPayload(record)) return 0;

    // A resisted application is a real signal that this target is a bad plan;
    // the recent log is the only place that information survives.
    const resisted = (context.history?.recentEvents ?? []).filter((event) => (
        event.type === 'effect_resisted' && normalizeStatus(event.statusEffect) === status
    )).length;
    if (resisted > 0) base /= 1 + resisted * 0.5;

    // Setup is worth more when a living ally can cash it in, either through a
    // payoff trait or through the status's own element modulation.
    const synergy = teamSynergy(context, status) + modulationSynergy(context, record, targets);
    return clamp(base * duration + synergy, 0, 0.9);
}

const OFFENSIVE_STATUS_VALUE: Record<string, number> = {
    wet: 0.32,
    mud: 0.3,
    'mud seal': 0.3,
    'buried in mud': 0.38,
    freezing: 0.36,
    frozen: 0.65,
    burn: 0.4,
    burning: 0.4,
    overheat: 0.35,
    poison: 0.35,
    bleed: 0.3,
    slow: 0.22,
    weakness: 0.22,
    silence: 0.5,
    stun: 0.7,
    daze: 0.45,
    blind: 0.35,
    fear: 0.35,
};

const SUPPORTIVE_STATUS_VALUE: Record<string, number> = {
    regen: 0.24,
    regeneration: 0.24,
    fortify: 0.24,
    fortified: 0.24,
    shield: 0.26,
    shielded: 0.26,
    haste: 0.24,
    evasion: 0.24,
    barrier: 0.26,
};

function statusBaseValue(status: string, supportiveTarget: boolean): number {
    const offensive = OFFENSIVE_STATUS_VALUE[status];
    if (offensive !== undefined) return offensive;
    const supportive = SUPPORTIVE_STATUS_VALUE[status];
    if (supportive !== undefined) return supportive;
    return supportiveTarget ? 0.18 : 0.08;
}

/** Whether the status has a curated setup value of its own. */
function hasNamedValue(status: string): boolean {
    return OFFENSIVE_STATUS_VALUE[status] !== undefined || SUPPORTIVE_STATUS_VALUE[status] !== undefined;
}

/** Whether the effect carries numbers the payload loop already converts to a score. */
function hasRatedPayload(record: Record<string, unknown>): boolean {
    return readNumber(record.damage_per_turn, 0) > 0
        || magnitude(readStatDelta(record.buff)) > 0
        || magnitude(readStatDelta(record.debuff)) > 0
        || multiplierMagnitude(record.stat_multipliers) > 0
        || hasEntries(record.shield)
        || hasEntries(record.barrier)
        || hasEntries(record.heal)
        || hasEntries(record.heal_percent_of_max)
        || hasEntries(record.regen_per_turn)
        || hasEntries(record.regen_per_turn_percent)
        || hasEntries(record.resource_regen)
        || hasEntries(record.resource_drain)
        || hasEntries(record.cleanse);
}

/**
 * One-ply setup value: how much an allied action gains once this status lands.
 * It does not simulate the follow-up, it only prices the known bonus traits.
 */
function teamSynergy(context: AiDecisionContext, status: string): number {
    let score = 0;
    const allies = context.state.units.filter((unit) => (
        unit.side === context.actor.side && unit.status === 'alive'
    ));

    for (const ally of allies) {
        for (const action of ally.actions) {
            for (const bonus of action.bonusVsStatus ?? []) {
                if (normalizeStatus(bonus.status) !== status) continue;
                score += clamp(((bonus.multiplier - 1) * action.power) / 100, 0, 0.2);
            }
            if (normalizeStatus(action.bonusPerCharge?.status) === status) score += 0.08;
            if (normalizeStatus(action.guaranteedCritVsStatus) === status) score += 0.08;
            if (action.consumeStacks?.some((entry) => normalizeStatus(entry.status) === status)) {
                score += 0.06;
            }
        }
    }

    return clamp(score, 0, 0.3);
}

/**
 * What the status's own `element_modulation` table is worth to this side's kit.
 *
 * Wet is the clearest case: its payload quarters ignis and doubles aqua and
 * chaos. That knowledge is data, not a rule — the effect carries the table — so
 * instead of hardcoding it this reads every element the status boosts and prices
 * it against the heaviest hit the side owns in that element, measured against the
 * target's health bar. A kit with a chaos nuke therefore values Wet far more than
 * a kit of fireballs, and a boosted element the side never casts pays nothing.
 *
 * The extra damage is discounted rather than paid in full: the follow-up still
 * costs a turn and may never land, so a doubled nuke is worth a fraction of the
 * bar it would add.
 */
function modulationSynergy(
    context: AiDecisionContext,
    record: Record<string, unknown>,
    targets: readonly CombatUnit[],
): number {
    const modulation = asRecord(record.element_modulation);
    if (!modulation || targets.length === 0) return 0;

    const side = context.actor.side;
    const attackers = context.state.units.filter((unit) => unit.side === side && unit.status === 'alive');
    let best = 0;

    for (const [element, rawMultiplier] of Object.entries(modulation)) {
        const multiplier = readNumber(rawMultiplier, 1);
        if (multiplier <= 1) continue;

        for (const attacker of attackers) {
            for (const action of attacker.actions) {
                if (!action.dealsDamage || action.elementId !== element) continue;
                for (const target of targets) {
                    const maxHp = Math.max(1, effectiveStats(target).maxHp);
                    const gain = ((multiplier - 1) * expectedDamageFor(context, action, target)) / maxHp;
                    if (gain > best) best = gain;
                }
            }
        }
    }

    return clamp(best * 2.5, 0, 0.4);
}

function normalizeStatus(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ');
    return normalized.length > 0 ? normalized : null;
}

/** Sum of a stat delta's absolute magnitudes. */
function magnitude(delta: Record<string, number> | null): number {
    if (!delta) return 0;
    let total = 0;
    for (const value of Object.values(delta)) total += Math.abs(value);
    return total;
}

/** Sum of how far each stat multiplier sits from `1`. */
function multiplierMagnitude(raw: unknown): number {
    const delta = readStatDelta(raw);
    if (!delta) return 0;
    let total = 0;
    for (const value of Object.values(delta)) total += Math.abs(value - 1);
    return total;
}

/** Authored stat keys to the field of `CombatStats` that carries the base value. */
const STAT_BASE: Record<string, keyof ReturnType<typeof effectiveStats>> = {
    physical_attack: 'physicalAttack',
    magical_attack: 'magicalAttack',
    physical_defense: 'physicalDefense',
    magical_defense: 'magicalDefense',
    speed: 'speed',
    accuracy: 'accuracy',
    evasion: 'evasion',
};

/**
 * What a stat change is worth over its duration, in decisive hits.
 *
 * A buff used to be priced as "points added, divided by a 40-point reference",
 * which made `+10 attack for three turns` worth 0.45 - thirty times a real hit,
 * and more than twice the whole of a fresh attack's score. Three units then spent
 * an entire fight re-applying their own buffs, which is exactly what the player
 * saw. Points only mean something relative to the unit that carries them, so the
 * value is the share of its own stat a buff adds, times the turns it lasts: a
 * +10% attack buff for three turns is three tenths of an extra hit's worth of
 * damage, not a third of a health bar.
 *
 * A debuff only counts when it lands on the other side. On the caster's own
 * side it is the price of the buff, and paying it as if it were a gain is what
 * made a bruiser's `granite_hide` (a `speed: -6` tax on himself) look like a
 * third buff.
 */
function statValue(
    context: AiDecisionContext,
    record: Record<string, unknown>,
    targets: readonly CombatUnit[],
    turns: number,
): number {
    const bearer = targets[0] ?? context.actor;
    const stats = effectiveStats(bearer);

    let share = statShare(readStatDelta(record.buff), stats);
    // A debuff that lands on the caster's own side is a cost, not a gain. The
    // `granite_hide` a bruiser casts on himself pays a `speed: -6` as if it
    // were a benefit, which made the weakest buff in the kit score three times
    // its worth and kept the AI decorating itself instead of fighting. A
    // debuff on an enemy is still worth its share.
    if (bearer.side !== context.actor.side) {
        share += statShare(readStatDelta(record.debuff), stats);
    }
    share += multiplierMagnitude(record.stat_multipliers);

    return clamp(share * turns * AI_STAT_TURN_VALUE, 0, AI_STAT_EFFECT_CAP);
}

/**
 * Sum of `|delta| / base` over a stat block.
 *
 * A stat the damage chain does not expose falls back to `AI_EFFECT_REFERENCE`,
 * which keeps an authored rarity worth something instead of dropping to zero.
 */
function statShare(
    delta: Record<string, number> | null,
    stats: ReturnType<typeof effectiveStats>,
): number {
    if (!delta) return 0;
    let share = 0;
    for (const [key, value] of Object.entries(delta)) {
        const field = STAT_BASE[key];
        const base = field ? readNumber(stats[field], 0) : 0;
        share += Math.abs(value) / Math.max(base > 0 ? base : AI_EFFECT_REFERENCE, 1);
    }
    return share;
}

/** A shield is worth the share of max HP it can absorb. */
function shieldValue(raw: unknown): number {
    const shield = asRecord(raw);
    if (!shield) return 0;

    const percent = readNumber(shield.percent_of_max_hp, 0);
    if (percent > 0) {
        return clamp(percent / 100 / AI_HEAL_REFERENCE_FRACTION, 0, 1) * 0.8;
    }
    return hasEntries(raw) ? 0.2 : 0;
}

/** Cleansing is worth more when the candidate's targets actually carry afflictions. */
function cleanseValue(record: Record<string, unknown>, negativeStatuses: number): number {
    let score = 0;
    if (hasEntries(record.cleanse) || record.cleanse_all === true) {
        score += clamp(negativeStatuses / 3, 0, 1) * 0.6;
    }
    if (record.dispel === true || record.dispel_all === true || record.dispel_status) {
        score += 0.2;
    }
    if (record.cleanse_per_turn) score += 0.2;
    if (record.cleanse_dot === true) score += 0.15;
    return score;
}

/** Control and turn-order payload. */
function controlValue(record: Record<string, unknown>): number {
    let score = 0;

    if (record.confuse === true) {
        score += 0.1 + 0.2 * readChance(record.confusion_chance, 1);
    }
    if (record.locks_target === true) score += 0.15;
    if (hasEntries(record.move)) score += 0.15;
    if (hasEntries(record.turn_postpone)) score += 0.3;
    if (hasEntries(record.suspend)) score += 0.3;
    if (hasEntries(record.anchor)) score += 0.15;
    if (hasEntries(record.gravity_zone)) score += 0.2;
    if (hasEntries(record.rift_mark)) score += 0.15;
    if (hasEntries(record.next_action_bonus)) score += 0.2;
    if (record.cooldown_tick) score += 0.15;
    if (record.turn_offset) score += 0.15;
    if (hasEntries(record.fatigue_recovery_delay)) score += 0.1;

    return score;
}

/**
 * How much a protection is worth on the unit that would receive it.
 *
 * A barrier on an ally nobody is attacking is a wasted turn; the same barrier
 * on an ally that is about to lose half its bar is the turn that decides the
 * fight. The multiplier reads the projected damage that ally would take this
 * round, plus how much of its bar is already gone, and stays bounded so a
 * wall can never outscore a kill.
 */
function protectionNeed(context: AiDecisionContext, targets: readonly CombatUnit[]): number {
    let need = 0;
    for (const target of targets) {
        const maxHp = Math.max(1, effectiveStats(target).maxHp);
        const incoming = clamp(estimateThreatAgainst(context, target) / maxHp, 0, 1.5);
        const missing = 1 - clamp(target.currentHp / maxHp, 0, 1);
        need = Math.max(need, incoming * (0.6 + 0.8 * missing));
    }
    return clamp(0.35 + need * 1.1, 0.35, 1.9);
}

/** Elements a protective payload guards against. */
function coveredElements(record: Record<string, unknown>): string[] {
    const elements = new Set<string>();
    const collect = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const entry of value) {
                const element = typeof entry === 'string' ? entry : null;
                if (element) elements.add(element.toLowerCase());
            }
            return;
        }
        for (const key of Object.keys(asRecord(value) ?? {})) elements.add(key.toLowerCase());
    };
    collect(record.prevent_elements);
    collect(record.element_modulation);
    return [...elements];
}

/**
 * The threat the target is actually facing: the heaviest expected hit from the
 * other side, its element, and how hard that element lands on this target.
 */
function strongestIncoming(
    context: AiDecisionContext,
    target: CombatUnit,
): { elementId: string; damage: number; multiplier: number } | null {
    const attackers = context.state.units.filter((unit) => unit.side !== target.side && unit.status === 'alive');
    let best: { elementId: string; damage: number; multiplier: number } | null = null;
    for (const attacker of attackers) {
        for (const action of attacker.actions) {
            if (!action.dealsDamage) continue;
            const damage = expectedDamageFor(context, action, target);
            if (damage <= 0) continue;
            if (!best || damage > best.damage) {
                const multiplier = impactFor(context, action, target)?.elementMultiplier ?? 1;
                best = { elementId: action.elementId, damage, multiplier };
            }
        }
    }
    return best;
}

/**
 * Bonus for a protection whose element actually covers the weakness.
 *
 * This is the "Stone Wall on the ally who is about to eat the element they are
 * weak to" case: the payload is the same, the timing is what makes it a plan.
 */
function protectionCoverage(
    context: AiDecisionContext,
    record: Record<string, unknown>,
    targets: readonly CombatUnit[],
): number {
    const covered = coveredElements(record);
    if (covered.length === 0) return 0;

    let bonus = 0;
    for (const target of targets) {
        const incoming = strongestIncoming(context, target);
        if (!incoming || incoming.multiplier <= 1) continue;
        if (!covered.includes(incoming.elementId.toLowerCase())) continue;
        bonus = Math.max(bonus, clamp((incoming.multiplier - 1) * 0.45, 0, 0.5));
    }
    return bonus;
}

/** Defensive payload and target-denial tools. */
function protectionValue(record: Record<string, unknown>): number {
    let score = 0;

    if (hasEntries(record.barrier)) score += 0.35;
    if (record.taunt === true) score += 0.3;
    if (hasEntries(record.intercept)) score += 0.25;
    if (hasEntries(record.damage_redirect)) score += 0.3;
    if (record.counter === true) score += 0.2;
    if (hasEntries(record.reflect)) score += 0.2;
    if (record.evade_next === true) score += 0.15;
    if (record.untargetable === true) score += 0.3;
    if (record.movement_immunity === true) score += 0.15;
    if (hasEntries(record.damage_immunities)) score += 0.2;
    if (hasEntries(record.status_immunities)) score += 0.1;
    if (record.damage_reduction !== undefined) {
        score += readChance(record.damage_reduction, 0) * 0.5;
    }
    if (hasEntries(record.cost_multiplier)) score += 0.15;
    if (hasEntries(record.end_cost)) score += 0.1;

    return score;
}

/** Resource denial and non-health resource support (health is handled by healing). */
function resourceValue(
    record: Record<string, unknown>,
    referenceMana: number,
    referenceStamina: number,
): number {
    let score = 0;

    const drain = readStatDelta(record.resource_drain);
    if (drain) {
        const denied = Math.abs(drain.mana ?? 0) / referenceMana
            + Math.abs(drain.stamina ?? 0) / referenceStamina;
        score += clamp(denied, 0, 1) * 0.25;
    }

    const regen = readStatDelta(record.resource_regen);
    if (regen) {
        const gained = Math.max(0, regen.mana ?? 0) / referenceMana
            + Math.max(0, regen.stamina ?? 0) / referenceStamina;
        score += clamp(gained, 0, 1) * 0.2;
    }

    const regenPercent = readStatDelta(record.regen_per_turn_percent);
    if (regenPercent) {
        const gained = Math.max(0, regenPercent.mana ?? 0) / 100
            + Math.max(0, regenPercent.stamina ?? 0) / 100;
        score += clamp(gained, 0, 1) * 0.2;
    }

    const transfer = asRecord(record.resource_transfer);
    if (transfer && transfer.resource !== 'hp') score += 0.15;
    if (record.spend_steal === true) score += 0.15;

    return score;
}

/** Delayed detonations, marks, stack payoffs, and on-kill rewards. */
function payoffValue(
    record: Record<string, unknown>,
    referenceHp: number,
): number {
    let score = 0;

    if (hasEntries(record.on_death_blast)) score += 0.2;
    if (hasEntries(record.detonate_on_turn)) score += 0.15;
    if (record.chain_detonation === true) score += 0.2;
    if (record.conductor === true) score += 0.2;
    if (hasEntries(record.charges)) score += 0.2;
    if (hasEntries(record.burst)) score += 0.2;
    if (hasEntries(record.burst_at)) score += 0.15;
    if (record.weather) score += 0.2;
    if (hasEntries(record.element_modulation)) score += 0.15;
    if (record.element_power) score += 0.1;
    if (record.ignite_on_hit === true || record.ignite_attacker_on_hit === true) score += 0.1;
    if (hasEntries(record.fire_wall)) score += 0.2;
    if (record.projectile_mark === true) score += 0.1;

    const drainFraction = readNumber(record.drain_percent_of_damage, 0);
    if (drainFraction > 0) score += clamp(drainFraction * 2, 0, 0.4);

    const healOnKill = readNumber(record.heal_on_kill, 0);
    const healOnKillPercent = readNumber(record.heal_on_kill_percent, 0);
    if (healOnKill > 0 || healOnKillPercent > 0) {
        const healed = healOnKill + (healOnKillPercent / 100) * referenceHp;
        score += clamp(healed / referenceHp / AI_HEAL_REFERENCE_FRACTION, 0, 1) * 0.2;
    }

    // An upkeep or self-damage clause makes the payload less attractive.
    if (hasEntries(record.self_upkeep)) score -= 0.1;
    if (hasEntries(record.deferred_cost)) score -= 0.1;
    if (readNumber(record.self_damage_per_target, 0) > 0) score -= 0.15;

    return Math.max(0, score);
}

/** Whether a nested clause is present and non-empty. */
function hasEntries(value: unknown): boolean {
    if (value === true) return true;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.length > 0;
    const record = asRecord(value);
    if (!record) return false;
    return Object.keys(record).length > 0;
}

/** Turns a `damage_per_turn` duration, tolerating a `[min, max]` pair. */
function readDotTurns(raw: unknown): number {
    if (Array.isArray(raw)) {
        const values = raw.map((entry) => readNumber(entry, Number.NaN)).filter(Number.isFinite);
        if (values.length > 0) return Math.max(...values);
    }
    return Math.max(1, readNumber(raw, DEFAULT_DOT_TURNS));
}

/**
 * How many of an effect's turns the fight is expected to last.
 *
 * A three-turn Burn only pays for three turns if the fight lasts that long. The
 * situational horizon shortens the payoff when the fight is about to end, so a
 * slow setup is not overvalued in a fight that is already decided. Without a
 * snapshot (manual contexts, tests) the authored duration is used untouched.
 */
function horizonTurns(context: AiDecisionContext, turns: number): number {
    const horizon = context.situation?.horizon.roundsToFinish;
    if (horizon === undefined || !Number.isFinite(horizon)) return turns;
    return Math.max(AI_HORIZON_TURN_FLOOR, Math.min(turns, horizon));
}
