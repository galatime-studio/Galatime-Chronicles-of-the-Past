/** Headless N-vs-M runner on top of the real combat service. */

import {
    clearCombatSessions,
    endCombat,
    getCombatDecisionContext,
    getCombatState,
    startCombat,
    submitCombatAction,
} from '../../../combatService';
import type {
    AiDecisionConditioning,
    AiHeadlessActionPolicy,
    AiHeadlessCombatResult,
    AiHeadlessStall,
    AiPolicyObservation,
    AiTrainingScenario,
} from '../../../../types/AiTrainingType';
import type { CombatAction, CombatState } from '../../../../types/CombatType';
import type { Difficulty } from '../../../../constants/DifficultyConstants';
import { buildAiCombatMetrics } from './metricsCollector';
import { buildTurnHistoryEntry } from './historyTracker';
import { createSeededCombatRandom } from './seededRandom';

export interface AiHeadlessRunOptions {
    scenario: AiTrainingScenario;
    policy: AiHeadlessActionPolicy;
    protagonistId?: string | null;
    /** Overrides `scenario.seed` for repeated runs of the same scenario. */
    seed?: number | string;
    /** Session difficulty; defaults to the combat service default (`normal`). */
    difficulty?: Difficulty;
    /**
     * Fixed policy for the non-protagonist side. When omitted, `policy` plays
     * both sides (self-play). Candidate-vs-opponent training sets this so a
     * candidate's win rate is not diluted by improving the opponent too.
     */
    opponentPolicy?: AiHeadlessActionPolicy;
}

function cloneState(state: CombatState): CombatState {
    return structuredClone(state);
}

function slotKey(unit: { side: string; line: string; slot: number }): string {
    return `${unit.side}:${unit.line}:${unit.slot}`;
}

function findAction(
    previews: ReadonlyArray<{ action: CombatAction; usable: boolean }>,
    actionId: string,
): CombatAction | null {
    return previews.find((preview) => preview.action.id === actionId)?.action ?? null;
}

function resolveConditioning(
    actorId: string,
    personalities: Readonly<Record<string, AiDecisionConditioning['personality']>>,
    fallback: AiDecisionConditioning,
): AiDecisionConditioning {
    return {
        ...fallback,
        personality: personalities[actorId] ?? fallback.personality,
    };
}

function defaultConditioning(): AiDecisionConditioning {
    return {
        personality: 'balanced',
        difficulty: 'normal',
    };
}

/**
 * Runs one scenario to completion using a deterministic policy.
 *
 * The runner never calls the live React AI effect; it explicitly selects an
 * action for the active unit and submits it through `submitCombatAction`.
 */
export async function runHeadlessCombat(
    options: AiHeadlessRunOptions,
): Promise<AiHeadlessCombatResult> {
    const { scenario, policy } = options;
    const specsBySlot = new Map(
        scenario.units.map((unit) => [slotKey(unit), unit]),
    );

    const started = await startCombat(scenario.encounter.id, {
        encounter: scenario.encounter,
        unitOverrides: scenario.units.map((unit) => ({
            side: unit.side,
            line: unit.line,
            slot: unit.slot,
            stats: unit.stats,
            elementIds: unit.elementIds,
            skillIds: unit.skillIds,
            startingEffects: unit.startingEffects,
            aiStyle: unit.personality,
            isPlayerControlled: unit.isPlayerControlled,
        })),
        hour: 12,
        timePhase: 'day',
        persistInventories: false,
        random: createSeededCombatRandom(options.seed ?? scenario.seed),
        difficulty: options.difficulty,
    });

    if (!started.ok) {
        throw new Error(`Failed to start headless combat: ${started.error.message}`);
    }

    // Scenario specs use authored keys; combat units use runtime ids. Resolve
    // once by side/line/slot so conditioning and protagonist metrics match.
    const personalities: Record<string, AiDecisionConditioning['personality']> = {};
    for (const unit of started.data.units) {
        const spec = specsBySlot.get(slotKey(unit));
        if (spec) personalities[unit.id] = spec.personality;
    }

    const requestedProtagonist = options.protagonistId
        ? scenario.units.find((unit) => unit.key === options.protagonistId)
        : undefined;
    const protagonistSpec = requestedProtagonist
        ?? scenario.units.find((unit) => unit.isPlayerControlled);
    const protagonistId = protagonistSpec
        ? started.data.units.find((unit) => slotKey(unit) === slotKey(protagonistSpec))?.id ?? null
        : options.protagonistId && started.data.units.some((unit) => unit.id === options.protagonistId)
            ? options.protagonistId
            : null;

    const sessionId = started.data.sessionId;
    let state = started.data;
    const protagonistSide = protagonistId
        ? state.units.find((unit) => unit.id === protagonistId)?.side ?? 'allies'
        : 'allies';
    const history: ReturnType<typeof buildTurnHistoryEntry>[] = [];
    let stoppedReason: AiHeadlessCombatResult['stoppedReason'] = 'max_turns';
    let stall: AiHeadlessStall | undefined;

    try {
        for (let step = 0; step < scenario.maxTurns; step += 1) {
            if (state.phase === 'finished') {
                stoppedReason = 'combat_ended';
                break;
            }

            const actorId = state.order[state.turnIndex];
            if (!actorId) {
                stoppedReason = 'stall';
                stall = { reason: 'missing_actor', actorId: null, request: null, error: null };
                break;
            }

            const contextResult = getCombatDecisionContext(sessionId, actorId);
            if (!contextResult.ok) {
                stoppedReason = 'stall';
                stall = {
                    reason: 'context_failed',
                    actorId,
                    request: null,
                    error: contextResult.error.message,
                };
                break;
            }
            const context = contextResult.data;

            const stateBefore = cloneState(state);
            const observation: AiPolicyObservation = {
                context,
                conditioning: resolveConditioning(actorId, personalities, defaultConditioning()),
                protagonistId,
                history,
            };

            const request = (
                options.opponentPolicy && context.actor.side !== protagonistSide
                    ? options.opponentPolicy
                    : policy
            ).selectAction(observation);
            if (!request) {
                stoppedReason = 'stall';
                stall = { reason: 'policy_null', actorId, request: null, error: null };
                break;
            }

            const action = findAction(context.previews, request.actionId);
            const turnResult = submitCombatAction(sessionId, request);
            if (!turnResult.ok) {
                stoppedReason = 'stall';
                stall = {
                    reason: 'submit_failed',
                    actorId,
                    request,
                    error: turnResult.error.message,
                };
                break;
            }

            const actionUsed = turnResult.data.events.find((event) => event.type === 'action_used');
            const targetIds = actionUsed && actionUsed.type === 'action_used'
                ? actionUsed.targetIds
                : [];

            const actorBefore = stateBefore.units.find((unit) => unit.id === actorId);
            if (actorBefore) {
                history.push(buildTurnHistoryEntry({
                    index: history.length,
                    actor: actorBefore,
                    actorIsProtagonist: actorBefore.id === protagonistId,
                    request,
                    action,
                    targetIds,
                    events: turnResult.data.events,
                    stateBefore,
                    historySoFar: history,
                }));
            }

            state = turnResult.data.state;
        }

        const finalState = getCombatState(sessionId);
        if (finalState.ok) state = finalState.data;

        return {
            scenarioId: scenario.id,
            seed: scenario.seed,
            state,
            history,
            metrics: buildAiCombatMetrics(state, history, protagonistId),
            stoppedReason,
            ...(stall ? { stall } : {}),
        };
    } finally {
        endCombat(sessionId);
    }
}

/** Call between unrelated batches to avoid session/id leakage in the same process. */
export function resetHeadlessSessions(): void {
    clearCombatSessions();
}
