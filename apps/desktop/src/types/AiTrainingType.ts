/**
 * Contracts for the offline Utility-AI training harness.
 *
 * These types deliberately live outside the live combat session. A learned
 * policy proposes consideration weights; it never returns an action directly.
 * The existing Utility AI remains the only action selector for learned policies.
 */

import type {
    AiConsiderationId,
    AiDecisionContext,
    AiStyleId,
    AiWeights,
} from './AiType';
import type { AiScoredCandidate } from '../services/combat/ai/aiDecider';
import type {
    CombatAction,
    CombatActionRequest,
    CombatEffectInstance,
    CombatEncounter,
    CombatEvent,
    CombatLine,
    CombatSide,
    CombatState,
    CombatStats,
    CombatUnit,
} from './CombatType';

/** Fixed-order network output. Use `AI_CONSIDERATION_IDS` for the column mapping. */
export type AiWeightVector = readonly number[];

/** Who receives a reward; enemy strength and ally competence stay independent. */
export type AiRewardPerspective = 'enemy' | 'companion';

/** Stable train/validation/test partitions. The test partition is evaluation-only. */
export type AiScenarioSplit = 'train' | 'validation' | 'test';

/** The conditioning associated with one unit for one decision. */
export interface AiDecisionConditioning {
    personality: AiStyleId;
    difficulty: string;
}

/** One persistent setup observed in the structured turn history. */
export interface AiSetupRecord {
    sourceId: string;
    sourceSide: CombatSide;
    sourceLine: CombatLine;
    targetId: string;
    effectId: string;
    statusEffect: string | null;
}

/** A later action structurally exploiting a status already on its target. */
export interface AiStatusExploitRecord {
    attackerId: string;
    attackerSide: CombatSide;
    attackerLine: CombatLine;
    targetId: string;
    effectId: string;
    statusEffect: string | null;
    setupSourceId: string | null;
    setupSourceLine: CombatLine | null;
    protagonistBenefited: boolean;
}

/** Resources paid during a turn, including costs, drains and upkeep. */
export interface AiResourceSpend {
    hp: number;
    mana: number;
    stamina: number;
}

/**
 * One complete unit turn, owned by the harness rather than the capped UI log.
 * Events stay available for auditing and counterfactual reward construction.
 */
export interface AiTurnHistoryEntry {
    index: number;
    round: number;
    actorId: string;
    actorSide: CombatSide;
    actorLine: CombatLine;
    actorIsProtagonist: boolean;
    request: CombatActionRequest | null;
    /** The action the request resolved, for structural feature extraction. */
    action: CombatAction | null;
    targetIds: string[];
    events: readonly CombatEvent[];
    resourcesSpent: AiResourceSpend;
    setups: readonly AiSetupRecord[];
    exploits: readonly AiStatusExploitRecord[];
}

/** Everything an encoder or policy may read for one decentralized decision. */
export interface AiPolicyObservation {
    context: AiDecisionContext;
    conditioning: AiDecisionConditioning;
    protagonistId: string | null;
    history: readonly AiTurnHistoryEntry[];
}

/** Stable slots plus masks; absent slots never expose stale unit data. */
export interface AiEncodedSlot {
    features: number[];
    mask: 0 | 1;
}

/** Structured tensors suitable for either slot-based or set-based models. */
export interface AiEncodedObservation {
    schemaVersion: number;
    units: AiEncodedSlot[];
    history: AiEncodedSlot[];
    globalFeatures: number[];
    conditioningFeatures: number[];
}

/** A policy's only learned output: thirteen Utility-AI weights. */
export interface AiWeightPolicy {
    proposeWeights(observation: AiPolicyObservation, encoded: AiEncodedObservation): AiWeights | AiWeightVector;
}

/** The auditable result of routing weights through the ordinary Utility AI. */
export interface AiWeightedDecision {
    request: CombatActionRequest | null;
    ranking: AiScoredCandidate[];
    weights: Record<AiConsiderationId, number>;
    vector: AiWeightVector;
}

export interface AiPolicyDecision extends AiWeightedDecision {
    encoded: AiEncodedObservation;
}

/** Generic selector used only by harness baselines (random/greedy/Utility). */
export interface AiHeadlessActionPolicy {
    selectAction(observation: AiPolicyObservation): CombatActionRequest | null;
}

/** A generated unit overlays a catalogue entity mounted by `unitFactory`. */
export interface AiGeneratedUnitSpec {
    key: string;
    entityId: string;
    entityType: CombatUnit['entityType'];
    side: CombatSide;
    line: CombatLine;
    slot: number;
    isPlayerControlled: boolean;
    personality: AiStyleId;
    stats: CombatStats;
    elementIds: string[];
    skillIds: string[];
    startingEffects: CombatEffectInstance[];
}

/** Reproducible N-vs-M scenario; `encounter` is accepted by `encounterLoader`. */
export interface AiTrainingScenario {
    id: string;
    seed: number;
    split: AiScenarioSplit;
    encounter: CombatEncounter;
    units: AiGeneratedUnitSpec[];
    maxTurns: number;
}

/** Fixed, separately seeded scenario partitions. */
export interface AiTrainingScenarioSuite {
    train: AiTrainingScenario[];
    validation: AiTrainingScenario[];
    test: AiTrainingScenario[];
}

/** Aggregate metrics; none of these is implicitly a reward component. */
export interface AiCombatMetrics {
    turns: number;
    rounds: number;
    winningSide: CombatSide | null;
    protagonistDamage: number;
    damageByUnit: Record<string, number>;
    killsByUnit: Record<string, number>;
    resourcesSpentByUnit: Record<string, AiResourceSpend>;
    statusesExploited: number;
    backlaneToFrontlaneSynergies: number;
    protagonistStatusBenefits: number;
}

/** Result returned by the offline runner. */
export interface AiHeadlessCombatResult {
    scenarioId: string;
    seed: number;
    state: CombatState;
    history: AiTurnHistoryEntry[];
    metrics: AiCombatMetrics;
    stoppedReason: 'combat_ended' | 'max_turns' | 'stall';
}

/**
 * One paired counterfactual sample. `actual` and `baseline` must describe the
 * same outcome metric, state and RNG snapshot, with only the contribution removed.
 */
export interface AiCausalSample {
    id: string;
    kind: 'setup' | 'protection' | 'heal' | 'protagonist_status';
    actual: number;
    baseline: number;
    reference: number;
}

export interface AiRewardInput {
    perspective: AiRewardPerspective;
    won: boolean | null;
    turns: number;
    maxTurns: number;
    /** Normalised enemy-group damage for the enemy perspective. */
    groupDamage: number;
    causalSamples: readonly AiCausalSample[];
}

export interface AiRewardBreakdown {
    total: number;
    terminal: number;
    groupDamage: number;
    turnPenalty: number;
    setup: number;
    protection: number;
    heal: number;
    protagonistStatus: number;
}

/** Optional dependencies used to mount generated scenarios without React. */
export interface AiScenarioMountResult {
    state: CombatState;
    units: CombatUnit[];
    encounter: CombatEncounter;
}
