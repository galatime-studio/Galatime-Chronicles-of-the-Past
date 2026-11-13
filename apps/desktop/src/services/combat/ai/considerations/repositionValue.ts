/**
 * `reposition` — when changing line is worth a turn.
 *
 * `switch_line` has no destination of its own; it always means "the other
 * line", so the value is the difference between the two. The consideration
 * projects the board both ways and scores only a strict improvement:
 *
 * - a unit taking fire in the front wants the rear *only* when the rear really
 *   lowers the incoming threat (enemies with short reach stop reaching it) and
 *   the move does not cost it the attacks it can currently land;
 * - a unit in the rear wants the front only when the front unlocks a blocked
 *   kit, and only while standing there stays survivable.
 *
 * Both terms are measured in fractions of the unit's own health bar, matching
 * `expected_damage` and `survival`. A unit that has been shuffling lately has
 * its score divided by how often it already moved, which is what stops the
 * front/rear ping-pong that used to burn its stamina and force it to rest.
 */

import type { AiConsideration } from '../../../../types/AiType';
import type { CombatLine, CombatState, CombatUnit } from '../../../../types/CombatType';
import { clamp } from '../../../../utils/combatUtils';
import { effectiveStats } from '../../effectResolver';
import { legalTargetIds } from '../../targetResolver';
import { estimateThreatAgainst } from '../aiThreat';

/** How much of a blocked kit a rear unit will trade survivability for. */
const FRONT_DANGER_DISCOUNT = 0.75;

/** Damaging actions the unit can point at an enemy from where it stands. */
function reachableDamageActions(state: CombatState, unit: CombatUnit): number {
    const byId = new Map(state.units.map((other) => [other.id, other] as const));
    let reachable = 0;

    for (const action of unit.actions) {
        if (!action.dealsDamage) continue;
        const canHit = legalTargetIds(state, unit, action).some((id) => {
            const target = byId.get(id);
            return target !== undefined && target.side !== unit.side;
        });
        if (canHit) reachable += 1;
    }

    return reachable;
}

/** The same board with `unit` standing on `line`. */
function boardWithLine(state: CombatState, unit: CombatUnit, line: CombatLine): { state: CombatState; unit: CombatUnit } {
    const moved: CombatUnit = { ...unit, line };
    return {
        state: { ...state, units: state.units.map((other) => (other.id === unit.id ? moved : other)) },
        unit: moved,
    };
}

/** How often this unit already changed lines inside the history window. */
function recentLineChanges(context: Parameters<AiConsideration['evaluate']>[0], unitId: string): number {
    const events = context.history?.recentEvents ?? [];
    let changes = 0;
    for (const event of events) {
        if (event.type === 'unit_line_changed' && event.unitId === unitId) changes += 1;
    }
    return changes;
}

export const repositionValue: AiConsideration = {
    id: 'reposition',
    evaluate(context, candidate) {
        if (candidate.action.kind !== 'switch_line') return 0;

        const { actor } = context;
        const maxHp = effectiveStats(actor).maxHp;
        if (maxHp <= 0) return 0;

        const destination: CombatLine = actor.line === 'front' ? 'rear' : 'front';
        const moved = boardWithLine(context.state, actor, destination);
        const movedContext = { ...context, state: moved.state };

        const dangerNow = clamp(estimateThreatAgainst(context, actor) / maxHp, 0, 1);
        const dangerThen = clamp(estimateThreatAgainst(movedContext, moved.unit) / maxHp, 0, 1);

        const reachNow = reachableDamageActions(context.state, actor);
        const reachThen = reachableDamageActions(moved.state, moved.unit);
        const totalDamageActions = actor.actions.filter((action) => action.dealsDamage).length;

        let value = 0;
        if (actor.line === 'front') {
            const kitLoss = clamp((reachNow - reachThen) / Math.max(1, reachNow), 0, 1);
            value = clamp(dangerNow - dangerThen, 0, 1) * (1 - kitLoss);
        } else {
            const kitGain = clamp((reachThen - reachNow) / Math.max(1, totalDamageActions), 0, 1);
            value = kitGain * (1 - FRONT_DANGER_DISCOUNT * dangerThen);
        }

        if (value <= 0) return 0;

        return clamp(value / (1 + recentLineChanges(context, actor.id)), 0, 1);
    },
};
