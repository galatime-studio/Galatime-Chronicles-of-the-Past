/**
 * The effects that change the battlefield rather than a number.
 *
 * Most effects move a number around: a stat, a pool of health, a status. A few
 * do something else entirely — they clean the curses off a unit, strip its
 * gifts, walk it to the other line of the field or take its last turns back.
 *
 * They live here so the action resolver only has to ask "what does this effect
 * *do*", and so the same rule is never written twice.
 */

import type { AttackEffect, AttackEffectCondition } from '../../types/AttackDataType';
import type {
    CombatEvent,
    CombatMoveSpec,
    CombatState,
    CombatUnit,
} from '../../types/CombatType';
import { asRecord, readBoolean, readNumber, readString } from '../../utils/combatUtils';
import {
    carriesStatusNamed,
    cleanseEffects,
    dispelEffects,
    effectiveStats,
    readMoveSpec,
    readRewindSpec,
} from './effectResolver';
import { canPlaceInLine, moveUnitToLine } from './positionRules';
import { rewindUnit } from './rewind';
import { hasActedThisRound, postponeUnitTurn } from './turnOrderService';

/** Reads a condition clause as authored; an absent clause lets everything through. */
export function readConditionRecord(source: unknown): AttackEffectCondition | null {
    const record = asRecord(source);
    if (!record) return null;

    const line = readString(record.target_line, '');
    const noSpace = readString(record.requires_no_space, '');
    const condition: AttackEffectCondition = {
        requires_pending: readBoolean(record.requires_pending, false) || undefined,
        requires_acted: readBoolean(record.requires_acted, false) || undefined,
        requires_status: readString(record.requires_status, '') || undefined,
        requires_no_status: readString(record.requires_no_status, '') || undefined,
        target_line: line === 'front' || line === 'rear' ? line : undefined,
        requires_no_space: noSpace === 'front' || noSpace === 'rear' ? noSpace : undefined,
    };
    return !condition.requires_pending && !condition.requires_acted && !condition.target_line
        && !condition.requires_no_space && !condition.requires_status && !condition.requires_no_status
        ? null
        : condition;
}

/**
 * Whether a unit satisfies an effect's `condition` clause.
 *
 * `requires_pending` passes for units that have not acted yet this round (the
 * caster acts *before* the target), `requires_acted` for units that already
 * have, and `target_line` for units standing in the named line. An absent
 * condition is always satisfied.
 */
export function effectConditionSatisfied(
    state: CombatState,
    unit: CombatUnit,
    condition: AttackEffectCondition | null | undefined,
): boolean {
    if (!condition) return true;
    const acted = hasActedThisRound(state, unit.id);
    if (condition.requires_pending && acted) return false;
    if (condition.requires_acted && !acted) return false;
    if (condition.requires_status && !carriesStatusNamed(unit, condition.requires_status)) return false;
    if (condition.requires_no_status && carriesStatusNamed(unit, condition.requires_no_status)) return false;
    if (condition.target_line && unit.line !== condition.target_line) return false;
    if (condition.requires_no_space && canPlaceInLine(state.units, unit.side, condition.requires_no_space)) {
        // The clause only passes when the named line is full: a `sky_lift`
        // fallback fires because the caster's rear row has no free slot.
        return false;
    }
    if (condition.min_negative_statuses !== undefined) {
        const negatives = unit.effects.filter((effect) => effect.polarity === 'negative').length;
        if (negatives < condition.min_negative_statuses) return false;
    }
    return true;
}

/**
 * The curses a cleanse takes off a unit.
 *
 * `cleanse: 2` removes at most two; `cleanse_all: true` removes every one.
 */
export function applyCleanse(unit: CombatUnit, effect: AttackEffect): CombatEvent[] {
    const record = asRecord(effect) ?? {};
    const all = readBoolean(record.cleanse_all, false);
    const count = readNumber(record.cleanse, 0);
    const dotCount = readNumber(record.cleanse_dot, 0);

    if (!all && count <= 0 && dotCount <= 0) return [];

    if (dotCount > 0) return cleanseEffects(unit, { count: dotCount, damageOverTimeOnly: true });
    return cleanseEffects(unit, { count, all });
}

/**
 * The gifts a dispel takes off a unit.
 *
 * `dispel: 1` removes at most one; `dispel_all: true` removes every one;
 * `dispel_status` removes one named status whatever its polarity.
 */
export function applyDispel(unit: CombatUnit, effect: AttackEffect): CombatEvent[] {
    const record = asRecord(effect) ?? {};
    const statusId = readString(record.dispel_status, '');
    const all = readBoolean(record.dispel_all, false);
    const count = readNumber(record.dispel, 0);

    if (!statusId && !all && count <= 0) return [];

    return dispelEffects(unit, { count, all, statusId: statusId || undefined });
}

/**
 * Walks a unit to the line the effect names.
 *
 * `who` decides whether the caster or the target moves; `to_line` decides
 * where they land, and `other` means "the line they are not in". The move is
 * refused when the destination line is full — nobody walks off the field.
 */
export function applyMove(
    state: CombatState,
    actor: CombatUnit,
    unit: CombatUnit,
    effect: AttackEffect,
): CombatEvent[] {
    const spec = readMoveSpec(effect);
    if (!spec) return [];

    // A `move` may carry its own `condition` (`Tailwind` only pushes a target
    // that has not acted yet); the clause reads the mover, not the caster.
    const condition = readConditionRecord(asRecord(asRecord(effect)?.move)?.condition);
    if (!effectConditionSatisfied(state, spec.who === 'self' ? actor : unit, condition)) return [];

    return applyMoveSpec(state, actor, unit, spec);
}

/**
 * Walks the unit the spec names to the spec's line, with no condition of its
 * own — shared by reactive moves fired from a live status (`Zephyr Veil`).
 */
export function applyMoveSpec(
    state: CombatState,
    actor: CombatUnit,
    unit: CombatUnit,
    spec: CombatMoveSpec,
): CombatEvent[] {
    const mover = spec.who === 'self' ? actor : unit;
    if (mover.status !== 'alive') return [];
    if (mover.effects.some((effect) => effect.movementImmunity || effect.gravityZone?.preventExit)) return [];

    const destination = spec.toLine === 'other'
        ? (mover.line === 'front' ? 'rear' : 'front')
        : spec.toLine;

    const swapWith = spec.swapWithCaster && actor.id !== mover.id ? actor : null;
    const previousLine = mover.line;
    const previousSlot = mover.slot;

    if (!moveUnitToLine(state.units, mover, destination, swapWith)) return [];

    if (mover.line === previousLine && mover.slot === previousSlot && !swapWith) return [];

    return [{ type: 'unit_line_changed', unitId: mover.id, line: mover.line, slot: mover.slot }];
}

/**
 * Takes a unit's last turns back.
 *
 * The pools named by the effect go back to what they were, and the statuses of
 * the rewound turns are undone with them.
 */
export function applyRewind(unit: CombatUnit, effect: AttackEffect): CombatEvent[] {
    const spec = readRewindSpec(effect);
    if (!spec) return [];

    return rewindUnit(unit, spec);
}

/**
 * Delays the target's next turn a few places through the queue.
 *
 * Authored by `turn_postpone`: `slots` (default `1`) is the base pushback, and
 * `per_speed_advantage` adds one extra place per multiple of itself the
 * caster's live speed leads the target's by (`Uproot` pushes harder the
 * faster the gale comes down). The clause's own `condition` gates the whole
 * call, and a target with no pending turn cannot be delayed. Fires
 * `action_postponed` when it lands.
 */
export function applyTurnPostpone(
    state: CombatState,
    actor: CombatUnit,
    unit: CombatUnit,
    effect: AttackEffect,
): CombatEvent[] {
    const record = asRecord(asRecord(effect)?.turn_postpone);
    if (!record) return [];

    const condition = readConditionRecord(record.condition);
    if (!effectConditionSatisfied(state, unit, condition)) return [];
    if (unit.status !== 'alive') return [];

    const base = readNumber(record.slots, 1);
    const per = readNumber(record.per_speed_advantage, 0);
    const edge = per > 0
        ? Math.floor(Math.max(0, effectiveStats(actor).speed - effectiveStats(unit).speed) / per)
        : 0;
    const slots = Math.max(0, Math.round(base) + edge);
    const moved = postponeUnitTurn(state, unit.id, slots);
    if (moved <= 0) return [];

    return [{ type: 'action_postponed', unitId: unit.id, slots: moved }];
}
