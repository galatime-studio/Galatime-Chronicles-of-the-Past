/** Reward shaping from terminal outcomes and paired counterfactual contributions. */

import { AI_REWARD_COEFFICIENTS } from '../../../../constants/AiTrainingConstants';
import type {
    AiCausalSample,
    AiRewardBreakdown,
    AiRewardInput,
} from '../../../../types/AiTrainingType';

const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, value));

function finite(value: number, label: string): number {
    if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
    return value;
}

/**
 * Incremental value in a common unit. The caller must run `actual` and
 * `baseline` from the same state and RNG snapshot; this function cannot prove
 * causal validity from two unrelated combat summaries.
 */
export function causalDelta(sample: AiCausalSample): number {
    finite(sample.actual, `${sample.id}.actual`);
    finite(sample.baseline, `${sample.id}.baseline`);
    finite(sample.reference, `${sample.id}.reference`);
    if (sample.reference <= 0) throw new RangeError(`${sample.id}.reference must be positive.`);
    return clamp((sample.actual - sample.baseline) / sample.reference, -1, 1);
}

export function calculateAiReward(input: AiRewardInput): AiRewardBreakdown {
    const terminal = input.won === null
        ? 0
        : input.won ? AI_REWARD_COEFFICIENTS.win : AI_REWARD_COEFFICIENTS.loss;
    const boundedTurns = clamp(finite(input.turns, 'turns'), 0, Math.max(0, input.maxTurns));
    const turnPenalty = input.perspective === 'enemy'
        ? -boundedTurns * AI_REWARD_COEFFICIENTS.turnPenaltyPerTurn
        : 0;
    const groupDamage = input.perspective === 'enemy'
        ? clamp01(finite(input.groupDamage, 'groupDamage')) * AI_REWARD_COEFFICIENTS.groupDamage
        : 0;

    const totals = { setup: 0, protection: 0, heal: 0, protagonistStatus: 0 };
    if (input.perspective === 'companion') {
        // IDs are unique causal claims: duplicate projections cannot be counted twice.
        const seen = new Set<string>();
        for (const sample of input.causalSamples) {
            if (seen.has(sample.id)) continue;
            seen.add(sample.id);
            const delta = causalDelta(sample);
            if (sample.kind === 'setup') totals.setup += delta;
            if (sample.kind === 'protection') totals.protection += delta;
            if (sample.kind === 'heal') totals.heal += delta;
            if (sample.kind === 'protagonist_status') totals.protagonistStatus += delta;
        }
    }

    const breakdown = {
        terminal,
        groupDamage,
        turnPenalty,
        setup: totals.setup * AI_REWARD_COEFFICIENTS.setup,
        protection: totals.protection * AI_REWARD_COEFFICIENTS.protection,
        heal: totals.heal * AI_REWARD_COEFFICIENTS.heal,
        protagonistStatus: totals.protagonistStatus * AI_REWARD_COEFFICIENTS.protagonistStatus,
    };
    return {
        ...breakdown,
        total: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
    };
}

const clamp01 = (value: number): number => clamp(value, 0, 1);
