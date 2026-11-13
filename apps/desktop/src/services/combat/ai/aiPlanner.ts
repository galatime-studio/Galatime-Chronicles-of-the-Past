/**
 * Two-ply tactical planning.
 *
 * The Utility AI scores one action at a time. That is enough for immediate
 * damage and healing, but not for setup: Wet is only worth its cost if somebody
 * actually follows with aqua/chaos, Freezing only matters if the charges fill,
 * and a buff is only good if the buffed unit gets to use it.
 *
 * This module adds a deliberately small, deterministic second ply: for a
 * candidate that applies a status or buff, it asks what the best living ally
 * could do on the next turn against the changed board. It never mutates the
 * real state, never rolls randomness and never submits an action; the decider
 * only adds the resulting bonus to the candidate's existing Utility score.
 *
 * This is not a full combat rollout. It prices the actor's action plus the most
 * valuable immediate follow-up, which is the common combo pattern in the game
 * (Wet → aqua/chaos, Freezing → Frozen, debuff → ally attack, buff → ally turn).
 */

import type { AttackEffect } from '../../../types/AttackDataType';
import type { AiCandidate, AiDecisionContext } from '../../../types/AiType';
import type {
    CombatAction,
    CombatEffectInstance,
    CombatStatDelta,
    CombatUnit,
} from '../../../types/CombatType';
import { asRecord, clamp, readNumber, readStatDelta } from '../../../utils/combatUtils';
import { createStatusEffect, effectiveStats } from '../effectResolver';
import { candidateTargetUnits } from './aiCandidates';
import { expectedDamageFor } from './aiImpacts';

/** The most follow-up actions considered per ally, to keep planning bounded. */
const FOLLOW_UP_ACTION_LIMIT = 4;

/** The most allies considered as follow-up actors. */
const FOLLOW_UP_ALLY_LIMIT = 4;

/** How much one point of a hostile status's per-turn damage is worth. */
const DOT_REFERENCE_FRACTION = 0.35;

/**
 * The planning bonus for one candidate, in `[0, 1]`.
 *
 * A pure damage action scores zero here: its immediate value is already the
 * `expected_damage` consideration. The bonus is reserved for actions whose
 * value depends on a following turn.
 */
export function tacticalPlanBonus(
    context: AiDecisionContext,
    candidate: AiCandidate,
): number {
    if (candidate.itemId || candidate.action.effects.length === 0) return 0;

    const targets = candidateTargetUnits(context, candidate)
        .filter((unit) => unit.status === 'alive');
    if (targets.length === 0) return 0;

    /** A setup is only worth what the fight has time to pay back. */
    const horizon = context.situation?.horizon.roundsToFinish;
    let best = 0;

    for (const target of targets) {
        for (const effect of candidate.action.effects) {
            const virtual = virtualEffect(effect, candidate.action, horizon);
            if (!virtual) continue;

            const allyTarget = target.side === context.actor.side;
            if (allyTarget && !isSupportiveEffect(effect)) continue;
            if (!allyTarget && isSupportiveEffect(effect)) continue;

            const afterTarget = cloneWithEffect(target, virtual);
            const afterUnits = context.state.units.map((unit) => (
                unit.id === target.id ? afterTarget : unit
            ));

            const followUp = followUpDelta(context, target, afterTarget, afterUnits);
            const dot = allyTarget
                ? 0
                : (readNumber(effect.damage_per_turn, 0) * effectTurns(effect, horizon))
                    / Math.max(1, effectiveStats(target).maxHp);
            const control = allyTarget ? 0 : controlValue(effect, virtual);

            const value = followUp
                + clamp(dot / DOT_REFERENCE_FRACTION, 0, 1) * 0.35
                + control;
            if (value > best) best = value;
        }
    }

    const window = clamp(context.situation?.horizon.setupWindow ?? 1, 0.6, 1.4);
    return clamp(best * window, 0, 1);
}

/**
 * The best improvement one ally can get from the changed board, normalised by
 * the affected unit's max HP.
 */
function followUpDelta(
    context: AiDecisionContext,
    beforeTarget: CombatUnit,
    afterTarget: CombatUnit,
    afterUnits: readonly CombatUnit[],
): number {
    const maxHp = Math.max(1, effectiveStats(beforeTarget).maxHp);
    const sameSide = afterTarget.side === context.actor.side;

    const attackers = sameSide
        ? [afterTarget]
        : context.state.units
            .filter((unit) => unit.side === context.actor.side && unit.status === 'alive')
            .slice(0, FOLLOW_UP_ALLY_LIMIT);

    const targets = sameSide
        ? context.state.units.filter((unit) => (
            unit.side !== context.actor.side && unit.status === 'alive'
        ))
        : [beforeTarget];

    let best = 0;
    for (const attacker of attackers) {
        for (const action of attacker.actions
            .filter((entry) => entry.dealsDamage)
            .slice(0, FOLLOW_UP_ACTION_LIMIT)) {

            for (const target of targets) {
                const afterAttacker = afterUnits.find((unit) => unit.id === attacker.id)
                    ?? attacker;
                const afterTargetUnit = afterUnits.find((unit) => unit.id === target.id)
                    ?? target;

                const before = expectedDamageFor(
                    { ...context, actor: attacker },
                    action,
                    target,
                );
                const after = expectedDamageFor(
                    { ...context, actor: afterAttacker, state: { ...context.state, units: [...afterUnits] } },
                    action,
                    afterTargetUnit,
                );

                const delta = (after - before) / maxHp;
                if (delta > best) best = delta;
            }
        }
    }

    return clamp(best, 0, 1);
}

/** Builds a runtime-shaped status for the hypothetical board. */
function virtualEffect(
    effect: AttackEffect,
    action: CombatAction,
    horizon?: number,
): CombatEffectInstance | null {
    const status = typeof effect.status_effect === 'string'
        ? effect.status_effect
        : null;
    const buff = readStatDelta(effect.buff) as CombatStatDelta | null;
    const debuff = readStatDelta(effect.debuff) as CombatStatDelta | null;
    const hasPayload = Boolean(
        status
        || buff
        || debuff
        || readNumber(effect.damage_per_turn, 0) > 0
        || (Array.isArray(effect.prevent_actions) && effect.prevent_actions.length > 0)
        || effect.element_modulation
        || effect.shield
        || effect.taunt
        || effect.barrier,
    );
    if (!hasPayload) return null;

    const instance = createStatusEffect({
        effectId: `planner:${action.id}:${effect.effect_id}`,
        sourceId: action.id,
        statusEffect: status,
        turns: effectTurns(effect, horizon),
        buff,
        debuff,
        polarity: buff && !debuff ? 'positive' : debuff ? 'negative' : 'neutral',
        preventActions: Array.isArray(effect.prevent_actions)
            ? effect.prevent_actions.map(String)
            : null,
        damagePerTurn: readNumber(effect.damage_per_turn, 0),
    });

    instance.elementId = typeof effect.element_id === 'string'
        ? effect.element_id
        : action.elementId;
    instance.applyTo = typeof effect.apply_to === 'string' ? effect.apply_to : null;
    instance.preventSkills = effect.prevent_skills === true;
    instance.untargetable = effect.untargetable === true;
    instance.healBlock = effect.heal_block === true;
    instance.elementModulation = numberMap(effect.element_modulation);

    const shield = asRecord(effect.shield);
    if (shield) {
        instance.shieldPercentOfMaxHp = readNumber(shield.percent_of_max_hp, 0);
    }

    const charges = asRecord(effect.charges);
    if (charges) {
        instance.chargeMax = readNumber(charges.max, 0);
    }

    return instance;
}

function effectTurns(effect: AttackEffect, horizon?: number): number {
    const authored = Array.isArray(effect.turns)
        ? Math.max(1, Math.round((effect.turns[0] + effect.turns[1]) / 2))
        : Math.max(1, readNumber(effect.turns, 3));
    if (horizon === undefined || !Number.isFinite(horizon)) return authored;
    return Math.max(1, Math.min(authored, horizon));
}

function controlValue(effect: AttackEffect, status: CombatEffectInstance): number {
    const statusName = (status.statusEffect ?? '').toLowerCase();
    const prevented = Array.isArray(effect.prevent_actions)
        ? effect.prevent_actions.length
        : 0;

    let value = 0;
    if (prevented > 0) value += 0.18 * Math.min(1, prevented / 2);
    if (status.preventSkills) value += 0.12;
    if (statusName.includes('frozen')) value += 0.3;
    else if (statusName.includes('freez')) value += 0.15;
    if (statusName.includes('stun') || statusName.includes('silence')) value += 0.18;
    return value;
}

function isSupportiveEffect(effect: AttackEffect): boolean {
    return Boolean(
        effect.buff
        || effect.shield
        || effect.taunt
        || effect.barrier
        || effect.heal
        || effect.heal_percent_of_max
        || effect.regen_per_turn
        || effect.cleanse
        || effect.cleanse_per_turn,
    );
}

function cloneWithEffect(
    target: CombatUnit,
    effect: CombatEffectInstance,
): CombatUnit {
    return {
        ...target,
        effects: [...target.effects, effect],
    };
}

function numberMap(value: unknown): Record<string, number> | null {
    const record = asRecord(value);
    if (!record) return null;

    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(record)) {
        const number = readNumber(raw, Number.NaN);
        if (Number.isFinite(number)) out[key] = number;
    }
    return Object.keys(out).length > 0 ? out : null;
}
