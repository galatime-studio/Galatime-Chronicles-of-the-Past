/** Structured turn history + metric extraction. No live-combat state is mutated. */

import type { AiSetupRecord, AiStatusExploitRecord, AiTurnHistoryEntry } from '../../../../types/AiTrainingType';
import type {
    CombatAction,
    CombatActionRequest,
    CombatEvent,
    CombatSide,
    CombatState,
    CombatUnit,
} from '../../../../types/CombatType';

export interface BuildTurnHistoryOptions {
    index: number;
    actor: CombatUnit;
    actorIsProtagonist: boolean;
    request: CombatActionRequest | null;
    action: CombatAction | null;
    targetIds: string[];
    events: readonly CombatEvent[];
    /** State immediately before the action was submitted. */
    stateBefore: CombatState;
    historySoFar: readonly AiTurnHistoryEntry[];
}

function oppositeSide(side: CombatSide): CombatSide {
    return side === 'allies' ? 'enemies' : 'allies';
}

function resourceSpend(actorId: string, events: readonly CombatEvent[]): { hp: number; mana: number; stamina: number } {
    const spend = { hp: 0, mana: 0, stamina: 0 };
    for (const event of events) {
        if (event.type === 'resource_changed' && event.unitId === actorId) {
            const delta = event.previous - event.next;
            if (delta > 0) {
                if (event.resource === 'hp') spend.hp += delta;
                if (event.resource === 'mana') spend.mana += delta;
                if (event.resource === 'stamina') spend.stamina += delta;
            }
        }
    }
    return spend;
}

function buildSetups(actor: CombatUnit, events: readonly CombatEvent[]): AiSetupRecord[] {
    const setups: AiSetupRecord[] = [];
    for (const event of events) {
        if (event.type === 'effect_applied') {
            setups.push({
                sourceId: actor.id,
                sourceSide: actor.side,
                sourceLine: actor.line,
                targetId: event.unitId,
                effectId: event.effectId,
                statusEffect: event.statusEffect,
            });
        }
    }
    return setups;
}

function findSetupSource(
    targetId: string,
    statusEffect: string | null,
    effectId: string,
    actorSide: CombatSide,
    history: readonly AiTurnHistoryEntry[],
): AiSetupRecord | undefined {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const entry = history[index];
        for (const setup of entry.setups) {
            if (
                setup.targetId === targetId &&
                setup.sourceSide === actorSide &&
                (setup.statusEffect === statusEffect || setup.effectId === effectId)
            ) {
                return setup;
            }
        }
    }
    return undefined;
}

function isExploitingStatus(
    action: CombatAction,
    effect: { statusEffect: string | null; effectId: string; elementModulation?: Record<string, number> | null; expireOnElements?: string[] | null },
): boolean {
    if (
        action.bonusVsStatus?.some((entry) => entry.status === effect.statusEffect || entry.status === effect.effectId)
    ) return true;
    if (
        action.bonusPerCharge &&
        (action.bonusPerCharge.status === effect.statusEffect || action.bonusPerCharge.status === effect.effectId)
    ) return true;
    if (
        action.guaranteedCritVsStatus &&
        (action.guaranteedCritVsStatus === effect.statusEffect || action.guaranteedCritVsStatus === effect.effectId)
    ) return true;
    if (action.dealsDamage && effect.elementModulation?.[action.elementId] !== undefined) return true;
    if (action.dealsDamage && effect.expireOnElements?.includes(action.elementId)) return true;
    return false;
}

function buildExploits(
    actor: CombatUnit,
    actorIsProtagonist: boolean,
    action: CombatAction | null,
    targetIds: string[],
    stateBefore: CombatState,
    history: readonly AiTurnHistoryEntry[],
): AiStatusExploitRecord[] {
    if (!action || !action.dealsDamage) return [];
    const byId = new Map(stateBefore.units.map((unit) => [unit.id, unit]));
    const exploits: AiStatusExploitRecord[] = [];

    for (const targetId of targetIds) {
        const target = byId.get(targetId);
        if (!target) continue;
        for (const effect of target.effects) {
            if (!isExploitingStatus(action, effect)) continue;
            const setup = findSetupSource(
                targetId,
                effect.statusEffect,
                effect.effectId,
                actor.side,
                history,
            );
            exploits.push({
                attackerId: actor.id,
                attackerSide: actor.side,
                attackerLine: actor.line,
                targetId,
                effectId: effect.effectId,
                statusEffect: effect.statusEffect,
                setupSourceId: setup?.sourceId ?? null,
                setupSourceLine: setup?.sourceLine ?? null,
                protagonistBenefited: actorIsProtagonist && (setup?.sourceId !== actor.id),
            });
        }
    }

    return exploits;
}

export function buildTurnHistoryEntry(
    options: BuildTurnHistoryOptions,
): AiTurnHistoryEntry {
    const { index, actor, actorIsProtagonist, request, action, targetIds, events, stateBefore, historySoFar } = options;
    return {
        index,
        round: actor.turnCount,
        actorId: actor.id,
        actorSide: actor.side,
        actorLine: actor.line,
        actorIsProtagonist,
        request,
        action,
        targetIds,
        events,
        resourcesSpent: resourceSpend(actor.id, events),
        setups: buildSetups(actor, events),
        exploits: buildExploits(actor, actorIsProtagonist, action, targetIds, stateBefore, historySoFar),
    };
}

export function resourcesSpentByUnit(history: readonly AiTurnHistoryEntry[]): Record<string, { hp: number; mana: number; stamina: number }> {
    const totals: Record<string, { hp: number; mana: number; stamina: number }> = {};
    for (const entry of history) {
        for (const event of entry.events) {
            if (event.type !== 'resource_changed') continue;
            const delta = event.previous - event.next;
            if (delta <= 0) continue;
            const unitTotals = totals[event.unitId] ?? { hp: 0, mana: 0, stamina: 0 };
            if (event.resource === 'hp') unitTotals.hp += delta;
            if (event.resource === 'mana') unitTotals.mana += delta;
            if (event.resource === 'stamina') unitTotals.stamina += delta;
            totals[event.unitId] = unitTotals;
        }
    }
    return totals;
}

export function outcomeToSide(outcome: 'victory' | 'defeat' | 'fled' | null, alliesSide: CombatSide): CombatSide | null {
    if (outcome === 'victory') return alliesSide;
    if (outcome === 'defeat') return oppositeSide(alliesSide);
    return null;
}
