/** Structured turn history + metric extraction. No live-combat state is mutated. */

import type { AiSetupRecord, AiStatusExploitRecord, AiTurnHistoryEntry } from '../../../../types/AiTrainingType';
import type {
    CombatAction,
    CombatActionRequest,
    CombatEffectInstance,
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

/**
 * Whether an effect is a curse the enemy side would want to cash in.
 *
 * Polarity alone is not enough: `readPolarity` calls a pure control status
 * `neutral` unless it also carries a stat debuff or a damage-over-time, so
 * stuns, freezes, mud and roots would never count as setup.
 */
function isHostileStatus(effect: CombatEffectInstance): boolean {
    if (effect.polarity === 'negative') return true;
    return Boolean(
        (effect.preventActions && effect.preventActions.length > 0)
        || effect.preventSkills
        || effect.move
        || effect.locksTarget
        || effect.confuse
        || effect.damagePerTurn > 0,
    );
}

/**
 * True when a damaging action met a target carrying a hostile status the
 * actor's own side applied.
 *
 * This is the dense measure of capitalisation: the mechanical exploit records
 * only fire for the handful of skills with explicit payoff fields, while every
 * debuff-then-hit sequence counts here. A side that never sets anything up
 * scores nothing, and a side that only sets up but never cashes in scores
 * nothing either.
 *
 * Attribution is a problem: `effect.sourceId` holds the *skill or status id*
 * (`footwork`), not the caster's unit id, so the engine cannot say who applied
 * what. The side is therefore read from the setup records this battle already
 * produced, which do know their source side. A mirrored status on both sides
 * can be attributed to the wrong side, which is acceptable for a training
 * signal but not for anything the player sees.
 */
function buildsOnOwnSetup(
    actor: CombatUnit,
    action: CombatAction | null,
    targetIds: readonly string[],
    stateBefore: CombatState,
    historySoFar: readonly AiTurnHistoryEntry[],
): boolean {
    if (!action || !action.dealsDamage) return false;
    const byId = new Map(stateBefore.units.map((unit) => [unit.id, unit]));
    const ownSetups = new Set<string>();
    for (const entry of historySoFar) {
        for (const setup of entry.setups) {
            if (setup.sourceSide === actor.side) ownSetups.add(setup.statusEffect ?? setup.effectId);
        }
    }
    return targetIds.some((targetId) => {
        const target = byId.get(targetId);
        if (!target) return false;
        return target.effects.some((effect) => {
            if (!isHostileStatus(effect)) return false;
            const caster = byId.get(effect.sourceId);
            if (caster) return caster.side === actor.side;
            return ownSetups.has(effect.statusEffect ?? effect.effectId);
        });
    });
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
        statusLeverage: buildsOnOwnSetup(actor, action, targetIds, stateBefore, historySoFar),
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
