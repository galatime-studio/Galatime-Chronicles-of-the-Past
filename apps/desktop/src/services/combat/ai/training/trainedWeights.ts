import type { AiConsiderationId } from '@/types/AiType';

/**
 * Vector produced by `weightOptimizer` when the situational layer is active.
 *
 * Provenance matters more than the numbers: this is one CEM run against the authored
 * Utility AI, not a tuned shipping default. `DEFAULT_AI_WEIGHTS` stays authored because a
 * trained base near zero cannot be revived by `modulateAiWeights` (multiplication), which
 * would silently switch the horizon-aware planning off.
 *
 * Reproduce with:
 * `AI_TRAINING_OPTIMIZE=1 AI_TRAINING_OPTIMIZE_OPPONENT=utility AI_TRAINING_OPTIMIZE_SEED=galatime-optimizer-v1`
 * on `__tests__/aiWeightOptimizer.test.ts`.
 */
export const TRAINED_AI_WEIGHTS: Record<AiConsiderationId, number> = {
    expected_damage: 1.299,
    kill_secure: 2.84,
    element_edge: 0.135,
    effect_value: 0.156,
    survival: 0.376,
    flee: 0,
    heal_ally: 1.492,
    heal_self: 1.397,
    defend: 0.611,
    rest: 0.557,
    reposition: 0.265,
    resource_guard: 0.044,
    resource_share: 1.005,
    item: 0.915,
};

/** How `TRAINED_AI_WEIGHTS` was produced and what it scored. */
export const TRAINED_AI_WEIGHTS_META = {
    generated: '2026-11-13T10:32:10.807Z',
    seed: 'galatime-optimizer-v1',
    opponent: 'utility',
    difficulty: 'hard',
    scenarios: { train: 20, validation: 8, test: 8 },
    cem: { population: 14, generations: 10, elite: 5, repetitions: 1 },
    situationalLayer: true,
    winRate: { baseline: 0.075, validation: 0.5, test: 0.375 },
    trainWinRate: 0.55,
    stalls: 0,
    selectedTrainFitness: 0.6635,
} as const;
