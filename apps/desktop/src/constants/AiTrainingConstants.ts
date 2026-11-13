/** Offline training defaults. None of these values is read by the live game. */

import { DEFAULT_AI_WEIGHTS } from './AiConstants';
import type { Difficulty } from './DifficultyConstants';
import type { AiConsiderationId, AiStyleId } from '../types/AiType';

/** Stable vector-column order shared by encoders, policies and exported models. */
export const AI_CONSIDERATION_IDS = Object.freeze(
    Object.keys(DEFAULT_AI_WEIGHTS) as AiConsiderationId[],
);

export const AI_WEIGHT_VECTOR_SIZE = 14;
export const AI_WEIGHT_MIN = 0;
export const AI_WEIGHT_MAX = 3;

/**
 * Per-dimension search floors.
 *
 * Without them the CEM reliably drives `effect_value` to ~0.15, and since the
 * situational layer is multiplicative (`modulateAiWeights`) that mutes the only
 * weight carrying the battle horizon. Floors keep every consideration able to
 * influence a decision while leaving real room to search below the authored
 * baseline. Ids absent here keep `AI_WEIGHT_MIN`.
 */
export const AI_WEIGHT_FLOORS: Readonly<Partial<Record<AiConsiderationId, number>>> = Object.freeze({
    expected_damage: 0.7,
    kill_secure: 1.0,
    element_edge: 0.2,
    effect_value: 0.45,
    survival: 0.45,
    heal_ally: 0.6,
    heal_self: 0.6,
    defend: 0.35,
    rest: 0.3,
    reposition: 0.3,
    resource_guard: 0.2,
    resource_share: 0.5,
    item: 0.5,
});

export const AI_HISTORY_TURNS = 5;
export const AI_DEFAULT_TEAM_SIZE = 4;
export const AI_MIN_TEAM_SIZE = 2;
export const AI_MAX_TEAM_SIZE = 5;
/** Leaves room for summons while keeping a fixed tensor shape. */
export const AI_MAX_UNITS_PER_SIDE = 8;
/** Bumped when the observation encoding changes; version 2 adds the `resource_share` consideration. */
export const AI_ENCODING_SCHEMA_VERSION = 2;
export const AI_DEFAULT_MAX_TURNS = 300;

export const AI_TRAINING_DIFFICULTIES: readonly Difficulty[] = [
    'easy',
    'normal',
    'hard',
    'hardcore',
];

export const AI_TRAINING_PERSONALITIES: readonly AiStyleId[] = [
    'balanced',
    'brute',
    'caster',
    'support',
    'coward',
];

/** Resource bands from the current combat-economy contract. */
export const AI_RESOURCE_BANDS = {
    hp: {
        low: [250, 699],
        medium: [700, 1100],
        high: [1101, 3050],
    },
    mana: {
        low: [0, 15],
        medium: [16, 40],
        high: [41, 132],
    },
    stamina: {
        low: [0, 12],
        medium: [13, 30],
        high: [31, 97],
    },
} as const;

/** Initial reward coefficients are hypotheses to ablate, not calibrated balance. */
export const AI_REWARD_COEFFICIENTS = {
    win: 1,
    loss: -1,
    groupDamage: 0.25,
    turnPenaltyPerTurn: 0.001,
    setup: 0.25,
    protection: 0.25,
    heal: 0.2,
    protagonistStatus: 0.15,
} as const;
