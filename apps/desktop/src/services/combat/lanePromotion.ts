/**
 * Line promotion.
 *
 * The front line is where a side fights from, so an emptied front must be held
 * again from the rear. The rule is shared by the reaper (a death emptied the
 * front) and by wave deployment (a lane arrived while nobody was in front), so
 * it lives on its own instead of being copied into both.
 */

import { MAX_UNITS_PER_LINE } from '../../constants/CombatConstants';
import type { CombatEvent, CombatSide, CombatState } from '../../types/CombatType';

/** First slot index a line still has free, or `null` when it is full. */
export function firstFreeSlot(taken: ReadonlySet<number>): number | null {
    for (let slot = 0; slot < MAX_UNITS_PER_LINE; slot += 1) {
        if (!taken.has(slot)) return slot;
    }
    return null;
}

/**
 * Fills a side's emptied front line from its rear line.
 *
 * The front line is where a side fights from, so once every unit there has fallen
 * the rear steps up — obligatorily, not as a choice: the fight cannot go on with
 * nobody in front. Survivors keep their roster order and take the front's free
 * slots (the fallen still hold theirs); every step forward is reported so the log
 * can show it.
 */
export function promoteRearLines(state: CombatState, events: CombatEvent[]): void {
    const sides: CombatSide[] = ['allies', 'enemies'];

    for (const side of sides) {
        const frontHeld = state.units.some(
            (unit) => unit.side === side && unit.line === 'front' && unit.status === 'alive',
        );
        if (frontHeld) continue;

        const rear = state.units.filter(
            (unit) => unit.side === side && unit.line === 'rear' && unit.status === 'alive',
        );
        if (rear.length === 0) continue;

        const taken = new Set(
            state.units.filter((unit) => unit.side === side && unit.line === 'front').map((unit) => unit.slot),
        );

        for (const unit of rear) {
            const slot = firstFreeSlot(taken);
            if (slot === null) break;

            unit.line = 'front';
            unit.slot = slot;
            taken.add(slot);
            events.push({ type: 'unit_line_changed', unitId: unit.id, line: unit.line, slot });
        }
    }
}
