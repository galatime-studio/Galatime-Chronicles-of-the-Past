/** Non-learned harness baselines. These selectors are never installed in live combat. */

import type {
    AiCandidate,
} from '../../../../types/AiType';
import type {
    AiHeadlessActionPolicy,
    AiPolicyObservation,
} from '../../../../types/AiTrainingType';
import type { CombatActionRequest } from '../../../../types/CombatType';
import { buildAiCandidates, candidateTargetUnits } from '../aiCandidates';
import { expectedDamageFor } from '../aiImpacts';
import { decideCombatAction } from '../aiDecider';

export function requestFromCandidate(candidate: AiCandidate): CombatActionRequest {
    const request: CombatActionRequest = { actionId: candidate.action.id };
    if (candidate.action.targeting === 'any_one' && candidate.targetId) {
        request.targetId = candidate.targetId;
    }
    return request;
}

/** Uniform over the same legal action×target candidates used by Utility AI. */
export const randomAiPolicy: AiHeadlessActionPolicy = {
    selectAction(observation: AiPolicyObservation) {
        const { context } = observation;
        const candidates = buildAiCandidates(context);
        if (candidates.length === 0) return decideCombatAction(context).request;
        const index = Math.min(
            candidates.length - 1,
            Math.floor(context.random() * candidates.length),
        );
        return requestFromCandidate(candidates[index]);
    },
};

/**
 * Deterministic immediate-damage baseline. Kill potential breaks ties, then the
 * candidate key. It intentionally has no support, resource or positioning model.
 */
export const greedyAiPolicy: AiHeadlessActionPolicy = {
    selectAction(observation: AiPolicyObservation) {
        const { context } = observation;
        const candidates = buildAiCandidates(context);
        if (candidates.length === 0) return decideCombatAction(context).request;

        const scored = candidates.map((candidate) => {
            const targets = candidateTargetUnits(context, candidate);
            const damage = targets.reduce(
                (sum, target) => sum + expectedDamageFor(context, candidate.action, target),
                0,
            );
            const kill = targets.reduce(
                (best, target) => Math.max(
                    best,
                    expectedDamageFor(context, candidate.action, target) / Math.max(1, target.currentHp),
                ),
                0,
            );
            return { candidate, damage, kill };
        });

        scored.sort((left, right) =>
            right.damage - left.damage ||
            right.kill - left.kill ||
            left.candidate.key.localeCompare(right.candidate.key));
        return requestFromCandidate(scored[0].candidate);
    },
};

/** Ordinary authored Utility AI; difficulty remains the one in the context. */
export const utilityAiPolicy: AiHeadlessActionPolicy = {
    selectAction: (observation) => decideCombatAction(observation.context).request,
};
