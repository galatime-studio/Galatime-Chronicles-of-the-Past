/**
 * Target biases.
 *
 * A profile's `prefer`/`avoid` lists never change what is *legal* — they scale a
 * candidate's score. `avoid` zeroes a target the hit cannot touch (immune, `x0`)
 * or would be punished by (a matching reflect); `prefer` nudges the score towards
 * the targets the profile cares about, without ever making another target
 * impossible to pick.
 *
 * A third bias is implicit and not authored: a damaging action aimed at the
 * actor's own side — or a mend aimed at the enemy — is heavily discounted. The
 * candidate builder drops those aims outright, so this only catches a path that
 * bypasses it (an item action). Without it, a tie between a full-health ally and
 * a full-health enemy would be broken by candidate key, and a unit would happily
 * punch itself.
 *
 * The last bias is also implicit: a single-target attack aimed where the actor's
 * living allies have already committed is discounted, so a party spreads its
 * attention instead of turning every fight into a pile-on. It is a nudge, not a
 * rule — the least-crowded aim keeps its full value, a lethal blow is never
 * discounted, and a lone legal target is always worth attacking.
 */

import {
    AI_PREFERENCE_DISCRIMINATION,
    AI_TARGET_BIAS_FLOOR,
    AI_TARGET_CROWD_FLOOR,
    AI_TARGET_CROWD_PENALTY,
    AI_TARGET_CROWD_WINDOW,
} from '../../../constants/AiConstants';
import type { AiCandidate, AiDecisionContext, AiTargetPreference } from '../../../types/AiType';
import type { AbilityCondition } from '../../../types/AbilityType';
import type { CombatAction, CombatUnit } from '../../../types/CombatType';
import { clamp } from '../../../utils/combatUtils';
import { attackStat, defenseStat } from '../damageCalculator';
import { effectiveStats } from '../effectResolver';
import { candidateTargetUnits } from './aiCandidates';
import { damageShareOfSide } from './aiDamage';
import { actionIntent, isWrongSideTarget } from './aiIntent';
import { impactFor } from './aiImpacts';
import { threatFrom } from './aiThreat';

export { actionIntent } from './aiIntent';

/**
 * How hard a wrong-side target is scaled down (never to zero: it stays legal).
 *
 * The candidate builder already drops these aims, so this only catches what
 * reaches scoring another way (a damaging item, for instance). It is a bias and
 * not a filter on purpose: legality is the engine's business, not the AI's.
 */
const WRONG_SIDE_BIAS = 0.05;

/**
 * The multiplier a candidate's score is scaled by.
 *
 * `0` when every target is avoided, `1` when the profile has no preference, and
 * a value in `[AI_TARGET_BIAS_FLOOR, 1]` when a preference applies. Offensive
 * multi-target actions use the mean bias of the units they land on; a support
 * action uses the best one, because a team mend is only as good as the ally who
 * needs it, not the healthy caster it also lands on.
 */
export function targetBias(context: AiDecisionContext, candidate: AiCandidate): number {
    const targets = candidateTargetUnits(context, candidate);
    if (targets.length === 0) return 1;

    const pool = aimPool(context, candidate);
    const biases = targets.map((target) => (
        biasForTarget(context, candidate.action, target, pool)
    ));

    if (actionIntent(candidate.action) === 'supportive' && biases.length > 1) {
        return Math.max(...biases);
    }

    return biases.reduce((total, bias) => total + bias, 0) / biases.length;
}

/**
 * The legal aims a single-target action was expanded from.
 *
 * `candidate.targetIds` names the units one aim lands on, which for `any_one`
 * is only the chosen target. The preference is a *rank*, so it has to be read
 * against every legal aim: with one aim there is nothing to prefer, and with
 * two identical aims neither should pay for the tie.
 */
function aimPool(context: AiDecisionContext, candidate: AiCandidate): CombatUnit[] {
    if (candidate.action.targeting !== 'any_one' && candidate.action.targeting !== 'enemies_lane') {
        return candidateTargetUnits(context, candidate);
    }

    const preview = context.previews.find(
        (entry) => entry.usable && entry.action.id === candidate.action.id,
    );
    if (!preview) return candidateTargetUnits(context, candidate);

    const byId = new Map(context.state.units.map((unit) => [unit.id, unit]));
    return preview.targetIds
        .map((id) => byId.get(id))
        .filter((unit): unit is CombatUnit => unit !== undefined);
}

function biasForTarget(
    context: AiDecisionContext,
    action: CombatAction,
    target: CombatUnit,
    pool: readonly CombatUnit[],
): number {
    if (isAvoided(context, action, target)) return 0;

    // Universal self-movements (`defend`, `rest`, `switch_line`) name no target,
    // so there is no target choice to bias.
    if (action.targeting === 'self') return 1;

    // A self-buff is not a bad target choice just because the profile prefers
    // wounded allies or dangerous enemies: `any_one` support aimed at the caster
    // must compete on its payload, not on a target-preference penalty.
    if (action.targeting === 'any_one'
        && target.id === context.actor.id
        && actionIntent(action) === 'supportive') {
        return 1;
    }

    const { prefer } = context.profile.targeting;
    let bias = 1;

    if (prefer.length > 0 && pool.length > 0) {
        const scores = pool.map((entry) => rawPreference(context, action, entry));
        const best = Math.max(...scores);
        const worst = Math.min(...scores);
        const spread = best - worst;

        // A preference that separates nobody is not a choice. The separation
        // ramps in with the spread, so two aims a hair apart both stay cheap
        // while a real gap lets the worst aim pay the full floor.
        if (spread > Number.EPSILON) {
            const separation = Math.min(1, spread / AI_PREFERENCE_DISCRIMINATION);
            const rank = (best - rawPreference(context, action, target)) / spread;
            bias = 1 - rank * separation * (1 - AI_TARGET_BIAS_FLOOR);
        }
    }

    if (isWrongSideTarget(context.actor, actionIntent(action), target)) bias *= WRONG_SIDE_BIAS;
    bias *= crowdBias(context, action, target, pool);
    return bias;
}

/**
 * The discount for attacking a target the actor's allies already committed to.
 *
 * Read against the least-crowded legal aim rather than an absolute count: two
 * enemies both under fire are a fair choice, and the unit that happens to act
 * last should not be taxed for the party's opening. A lethal blow keeps its full
 * value so focus fire can still finish a kill, and only offensive single-target
 * actions take part — an AoE that catches the crowd is not a pile-on.
 */
function crowdBias(
    context: AiDecisionContext,
    action: CombatAction,
    target: CombatUnit,
    pool: readonly CombatUnit[],
): number {
    if (action.targeting !== 'any_one' || actionIntent(action) !== 'offensive') return 1;
    if (pool.length <= 1) return 1;

    const history = context.history?.recentEvents;
    if (!history || history.length === 0) return 1;

    // Securing the kill is the one reason to keep hitting the same body.
    if (impactFor(context, action, target).finalDamage >= target.currentHp) return 1;

    const allies = new Set(
        context.state.units
            .filter((unit) => (
                unit.status === 'alive'
                && unit.side === context.actor.side
                && unit.id !== context.actor.id
            ))
            .map((unit) => unit.id),
    );
    if (allies.size === 0) return 1;

    const counts = new Map<string, number>();
    let read = 0;
    for (let index = history.length - 1; index >= 0 && read < AI_TARGET_CROWD_WINDOW; index -= 1) {
        const event = history[index];
        if (event.type !== 'action_used' || !allies.has(event.actorId)) continue;

        read += 1;
        for (const id of new Set(event.targetIds)) {
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
    }
    if (read === 0) return 1;

    const legal = pool.filter((unit) => (
        unit.status === 'alive' && !isAvoided(context, action, unit)
    ));
    if (legal.length <= 1) return 1;

    const countFor = (unit: CombatUnit) => counts.get(unit.id) ?? 0;
    const least = Math.min(...legal.map(countFor));
    const excess = countFor(target) - least;
    if (excess <= 0) return 1;

    return Math.max(AI_TARGET_CROWD_FLOOR, 1 - excess * AI_TARGET_CROWD_PENALTY);
}

/** The strongest authored preference for one target, before pool ranking. */
function rawPreference(
    context: AiDecisionContext,
    action: CombatAction,
    target: CombatUnit,
): number {
    let best = 0;
    for (const preference of context.profile.targeting.prefer) {
        best = Math.max(best, preferenceScore(context, action, target, preference));
    }
    return clamp(best, 0, 1);
}

/** Whether the profile refuses this target for this action. */
function isAvoided(
    context: AiDecisionContext,
    action: CombatAction,
    target: CombatUnit,
): boolean {
    if (!action.dealsDamage) return false;

    const { avoid } = context.profile.targeting;
    if (avoid.includes('immune') && impactFor(context, action, target).finalDamage <= 0) return true;
    if (avoid.includes('reflect') && reflectsAction(target, action)) return true;
    return false;
}

/** How well a target matches one preference, in `[0, 1]`. */
function preferenceScore(
    context: AiDecisionContext,
    action: CombatAction,
    target: CombatUnit,
    preference: AiTargetPreference,
): number {
    switch (preference) {
        case 'weakest': {
            const maxHp = effectiveStats(target).maxHp;
            return maxHp > 0 ? 1 - clamp(target.currentHp / maxHp, 0, 1) : 0;
        }
        case 'squishiest': {
            const attackerStats = effectiveStats(context.actor);
            const attack = Math.max(1, attackStat(attackerStats, action.damageType));
            const defense = defenseStat(effectiveStats(target), action.damageType);
            return clamp(1 - defense / (defense + attack), 0, 1);
        }
        case 'healers':
            return targetHasHeals(target) ? 1 : 0;
        case 'threat': {
            const threat = threatFrom(context, target, context.actor);
            const maxHp = Math.max(1, effectiveStats(target).maxHp);
            return clamp(threat / (threat + maxHp), 0, 1);
        }
        case 'damage':
            // Only an offensive choice reads this: a mend is chosen by
            // `weakest`, not by which ally has hit hardest.
            return actionIntent(action) === 'offensive'
                ? damageShareOfSide(context, target)
                : 0;
        default:
            return 0;
    }
}

/** Whether a target's kit can restore health (a "healer" worth killing first). */
function targetHasHeals(target: CombatUnit): boolean {
    if (target.actions.some((action) => action.heals)) return true;
    return target.abilities.some(({ definition }) => (
        definition.enabled !== false && definition.action.type === 'heal'
    ));
}

/** Whether a target would reflect this action's damage back at the actor. */
function reflectsAction(target: CombatUnit, action: CombatAction): boolean {
    return target.abilities.some(({ definition }) => {
        if (definition.enabled === false) return false;
        if (definition.action.type !== 'reflect_damage') return false;
        return conditionMentionsAction(definition.condition, action);
    });
}

/**
 * Whether a reflect's condition names this action's damage channel or element.
 *
 * An unconditional reflect catches everything; otherwise the `damage`/`element`
 * conditions (nested under `all`/`any`) are matched against the action.
 */
function conditionMentionsAction(
    condition: AbilityCondition | undefined,
    action: CombatAction,
): boolean {
    if (!condition) return true;

    const damageType = condition.damage?.type;
    if (damageType && damageType !== 'any' && damageType !== 'true') {
        return damageType === action.damageType;
    }
    if (condition.element?.id) return condition.element.id === action.elementId;
    if (condition.all) return condition.all.some((entry) => conditionMentionsAction(entry, action));
    if (condition.any) return condition.any.some((entry) => conditionMentionsAction(entry, action));
    if (condition.not) return !conditionMentionsAction(condition.not, action);
    return false;
}
