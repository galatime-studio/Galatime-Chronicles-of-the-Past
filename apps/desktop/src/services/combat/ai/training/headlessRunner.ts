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
    AiPolicyObservation,
    AiTrainingScenario,
} from '../../../../types/AiTrainingType';
import type { CombatAction, CombatState } from '../../../../types/CombatType';
import { buildAiCombatMetrics } from './metricsCollector';
import { buildTurnHistoryEntry } from './historyTracker';

export interface AiHeadlessRunOptions {
    scenario: AiTrainingScenario;
    policy: AiHeadlessActionPolicy;
    protagonistId?: string | null;
}

function cloneState(state: CombatState): CombatState {
    return structuredClone(state);
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
    const personalities = Object.fromEntries(
        scenario.units.map((unit) => [unit.key, unit.personality]),
    );
    const protagonistId = options.protagonistId ??
        scenario.units.find((unit) => unit.isPlayerControlled)?.key ?? null;

    const started = await startCombat(scenario.encounter.id, {
        encounter: scenario.encounter,
        hour: 12,
        timePhase: 'day',
        persistInventories: false,
    });

    if (!started.ok) {
        throw new Error(`Failed to start headless combat: ${started.error.message}`);
    }

    const sessionId = started.data.sessionId;
    let state = started.data;
    const history: ReturnType<typeof buildTurnHistoryEntry>[] = [];
    let stoppedReason: AiHeadlessCombatResult['stoppedReason'] = 'max_turns';

    try {
        for (let step = 0; step < scenario.maxTurns; step += 1) {
            if (state.phase === 'finished') {
                stoppedReason = 'combat_ended';
                break;
            }

            const actorId = state.order[state.turnIndex];
            if (!actorId) {
                stoppedReason = 'stall';
                break;
            }

            const contextResult = getCombatDecisionContext(sessionId, actorId);
            if (!contextResult.ok) {
                stoppedReason = 'stall';
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

            const request = policy.selectAction(observation);
            if (!request) {
                stoppedReason = 'stall';
                break;
            }

            const action = findAction(context.previews, request.actionId);
            const turnResult = submitCombatAction(sessionId, request);
            if (!turnResult.ok) {
                stoppedReason = 'stall';
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
        };
    } finally {
        endCombat(sessionId);
    }
}

/** Call between unrelated batches to avoid session/id leakage in the same process. */
export function resetHeadlessSessions(): void {
    clearCombatSessions();
}
