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
import type { Difficulty } from '../constants/DifficultyConstants';
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
    /**
     * True when this damaging turn hit a target already carrying a negative
     * status applied by the actor's own side. Dense capitalisation signal:
     * unlike `exploits`, it does not need an explicit payoff field on the
     * action.
     */
    statusLeverage: boolean;
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

/**
 * Shape of the fight a scenario is built to demand.
 *
 * `mixed` is the neutral baseline. The others bias the enemy roster so a policy
 * must solve something specific - one large threat, a wall, sustain, status
 * pressure or a swarm - instead of trading evenly line for line. Without that
 * spread the suite only ever rewards raw damage per turn.
 */
export type AiScenarioFormation = 'mixed' | 'boss' | 'wall' | 'sustain' | 'pressure' | 'swarm';

/** Reproducible N-vs-M scenario; `encounter` is accepted by `encounterLoader`. */
export interface AiTrainingScenario {
    id: string;
    seed: number;
    split: AiScenarioSplit;
    encounter: CombatEncounter;
    units: AiGeneratedUnitSpec[];
    /** Roster shape the scenario was built to demand. */
    formation: AiScenarioFormation;
    /**
     * Fight length the scenario is calibrated to, in rounds. The turn budget and
     * the pace term of the optimizer's fitness both derive from it.
     */
    expectedRounds: number;
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
/** Why a headless run could not submit another action. */
export interface AiHeadlessStall {
    reason: 'missing_actor' | 'context_failed' | 'policy_null' | 'submit_failed';
    actorId: string | null;
    /** The request the policy returned, when it got that far. */
    request: CombatActionRequest | null;
    /** Combat service error text, when the submission was rejected. */
    error: string | null;
}

export interface AiHeadlessCombatResult {
    scenarioId: string;
    seed: number;
    state: CombatState;
    history: AiTurnHistoryEntry[];
    metrics: AiCombatMetrics;
    stoppedReason: 'combat_ended' | 'max_turns' | 'stalemate' | 'stall';
    /** Present only when `stoppedReason` is `stall`. */
    stall?: AiHeadlessStall;
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

/** One named policy in a batch evaluation. */
export interface AiBatchPolicy {
    id: string;
    label: string;
    policy: AiHeadlessActionPolicy;
}

/** Per-split record of a batch evaluation. */
export interface AiBatchPolicySplitStats {
    battles: number;
    wins: number;
    losses: number;
    draws: number;
    stalls: number;
    maxTurns: number;
    combatEnded: number;
    winRate: number;
}

/** Aggregated results for one policy over the whole batch. */
export interface AiBatchPolicyStats {
    policyId: string;
    label: string;
    battles: number;
    wins: number;
    losses: number;
    draws: number;
    stalls: number;
    maxTurns: number;
    combatEnded: number;
    winRate: number;
    avgTurns: number;
    avgRounds: number;
    avgDamage: number;
    avgKills: number;
    avgStatusesExploited: number;
    avgBacklaneToFrontlaneSynergies: number;
    avgProtagonistDamage: number;
    avgProtagonistStatusBenefits: number;
    bySplit: Record<AiScenarioSplit, AiBatchPolicySplitStats>;
}

export interface AiBatchProgress {
    policyId: string;
    scenarioId: string;
    completed: number;
    total: number;
    result: AiHeadlessCombatResult;
}

/** Batch configuration. Every policy sees the same scenario/seed pairs. */
export interface AiBatchRunOptions {
    scenarios: readonly AiTrainingScenario[];
    policies: readonly AiBatchPolicy[];
    /** Independent fights per scenario; defaults to 1. */
    repetitions?: number;
    /** Session difficulty; defaults to `hard`. */
    difficulty?: Difficulty;
    /**
     * Fixed opponent for the non-protagonist side. When omitted, each candidate
     * plays both sides. Set this for candidate-vs-opponent evaluation.
     */
    opponent?: AiBatchPolicy;
    onProgress?: (progress: AiBatchProgress) => void;
}

export interface AiBatchReport {
    generatedAt: string;
    scenarioCount: number;
    repetitions: number;
    battlesPerPolicy: number;
    difficulty: Difficulty;
    splitCounts: Record<AiScenarioSplit, number>;
    /** Fixed non-protagonist policy, or `null` for self-play. */
    opponent: { id: string; label: string } | null;
    policies: AiBatchPolicyStats[];
}

/** Evaluation of one weight vector against a fixed opponent on one split. */
export interface AiWeightEvaluation {
    battles: number;
    wins: number;
    losses: number;
    draws: number;
    stalls: number;
    /** Runs that froze the combined HP pool for `AI_STALEMATE_ROUNDS`. */
    stalemates: number;
    maxTurns: number;
    combatEnded: number;
    winRate: number;
    /** Wilson 95% confidence interval for the win rate. */
    winRateCi: [number, number];
    avgTurns: number;
    /** Mean `turns / expectedTurns`; 1 means the scenario resolved on schedule. */
    avgPace: number;
    avgDamage: number;
    avgKills: number;
    avgHpMargin: number;
    avgKillMargin: number;
    /** Statuses the candidate side landed, per battle. */
    avgSetups: number;
    /** Later actions the candidate side made stronger by a landed status. */
    avgExploits: number;
    /** `avgExploits / avgSetups`, clamped to `[0, 1]`; 0 without setups. */
    setupConversion: number;
    /**
     * Share of the side's damaging turns that hit a target already carrying a
     * negative status its own side applied. The fitness-driving planning term.
     */
    statusLeverage: number;
    /**
     * Share of the side's setups on a target that the same side hit again
     * within `AI_SETUP_FOLLOWUP_TURNS` of its own turns. The fitness-driving
     * planning term: it separates "applied a status" from "used it".
     */
    setupFollowUp: number;
    fitness: number;
}

/** One cross-entropy generation. */
export interface AiOptimizerGeneration {
    generation: number;
    population: number;
    eliteCount: number;
    bestFitness: number;
    meanFitness: number;
    eliteFitness: number;
    /** Standard deviation averaged over the active dimensions. */
    meanStd: number;
    bestWeights: AiWeights;
}

/** Optimizer configuration. Validation and test are evaluated, never optimized. */
export interface AiWeightOptimizerOptions {
    /** Training scenarios only. */
    scenarios: readonly AiTrainingScenario[];
    validation?: readonly AiTrainingScenario[];
    test?: readonly AiTrainingScenario[];
    opponent: AiBatchPolicy;
    baseline?: AiWeights;
    repetitions?: number;
    difficulty?: Difficulty;
    generations?: number;
    populationSize?: number;
    /** Fraction of the population kept for the next distribution; defaults to 0.3. */
    eliteFraction?: number;
    initialStd?: number;
    minStd?: number;
    /** Stop after this many generations without validation improvement; defaults to 2. */
    validationPatience?: number;
    seed?: number | string;
    /**
     * Suite seeds the given scenarios came from. Reporting only: the search sees
     * a flat scenario list, and seed diversity is the caller's responsibility —
     * give it several independent suites or the vector overfits to one draw.
     */
    scenarioSeeds?: readonly string[];
    /** Dimensions optimized; defaults to every consideration except flee/item. */
    activeConsiderationIds?: readonly AiConsiderationId[];
    onGeneration?: (generation: AiOptimizerGeneration) => void;
}

/** Auditable optimizer output: weights, history and baseline/optimized scores. */
export interface AiWeightOptimizationReport {
    generatedAt: string;
    seed: number;
    /** Suite seeds the train/validation/test scenarios were generated from. */
    scenarioSeeds: string[];
    difficulty: Difficulty;
    opponent: { id: string; label: string };
    generations: number;
    populationSize: number;
    eliteCount: number;
    activeConsiderationIds: AiConsiderationId[];
    weightBounds: [number, number];
    /** Per-dimension search floors; ids absent here use `weightBounds[0]`. */
    weightFloors: Partial<Record<AiConsiderationId, number>>;
    /** How many train scenarios each formation contributed. */
    formationCounts: Partial<Record<AiScenarioFormation, number>>;
    baselineWeights: AiWeights;
    optimizedWeights: AiWeights;
    /** Best train candidate seen, even when validation selected the baseline. */
    bestTrainWeights: AiWeights;
    bestTrainFitness: number;
    bestFitness: number;
    baseline: {
        train: AiWeightEvaluation;
        validation: AiWeightEvaluation | null;
        test: AiWeightEvaluation | null;
    };
    optimized: {
        train: AiWeightEvaluation;
        validation: AiWeightEvaluation | null;
        test: AiWeightEvaluation | null;
    };
    history: AiOptimizerGeneration[];
}
