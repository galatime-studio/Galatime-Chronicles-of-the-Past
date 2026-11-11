/** The only learned-policy seam: weights in, an ordinary Utility-AI decision out. */

import {
    AI_CONSIDERATION_IDS,
    AI_WEIGHT_MAX,
    AI_WEIGHT_MIN,
    AI_WEIGHT_VECTOR_SIZE,
} from '../../../../constants/AiTrainingConstants';
import { DEFAULT_AI_WEIGHTS } from '../../../../constants/AiConstants';
import type {
    AiConsiderationId,
    AiDecisionContext,
    AiWeights,
} from '../../../../types/AiType';
import type {
    AiWeightedDecision,
    AiWeightVector,
} from '../../../../types/AiTrainingType';
import { decideCombatAction } from '../aiDecider';

function assertVectorSchema(): void {
    if (AI_CONSIDERATION_IDS.length !== AI_WEIGHT_VECTOR_SIZE) {
        throw new Error(
            `Utility AI has ${AI_CONSIDERATION_IDS.length} considerations; ` +
            `the training contract expects ${AI_WEIGHT_VECTOR_SIZE}. Update the schema deliberately.`,
        );
    }
}

function assertVectorShape(vector: AiWeightVector): void {
    assertVectorSchema();
    if (vector.length !== AI_WEIGHT_VECTOR_SIZE) {
        throw new RangeError(
            `Expected ${AI_WEIGHT_VECTOR_SIZE} AI weights, received ${vector.length}.`,
        );
    }
}

function readWeight(value: number, id: AiConsiderationId): number {
    if (!Number.isFinite(value)) {
        throw new RangeError(`AI weight "${id}" must be finite; received ${String(value)}.`);
    }
    if (value < AI_WEIGHT_MIN || value > AI_WEIGHT_MAX) {
        throw new RangeError(
            `AI weight "${id}" must be in [${AI_WEIGHT_MIN}, ${AI_WEIGHT_MAX}]; received ${value}.`,
        );
    }
    return value;
}

/** Strict vector conversion: malformed model output fails before it can affect combat. */
export function aiWeightsFromVector(vector: AiWeightVector): Record<AiConsiderationId, number> {
    assertVectorShape(vector);
    const weights = {} as Record<AiConsiderationId, number>;
    AI_CONSIDERATION_IDS.forEach((id, index) => {
        weights[id] = readWeight(vector[index], id);
    });
    return weights;
}

/** Full ordered export for model inspection, datasets and replay logs. */
export function aiWeightsToVector(
    weights: Readonly<Record<AiConsiderationId, number>>,
): AiWeightVector {
    assertVectorSchema();
    return AI_CONSIDERATION_IDS.map((id) => weights[id]);
}

/**
 * Object outputs are convenient for fixed profiles and may be partial. Missing
 * keys inherit the supplied baseline; explicit values obey the same contract as
 * network vectors.
 */
export function resolveAiWeights(
    output: AiWeights | AiWeightVector,
    baseline: Readonly<Record<AiConsiderationId, number>> = DEFAULT_AI_WEIGHTS,
): Record<AiConsiderationId, number> {
    if (Array.isArray(output)) return aiWeightsFromVector(output);

    const resolved = { ...baseline };
    for (const id of AI_CONSIDERATION_IDS) {
        const value = (output as AiWeights)[id];
        if (value !== undefined) resolved[id] = readWeight(value, id);
    }
    return resolved;
}

/**
 * Runs the unmodified candidate builder, considerations, target bias and
 * difficulty selection. Only the profile weights are replaced for this decision.
 */
export function decideWithAiWeights(
    context: AiDecisionContext,
    output: AiWeights | AiWeightVector,
): AiWeightedDecision {
    const weights = resolveAiWeights(output, context.profile.weights);
    const decision = decideCombatAction({
        ...context,
        profile: { ...context.profile, weights },
    });

    return {
        request: decision.request,
        ranking: decision.ranking,
        weights,
        vector: aiWeightsToVector(weights),
    };
}
