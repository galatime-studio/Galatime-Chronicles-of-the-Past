/**
 * How much a heal is worth.
 *
 * Shared by the `heal_ally` and `heal_self` considerations so triage is judged
 * the same way for both: a mend matters when the target is actually missing
 * health and the heal covers a meaningful share of it.
 *
 * The estimate reads the whole healing language, not just the flat `heal` the
 * combat preview exposes: percent-of-max heals, resource regeneration, per-turn
 * regeneration and HP transfers all count. This is what makes a regeneration or
 * shield-adjacent support action visible to the Utility AI.
 */

import { AI_HEAL_REFERENCE_FRACTION } from '../../../constants/AiConstants';
import type { AiDecisionContext } from '../../../types/AiType';
import type { CombatAction, CombatUnit } from '../../../types/CombatType';
import {
    asRecord,
    clamp,
    readNumber,
    readStatDelta,
    readString,
} from '../../../utils/combatUtils';
import { effectiveStats, resolveEffectTargets, unitHpFraction } from '../effectResolver';

/** Authored durations without a number default to a short three-turn effect. */
const DEFAULT_EFFECT_TURNS = 3;

/**
 * A `[0, 1]` value for healing `target`: the fraction of its health it is
 * missing, scaled by how completely the heal covers it.
 *
 * A heal worth {@link AI_HEAL_REFERENCE_FRACTION} of the target's max HP (or
 * more) counts as a full mend; a target at full health scores `0`.
 */
export function healScore(
    context: AiDecisionContext,
    action: CombatAction,
    target: CombatUnit,
): number {
    if (!action.heals) return 0;

    const maxHp = effectiveStats(target).maxHp;
    if (maxHp <= 0) return 0;

    const missing = 1 - unitHpFraction(target);
    if (missing <= 0) return 0;

    const healed = estimateHealing(action, context.actor, target, context.state.units);
    if (healed <= 0) return 0;

    const coverage = clamp(healed / (maxHp * AI_HEAL_REFERENCE_FRACTION), 0, 1);
    return missing * coverage;
}

/** Total health the action is expected to restore to `target`, over its duration. */
export function estimateHealing(
    action: CombatAction,
    actor: CombatUnit,
    target: CombatUnit,
    units: readonly CombatUnit[],
): number {
    const maxHp = effectiveStats(target).maxHp;
    if (maxHp <= 0) return 0;

    let total = 0;
    for (const effect of action.effects) {
        const record = asRecord(effect);
        if (!record) continue;

        const scope = resolveEffectTargets(
            readString(record.apply_to, '') || null,
            actor,
            target,
            units,
        );
        if (!scope.some((unit) => unit.id === target.id)) continue;

        const turns = effectTurns(record.turns);

        total += readNumber(record.heal, 0);
        total += clamp(readNumber(record.heal_percent_of_max, 0), 0, 100) / 100 * maxHp;

        const regen = readStatDelta(record.regen_per_turn);
        if (regen) total += Math.max(0, regen.hp ?? 0) * turns;

        const regenPercent = readStatDelta(record.regen_per_turn_percent);
        if (regenPercent) {
            total += clamp(regenPercent.hp ?? 0, 0, 100) / 100 * maxHp * turns;
        }

        const resourceRegen = readStatDelta(record.resource_regen);
        if (resourceRegen) total += Math.max(0, resourceRegen.hp ?? 0);

        const resourceRegenPercent = readStatDelta(record.resource_regen_percent_of_max);
        if (resourceRegenPercent) {
            total += clamp(resourceRegenPercent.hp ?? 0, 0, 100) / 100 * maxHp;
        }

        // A random pool has three possible recipients; HP is one of them.
        const randomRegen = asRecord(record.random_resource_regen);
        if (randomRegen) {
            total += clamp(readNumber(randomRegen.percent, 0), 0, 100) / 100 * maxHp / 3;
        }
        const randomRegenPerTurn = asRecord(record.random_resource_regen_per_turn);
        if (randomRegenPerTurn) {
            total += clamp(readNumber(randomRegenPerTurn.percent, 0), 0, 100) / 100
                * maxHp * turns / 3;
        }

        const transfer = asRecord(record.resource_transfer);
        if (transfer && transfer.resource === 'hp') {
            total += Math.max(0, readNumber(transfer.amount, 0));
        }
    }

    return Math.max(0, total);
}

/** Turns a `turns` field, tolerating a `[min, max]` pair. */
function effectTurns(raw: unknown): number {
    if (Array.isArray(raw)) {
        const values = raw.map((entry) => readNumber(entry, Number.NaN)).filter(Number.isFinite);
        if (values.length > 0) return Math.max(...values);
    }
    return Math.max(1, readNumber(raw, DEFAULT_EFFECT_TURNS));
}
