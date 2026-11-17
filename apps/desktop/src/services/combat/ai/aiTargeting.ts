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
 */

import { AI_PREFERENCE_DISCRIMINATION, AI_TARGET_BIAS_FLOOR } from '../../../constants/AiConstants';
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
 * a value in `[AI_TARGET_BIAS_FLOOR, 1]` when a preference applies. Multi-target
 * actions use the mean bias of the units they land on.
 */
export function targetBias(context: AiDecisionContext, candidate: AiCandidate): number {
    const targets = candidateTargetUnits(context, candidate);
    if (targets.length === 0) return 1;

    const pool = aimPool(context, candidate);
    let total = 0;
    for (const target of targets) total += biasForTarget(context, candidate.action, target, pool);
    return total / targets.length;
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
    return bias;
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
