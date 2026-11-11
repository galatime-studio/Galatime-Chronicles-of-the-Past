/** Encodes an observation, obtains thirteen weights, then delegates action selection. */

import type {
    AiPolicyDecision,
    AiPolicyObservation,
    AiWeightPolicy,
    AiWeightVector,
} from '../../../../types/AiTrainingType';
import type { AiWeights } from '../../../../types/AiType';
import { encodeAiObservation } from './stateEncoder';
import { decideWithAiWeights } from './weightAdapter';

export function decideWithAiPolicy(
    observation: AiPolicyObservation,
    policy: AiWeightPolicy,
): AiPolicyDecision {
    const encoded = encodeAiObservation(observation);
    const output = policy.proposeWeights(observation, encoded);
    return {
        ...decideWithAiWeights(observation.context, output),
        encoded,
    };
}

/** Useful for fixed-profile experiments and for proving parity with authored AI. */
export function createFixedWeightPolicy(
    weights: AiWeights | AiWeightVector,
): AiWeightPolicy {
    return { proposeWeights: () => weights };
}
