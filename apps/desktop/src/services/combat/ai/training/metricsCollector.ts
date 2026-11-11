/** Aggregate metrics from a completed headless run. None of these values is a reward. */

import type {
    AiCombatMetrics,
    AiTurnHistoryEntry,
} from '../../../../types/AiTrainingType';
import type { CombatOutcome, CombatSide, CombatState } from '../../../../types/CombatType';
import { outcomeToSide, resourcesSpentByUnit } from './historyTracker';

function alliesSide(state: CombatState): CombatSide {
    const playerControlled = state.units.find((unit) => unit.isPlayerControlled);
    if (playerControlled) return playerControlled.side;
    return state.units[0]?.side ?? 'allies';
}

function damageByUnit(history: readonly AiTurnHistoryEntry[]): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const entry of history) {
        for (const event of entry.events) {
            if (event.type === 'attack_resolved') {
                const id = event.resolution.attackerId;
                totals[id] = (totals[id] ?? 0) + event.resolution.finalDamage;
            }
        }
    }
    return totals;
}

function killsByUnit(history: readonly AiTurnHistoryEntry[], state: CombatState): Record<string, number> {
    const byId = new Map(state.units.map((unit) => [unit.id, unit]))
    const totals: Record<string, number> = {};
    for (const entry of history) {
        for (const event of entry.events) {
            if (event.type === 'unit_defeated') {
                const defeated = byId.get(event.unitId);
                if (defeated && defeated.side !== entry.actorSide) {
                    totals[entry.actorId] = (totals[entry.actorId] ?? 0) + 1;
                }
            }
        }
    }
    return totals;
}

function protagonistDamage(history: readonly AiTurnHistoryEntry[], protagonistId: string | null): number {
    if (!protagonistId) return 0;
    return history.reduce((sum, entry) =>
        entry.actorId === protagonistId
            ? sum + entry.events.reduce((inner, event) =>
                event.type === 'attack_resolved' ? inner + event.resolution.finalDamage : inner, 0)
            : sum, 0);
}

export function buildAiCombatMetrics(
    state: CombatState,
    history: readonly AiTurnHistoryEntry[],
    protagonistId: string | null,
): AiCombatMetrics {
    const side = alliesSide(state);
    const dmg = damageByUnit(history);
    return {
        turns: history.length,
        rounds: state.round,
        winningSide: outcomeToSide(state.outcome as CombatOutcome | null, side),
        protagonistDamage: protagonistDamage(history, protagonistId),
        damageByUnit: dmg,
        killsByUnit: killsByUnit(history, state),
        resourcesSpentByUnit: resourcesSpentByUnit(history),
        statusesExploited: history.reduce((sum, entry) => sum + entry.exploits.length, 0),
        backlaneToFrontlaneSynergies: history.reduce(
            (sum, entry) => sum + entry.exploits.filter(
                (exploit) => exploit.setupSourceLine === 'rear' && exploit.attackerLine === 'front').length,
            0),
        protagonistStatusBenefits: history.reduce(
            (sum, entry) => sum + entry.exploits.filter((exploit) => exploit.protagonistBenefited).length,
            0),
    };
}
