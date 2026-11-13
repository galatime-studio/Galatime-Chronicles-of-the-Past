/**
 * The decision pipeline.
 *
 * `candidates → score → choose`, in that order, with each step a separate module
 * so the whole thing stays a pure function of the decision context:
 *
 * 1. {@link buildAiCandidates} expands the legal actions into *(action × target)*
 *    pairs (the service already validated every rule);
 * 2. the board is snapshotted once ({@link buildAiSituation}) and the profile's
 *    weights are scaled by it ({@link modulateAiWeights});
 * 3. each pair is scored as `Σ (weight × consideration)`, then biased by the
 *    profile's `prefer`/`avoid` lists;
 * 4. the difficulty blurs, widens or randomises the choice;
 * 5. a `defend` brace is the floor when nothing is legal.
 *
 * Nothing here writes to the state — the caller submits the request through the
 * same path a player does.
 */

import { AI_PLANNER_TOP_K, AI_PLANNER_WEIGHT } from '../../../constants/AiConstants';
import type { AiCandidate, AiConsiderationId, AiDecisionContext } from '../../../types/AiType';
import type { AiSituation } from '../../../types/AiSituationType';
import type { CombatActionRequest } from '../../../types/CombatType';
import { clamp } from '../../../utils/combatUtils';
import { buildAiCandidates } from './aiCandidates';
import { tacticalPlanBonus } from './aiPlanner';
import { buildAiSituation } from './aiSituation';
import { targetBias } from './aiTargeting';
import { modulateAiWeights, type AiWeightModulation } from './aiWeightModulation';
import { AI_CONSIDERATIONS } from './considerations';

/** One scored candidate, kept for logging. */
export interface AiScoredCandidate {
    key: string;
    actionId: string;
    targetId: string | null;
    score: number;
    /** The two-ply setup bonus, when the candidate was worth planning. */
    planner?: number;
    /** The `[0, 1]` each active consideration gave it. */
    considerations: Partial<Record<AiConsiderationId, number>>;
}

/** What the decider chose, plus the ranking behind it. */
export interface AiDecision {
    /** `null` only when the unit has nothing legal to do (a stall). */
    request: CombatActionRequest | null;
    /** Every candidate, best first. */
    ranking: AiScoredCandidate[];
    /** The situational snapshot the decision was scored against. */
    situation?: AiSituation;
    /** The situational weight scaling applied before scoring. */
    modulation?: AiWeightModulation;
}

/** Internal candidate + score, before the public projection. */
interface Scored {
    candidate: AiCandidate;
    score: number;
    planner?: number;
    considerations: Partial<Record<AiConsiderationId, number>>;
}

/**
 * Picks the next action for a unit nobody plays.
 *
 * The board is snapshotted once per decision: the situational weights are
 * derived from it and the considerations read it through `context.situation`.
 * The copy is local to this call, so the caller's context is never written.
 */
export function decideCombatAction(context: AiDecisionContext): AiDecision {
    const candidates = buildAiCandidates(context);
    if (candidates.length === 0) {
        return { request: braceFallback(context), ranking: [] };
    }

    const working: AiDecisionContext = { ...context };
    const situation = buildAiSituation(working);
    working.situation = situation;
    const modulation = modulateAiWeights(working.profile.weights, situation);

    const scored = candidates.map((candidate) => (
        scoreCandidate(working, candidate, modulation.weights)
    ));
    scored.sort((a, b) => b.score - a.score || a.candidate.key.localeCompare(b.candidate.key));

    const planned = applyTacticalPlanning(working, scored);
    planned.sort((a, b) => b.score - a.score || a.candidate.key.localeCompare(b.candidate.key));

    const chosen = pickWithDifficulty(working, planned);
    return {
        request: toRequest(chosen.candidate),
        ranking: planned.map(toRanking),
        situation,
        modulation,
    };
}

/** `Σ (weight × consideration)`, then the target bias. */
function scoreCandidate(
    context: AiDecisionContext,
    candidate: AiCandidate,
    weights: Readonly<Record<AiConsiderationId, number>>,
): Scored {
    const { tuning } = context;
    const considerations: Partial<Record<AiConsiderationId, number>> = {};
    let total = 0;

    for (const id of Object.keys(weights) as AiConsiderationId[]) {
        if (tuning.disabled.includes(id)) continue;

        const weight = weights[id];
        if (weight === 0) continue;

        const consideration = AI_CONSIDERATIONS[id];
        if (!consideration) continue;

        const value = clamp(consideration.evaluate(context, candidate), 0, 1);
        considerations[id] = value;
        total += weight * value;
    }

    total *= targetBias(context, candidate);
    total *= repetitionPenalty(context, candidate);
    return { candidate, score: total, considerations };
}

/**
 * Adds the two-ply setup bonus to the best few candidates.
 *
 * Planning is intentionally bounded: it only looks at the top Utility
 * candidates, and only those that actually apply an effect will spend time in
 * the planner. The rest keep their one-ply score, so the behaviour stays
 * explainable and cheap.
 */
function applyTacticalPlanning(
    context: AiDecisionContext,
    scored: readonly Scored[],
): Scored[] {
    const planned = scored.slice(0, AI_PLANNER_TOP_K).map((entry) => {
        const bonus = tacticalPlanBonus(context, entry.candidate);
        if (bonus <= 0) return entry;
        return {
            ...entry,
            planner: bonus,
            score: entry.score + bonus * AI_PLANNER_WEIGHT,
        };
    });

    return [...planned, ...scored.slice(AI_PLANNER_TOP_K)];
}

/**
 * A small penalty for repeating the same skill turn after turn.
 *
 * The Utility score is otherwise memoryless: a long-cooldown setup that just
 * fizzled looks exactly as good as one that has not been tried. The recent log
 * provides the missing context. Only offensive skills are penalised; universal
 * moves (defend, rest, switch_line) and basic weapon attacks remain available as
 * the stable fallback.
 */
function repetitionPenalty(context: AiDecisionContext, candidate: AiCandidate): number {
    if (candidate.action.kind !== 'skill') return 1;

    const recent = context.history?.recentEvents ?? [];
    let repeats = 0;
    for (let index = recent.length - 1; index >= 0; index -= 1) {
        const event = recent[index];
        if (event.type !== 'action_used' || event.actorId !== context.actor.id) continue;
        if (event.actionId !== candidate.action.id) break;
        repeats += 1;
    }

    return 1 - Math.min(0.3, repeats * 0.15);
}

/**
 * Applies the difficulty to the ranking.
 *
 * `targetNoise` occasionally ignores the read entirely (an easy unit acting on a
 * whim); otherwise `noise` blurs the scores and `topK` widens the pick to the
 * top candidates. With `noise: 0` and `topK: 1` the best candidate always wins,
 * so `hard`/`hardcore` are fully deterministic.
 */
function pickWithDifficulty(context: AiDecisionContext, scored: readonly Scored[]): Scored {
    const { tuning, random } = context;

    if (tuning.targetNoise > 0 && random() < tuning.targetNoise) {
        const index = Math.floor(random() * scored.length);
        return scored[Math.min(index, scored.length - 1)];
    }

    if (tuning.noise <= 0 && tuning.topK <= 1) return scored[0];

    const noisy = scored.map((entry) => ({
        entry,
        score: entry.score + (random() * 2 - 1) * tuning.noise,
    }));
    noisy.sort((a, b) => b.score - a.score || a.entry.candidate.key.localeCompare(b.entry.candidate.key));

    const topK = Math.max(1, Math.min(tuning.topK, noisy.length));
    const index = topK > 1 ? Math.floor(random() * topK) : 0;
    return noisy[Math.min(index, topK - 1)].entry;
}

/** The request the service accepts. */
function toRequest(candidate: AiCandidate): CombatActionRequest {
    const request: CombatActionRequest = { actionId: candidate.action.id };
    if (candidate.itemId) request.itemId = candidate.itemId;
    if (candidate.targetId) request.targetId = candidate.targetId;
    return request;
}

/**
 * The floor: brace when nothing scored.
 *
 * `defend` is normally a candidate itself, so this only fires for a unit whose
 * every action is unusable except the brace. Returns `null` when even that is not
 * available, which the caller reports as a stall.
 */
function braceFallback(context: AiDecisionContext): CombatActionRequest | null {
    const brace = context.previews.find(
        (preview) => preview.usable && preview.action.kind === 'defend',
    );
    return brace ? { actionId: brace.action.id } : null;
}

/** The public projection of a scored candidate. */
function toRanking(entry: Scored): AiScoredCandidate {
    return {
        key: entry.candidate.key,
        actionId: entry.candidate.action.id,
        targetId: entry.candidate.targetId,
        score: entry.score,
        ...(entry.planner === undefined ? {} : { planner: entry.planner }),
        considerations: entry.considerations,
    };
}
