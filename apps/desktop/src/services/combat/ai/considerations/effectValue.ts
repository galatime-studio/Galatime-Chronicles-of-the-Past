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

import { AI_EFFECT_REFERENCE, AI_HEAL_REFERENCE_FRACTION, AI_HORIZON_TURN_FLOOR } from '../../../../constants/AiConstants';
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
            const duration = clamp(turns / DEFAULT_DOT_TURNS, 0.5, 1.5);

            const damagePerTurn = readNumber(record.damage_per_turn, 0);
            if (damagePerTurn > 0) score += clamp((damagePerTurn * turns) / referenceHp, 0, 1);

            if (Array.isArray(record.prevent_actions) && record.prevent_actions.length > 0) score += 0.8;
            if (record.prevent_skills === true) score += 0.4;
            if (hasEntries(record.prevent_ranges)) score += 0.2;
            if (hasEntries(record.prevent_elements)) score += 0.2;

            score += (magnitude(readStatDelta(record.buff)) * duration) / AI_EFFECT_REFERENCE;
            score += (magnitude(readStatDelta(record.debuff)) * duration) / AI_EFFECT_REFERENCE;
            score += multiplierMagnitude(record.stat_multipliers) / AI_EFFECT_REFERENCE;

            score += shieldValue(record.shield);
            score += cleanseValue(record, negativeStatuses);
            score += controlValue(record);
            score += protectionValue(record) * protectionNeed(context, targets);
            score += protectionCoverage(context, record, targets);
            score += resourceValue(record, referenceMana, referenceStamina);
            score += payoffValue(record, referenceHp);
            score += statusValue(record, context, targets);
        }

        return clamp(score, 0, 1);
    },
};

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

    // Reapplying a status that is already there is usually wasted; charge and
    // stack statuses are the exception, because each application advances them.
    const alreadyCarrying = targets.filter((target) => (
        target.effects.some((effect) => normalizeStatus(effect.statusEffect) === status)
    )).length;
    if (targets.length > 0 && alreadyCarrying === targets.length) {
        const stacking = record.can_stack === true
            || hasEntries(record.charges)
            || status.includes('freez');
        base *= stacking ? 0.6 : 0.15;
    } else if (alreadyCarrying > 0) {
        base *= 0.7;
    }

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
