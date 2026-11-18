/**
 * On-hold lanes.
 *
 * A wave waits off the battlefield until its side's rear line is empty, then
 * steps onto the field together. Hold lanes are not part of `state.units` while
 * they wait: the formation board never draws them, nothing can target them and
 * the turn queue never sees them. Deployment is the only way in.
 */

import { MAX_UNITS_PER_LINE } from '../../constants/CombatConstants';
import type { CombatEvent, CombatSide, CombatState } from '../../types/CombatType';
import { promoteRearLines } from './lanePromotion';

const SIDES: readonly CombatSide[] = ['allies', 'enemies'];

/** Whether any of a side's hold lanes still has a living unit. */
export function hasHoldLanes(state: CombatState, side: CombatSide): boolean {
    return (state.holdLanes ?? []).some(
        (lane) => lane.side === side && lane.units.some((unit) => unit.status === 'alive'),
    );
}

/**
 * Whether a side still has a living unit anywhere — on the field or off it.
 *
 * Victory and defeat read this instead of `state.units`, so a fight is not
 * declared over while a wave is still waiting to enter.
 */
export function sideHasLivingUnits(state: CombatState, side: CombatSide): boolean {
    return state.units.some((unit) => unit.side === side && unit.status === 'alive')
        || hasHoldLanes(state, side);
}

/**
 * Deploys one hold lane per side whose rear line has no living unit.
 *
 * The lowest-numbered waiting lane enters as a whole, taking the rear slots
 * from the start of the line. Deployed units are not added to the current
 * round's turn queue — they act from the next round. The arrival is announced
 * with one `hold_lane_deployed` event after the per-unit line changes.
 *
 * A wave can arrive while the front line is also empty (the field was wiped in
 * the same blow); the shared promotion rule steps it straight up, so the
 * front-line invariant is never broken.
 */
export function deployHoldLanes(state: CombatState, events: CombatEvent[]): void {
    const lanes = state.holdLanes;
    if (!lanes || lanes.length === 0) return;

    let deployed = false;

    for (const side of SIDES) {
        const rearHeld = state.units.some(
            (unit) => unit.side === side && unit.line === 'rear' && unit.status === 'alive',
        );
        if (rearHeld) continue;

        // The lowest-numbered lane is always the next wave, whatever order the
        // array happens to be in.
        const waiting = lanes
            .map((lane, position) => ({ lane, position }))
            .filter(({ lane }) => lane.side === side && lane.units.some((unit) => unit.status === 'alive'));
        if (waiting.length === 0) continue;

        const chosen = waiting.reduce((best, entry) => (entry.lane.lane < best.lane.lane ? entry : best));
        const laneIndex = chosen.position;

        const lane = lanes[laneIndex];
        const arriving = lane.units
            .filter((unit) => unit.status === 'alive')
            .slice(0, MAX_UNITS_PER_LINE);

        arriving.forEach((unit, slot) => {
            unit.line = 'rear';
            unit.slot = slot;
            state.units.push(unit);
            events.push({ type: 'unit_line_changed', unitId: unit.id, line: 'rear', slot });
        });

        lanes.splice(laneIndex, 1);
        events.push({
            type: 'hold_lane_deployed',
            side,
            lane: lane.lane,
            unitIds: arriving.map((unit) => unit.id),
        });
        deployed = true;
    }

    if (deployed) promoteRearLines(state, events);
}
