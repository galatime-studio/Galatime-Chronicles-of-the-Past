/**
 * Summon action.
 *
 * Brings units onto the battlefield from a blueprint that was pre-loaded at the
 * start of the fight (see `unitBlueprint.preloadAbilityBlueprints`), which is
 * what lets a death or a turn end spawn somebody synchronously.
 *
 * A single summon mirrors the summoner: its own line is tried first, then the other one.
 * A multi-unit summon never leaves the summoner's line — the brood flanks the slot it
 * burst from, so a split cannot send half its children to the wrong lane. A dead
 * summoner's slot counts as free for its own brood (the body is already leaving the
 * board), and a line with no room left runs the brood past its last slot instead of
 * crossing lanes. Dead or alive, a sprite still occupies the board.
 */

import { MAX_UNITS_PER_LINE } from '../../constants/CombatConstants';
import type { AbilityDefinition } from '../../types/AbilityType';
import type { CombatEvent, CombatLine, CombatSide, CombatState, CombatUnit } from '../../types/CombatType';
import { readNumber } from '../../utils/combatUtils';
import { readAbilityEntityTarget } from './abilityFactory';
import { abilityNotFired } from './abilityResult';
import type { AbilityActionResult } from './abilityResult';
import { canPlaceInLine, unitsInLine } from './positionRules';
import { getUnitBlueprint, instantiateUnit } from './unitBlueprint';

interface SummonPlacement {
    side: CombatSide;
    line: CombatLine;
    slot: number;
}

/** Slot indices already taken in one line, dead units included. */
function occupiedSlots(state: CombatState, side: CombatSide, line: CombatLine): Set<number> {
    return new Set(unitsInLine(state.units, side, line).map((unit) => unit.slot));
}

function firstFreeSlot(occupied: Set<number>): number | null {
    for (let slot = 0; slot < MAX_UNITS_PER_LINE; slot += 1) {
        if (!occupied.has(slot)) return slot;
    }
    return null;
}

/**
 * Where a summon stands, or `null` when both lines are full.
 *
 * `preferredLine` is only a preference: the other line is tried when it has no room.
 */
export function findSummonPlacement(
    state: CombatState,
    summoner: CombatUnit,
    preferredLine: CombatLine = summoner.line,
): SummonPlacement | null {
    const order: CombatLine[] = preferredLine === 'front' ? ['front', 'rear'] : ['rear', 'front'];

    for (const line of order) {
        if (!canPlaceInLine(state.units, summoner.side, line)) continue;

        const slot = firstFreeSlot(occupiedSlots(state, summoner.side, line));
        if (slot !== null) return { side: summoner.side, line, slot };
    }

    return null;
}

/**
 * Slots a multi-unit summon takes in the summoner's own line, nearest first.
 *
 * The brood flanks the slot it burst from: the summoner's slot first, then outward
 * (−1/+1, −2/+2, …), so a split surfaces where its parent stood instead of skipping
 * to the end of the line. A dead summoner does not hold its own slot — the body is
 * already leaving the board — while a living one still stands in it. The whole brood
 * always stays in this line: when it has no free slot left, the extra units run past
 * the line's last slot rather than crossing to the other lane.
 */
function planFlankingSlots(state: CombatState, summoner: CombatUnit, count: number): number[] {
    const taken = new Set(
        unitsInLine(state.units, summoner.side, summoner.line)
            .filter((unit) => unit.id !== summoner.id || summoner.status === 'alive')
            .map((unit) => unit.slot),
    );
    const slots: number[] = [];

    const take = (slot: number) => {
        if (slots.length >= count) return;
        if (slot < 0 || slot >= MAX_UNITS_PER_LINE || taken.has(slot)) return;
        taken.add(slot);
        slots.push(slot);
    };

    take(summoner.slot);
    for (let offset = 1; offset <= MAX_UNITS_PER_LINE && slots.length < count; offset += 1) {
        take(summoner.slot - offset);
        take(summoner.slot + offset);
    }

    // The line is full: the brood spills past its end, but never into the other lane.
    let overflow = MAX_UNITS_PER_LINE;
    while (slots.length < count) {
        while (taken.has(overflow)) overflow += 1;
        taken.add(overflow);
        slots.push(overflow);
        overflow += 1;
    }

    return slots;
}

/** The derived id, with a numeric suffix when another unit already holds it. */
function uniqueUnitId(state: CombatState, base: string): string {
    if (!state.units.some((unit) => unit.id === base)) return base;

    let suffix = 2;
    while (state.units.some((unit) => unit.id === `${base}_${suffix}`)) suffix += 1;
    return `${base}_${suffix}`;
}

/** Parameters: `entity_id`, `entity_type` and `count`. */
export function summonUnits(
    state: CombatState,
    summoner: CombatUnit,
    definition: AbilityDefinition,
): AbilityActionResult {
    const target = readAbilityEntityTarget(definition);
    if (!target) return abilityNotFired();

    const blueprint = getUnitBlueprint(target.entityId, target.entityType);
    if (!blueprint) return abilityNotFired();

    const count = Math.max(1, Math.round(readNumber(definition.action.parameters?.count, 1)));
    // A split's slots are planned once, so every child stays in the summoner's line.
    const flankingSlots = count > 1 ? planFlankingSlots(state, summoner, count) : [];
    const targetIds: string[] = [];
    const events: CombatEvent[] = [];

    for (let index = 0; index < count; index += 1) {
        // A multi-unit summon flanks the original in its own line; a single summon
        // keeps the plain placement: the first free slot of the summoner's line, the
        // other line when there is no room.
        const placement: SummonPlacement | null = index < flankingSlots.length
            ? { side: summoner.side, line: summoner.line, slot: flankingSlots[index] }
            : findSummonPlacement(state, summoner);
        if (!placement) break;

        const unit = instantiateUnit(blueprint, {
            id: uniqueUnitId(state, `${placement.side}_${placement.line}_${placement.slot}_${blueprint.entityId}`),
            side: placement.side,
            line: placement.line,
            slot: placement.slot,
            isPlayerControlled: summoner.isPlayerControlled,
        });

        state.units.push(unit);
        targetIds.push(unit.id);
        events.push({
            type: 'unit_summoned',
            sourceId: summoner.id,
            unitId: unit.id,
            entityId: unit.entityId,
            name: unit.name,
            side: unit.side,
            line: unit.line,
            slot: unit.slot,
        });
    }

    if (targetIds.length === 0) return abilityNotFired();
    return { fired: true, targetIds, events };
}
