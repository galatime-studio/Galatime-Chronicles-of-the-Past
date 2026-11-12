/**
 * Spatium (time & space) mechanics.
 *
 * The catalogue expresses temporal effects through a small set of generic
 * status clauses. Keeping the resolution here means a future element can reuse
 * the same fields instead of growing another branch in the core resolver:
 *
 * - `suspend`: skip turns, refuse or bank harm (`stasis`, `time_lock`)
 * - `echo_mark`: record a share of incoming damage and pay it later
 * - `rift_mark`: queue a cascading strike through a lane
 * - `anchor`: cancel the bearer's next action
 * - `next_action_bonus`: one-shot accuracy/cooldown payoff
 */

import type { AttackEffect } from '../../types/AttackDataType';
import type {
    CombatEffectInstance,
    CombatEvent,
    CombatState,
    CombatUnit,
} from '../../types/CombatType';
import { asRecord, clamp, readNumber } from '../../utils/combatUtils';
import { applyEffectToUnit, changeResource, effectiveStats, removeEffect, removeEffects } from './effectResolver';

/** The first live suspension on a unit. */
export function suspensionOf(unit: CombatUnit): CombatEffectInstance | null {
    return unit.effects.find((effect) => effect.suspend) ?? null;
}

/** Whether the unit is frozen in time and must skip its turn. */
export function isSuspended(unit: CombatUnit): boolean {
    return suspensionOf(unit) !== null;
}

/**
 * Banks damage on a suspended unit. Returns `true` when the hit was deferred
 * (the caller must not subtract it from health again).
 */
export function deferSuspendedDamage(unit: CombatUnit, amount: number): boolean {
    const effect = suspensionOf(unit);
    if (!effect?.suspend || amount <= 0) return false;

    if (effect.suspend.invulnerable) return true;
    if (!effect.suspend.deferDamage) return false;

    effect.suspend.deferredDamage += Math.max(0, Math.round(amount));
    return true;
}

/**
 * Advances a suspension at the start of the suspended unit's turn.
 *
 * Returns `true` while the unit must still skip its turn. On the final turn the
 * banked damage and statuses are released and the suspension is removed.
 */
export function tickSuspension(
    state: CombatState,
    unit: CombatUnit,
    events: CombatEvent[],
    random: () => number,
): boolean {
    const effect = suspensionOf(unit);
    if (!effect?.suspend) return false;

    if (effect.turns !== null) {
        effect.turns -= 1;
        if (effect.turns > 0) {
            return true;
        }
    } else {
        return true;
    }

    const suspend = effect.suspend;
    events.push(...removeEffect(unit, effect));

    if (suspend.deferredDamage > 0) {
        events.push({
            type: 'damage_deferred',
            unitId: unit.id,
            amount: suspend.deferredDamage,
            sourceId: effect.sourceId,
        });
        events.push(...changeResource(unit, 'hp', -suspend.deferredDamage));
        suspend.deferredDamage = 0;
    }

    // Deferred statuses land together with the damage (`time_lock`).
    for (const deferred of suspend.deferredStatuses) {
        const applied = applyDeferredStatus(unit, deferred, random);
        if (applied) events.push(applied);
    }
    suspend.deferredStatuses = [];

    // The source's interruption could end a zone early; ordinary suspension
    // simply ends here.
    void state;
    return false;
}

/** Applies one banked status after a suspension ends. */
function applyDeferredStatus(
    unit: CombatUnit,
    deferred: {
        effect: AttackEffect;
        sourceId: string;
        elementId: string | null;
        outputMultiplier: number;
        phaseMultiplier: number;
    },
    random: () => number,
): CombatEvent | null {
    return applyEffectToUnit(
        unit,
        deferred.effect,
        deferred.sourceId,
        deferred.elementId,
        random,
        deferred.outputMultiplier,
        deferred.phaseMultiplier,
    );
}

/**
 * Records a share of the damage a unit just took into every echo mark it
 * carries. The echo itself never feeds another echo because it is paid through
 * `changeResource`, outside the attack chain.
 */
export function recordEchoDamage(unit: CombatUnit, amount: number, echoBurstPercent = 0): void {
    if (amount <= 0) return;

    for (const effect of unit.effects) {
        const echo = effect.echoMark;
        if (!echo) continue;

        const percent = clamp(
            echo.currentPercent
                + (echo.recorded > 0 ? echo.addPercentPerHit : 0)
                + echoBurstPercent,
            0,
            echo.maxPercent ?? 100,
        );
        echo.currentPercent = percent;
        const recorded = amount * (percent / 100);
        const maxHp = effectiveStats(unit).maxHp;
        const cap = echo.cap
            ?? (echo.maxPercent !== null && maxHp > 0 ? maxHp * (echo.maxPercent / 100) : Number.POSITIVE_INFINITY);
        echo.pending = Math.min(cap, echo.pending + recorded);
        echo.recorded += 1;
    }
}

/**
 * Pays echo marks that resolve at the end of their bearer's turn. A deferred
 * echo counts its delay down first.
 */
export function resolveTurnEndEchoes(
    unit: CombatUnit,
    events: CombatEvent[],
    random: () => number,
): void {
    const consumed = new Set<CombatEffectInstance>();

    for (const effect of [...unit.effects]) {
        const echo = effect.echoMark;
        if (!echo) continue;
        if (echo.resolve === 'caster_next_turn') continue;
        if (echo.resolve === 'deferred' && echo.delayTurns > 0) {
            echo.delayTurns -= 1;
            if (echo.delayTurns > 0) continue;
        }
        if (echo.pending <= 0) {
            consumed.add(effect);
            continue;
        }

        const amount = Math.max(1, Math.round(echo.pending));
        events.push({
            type: 'damage_deferred',
            unitId: unit.id,
            amount,
            sourceId: effect.sourceId,
        });
        events.push(...changeResource(unit, 'hp', -amount));
        echo.pending = 0;
        consumed.add(effect);
    }

    if (consumed.size > 0) {
        events.push(...removeEffects(unit, (effect) => consumed.has(effect)));
    }

    void random;
}

/**
 * Pays echoes whose source is the unit whose turn is starting
 * (`delayed_echo` repeats at the start of the caster's next turn).
 */
export function resolveCasterEchoes(
    state: CombatState,
    source: CombatUnit,
    events: CombatEvent[],
): void {
    for (const unit of state.units) {
        if (unit.status !== 'alive') continue;
        const consumed = new Set<CombatEffectInstance>();

        for (const effect of unit.effects) {
            const echo = effect.echoMark;
            if (!echo || echo.resolve !== 'caster_next_turn' || effect.sourceId !== source.id) continue;
            if (echo.pending <= 0) {
                consumed.add(effect);
                continue;
            }

            const amount = Math.max(1, Math.round(echo.pending));
            events.push({
                type: 'damage_deferred',
                unitId: unit.id,
                amount,
                sourceId: effect.sourceId,
            });
            events.push(...changeResource(unit, 'hp', -amount));
            echo.pending = 0;
            consumed.add(effect);
        }

        if (consumed.size > 0) {
            events.push(...removeEffects(unit, (effect) => consumed.has(effect)));
        }
    }
}

/**
 * Resolves lane marks placed by `rift_mark` when their caster's turn begins.
 *
 * Targets are sorted by slot; the first takes the authored power, and every
 * following unit takes a share of the previous target's damage. This is the
 * engine-wide cascade rule reused by `lane_cascade` attacks.
 */
export function resolveRiftMarks(
    state: CombatState,
    source: CombatUnit,
    events: CombatEvent[],
): void {
    const marks = state.units
        .filter((unit) => unit.status === 'alive')
        .flatMap((unit) => unit.effects
            .filter((effect) => effect.riftMark && effect.sourceId === source.id)
            .map((effect) => ({ unit, effect })));

    if (marks.length === 0) return;

    const byLine = new Map<string, Array<{ unit: CombatUnit; effect: CombatEffectInstance }>>();
    for (const mark of marks) {
        const key = `${mark.unit.side}:${mark.unit.line}`;
        const list = byLine.get(key) ?? [];
        list.push(mark);
        byLine.set(key, list);
    }

    for (const list of byLine.values()) {
        list.sort((a, b) => a.unit.slot - b.unit.slot);
        let previous = 0;
        for (let index = 0; index < list.length; index += 1) {
            const { unit, effect } = list[index];
            const spec = effect.riftMark;
            if (!spec) continue;
            const amount = index === 0 ? Math.round(spec.power) : Math.max(1, Math.round(previous * spec.cascade));
            previous = amount;
            events.push({
                type: 'damage_deferred',
                unitId: unit.id,
                amount,
                sourceId: source.id,
            });
            events.push(...changeResource(unit, 'hp', -amount));
            events.push(...removeEffect(unit, effect));
        }
    }
}

/** Whether a unit carries an anchor that can cancel the given action kind. */
export function anchorForAction(unit: CombatUnit, kind: string): CombatEffectInstance | null {
    if (kind !== 'skill' && kind !== 'weapon' && kind !== 'switch_line') return null;
    return unit.effects.find((effect) => effect.anchor?.cancelActions) ?? null;
}

/** Consumes the first matching next-action bonus on a unit. */
export function nextActionBonusFor(
    unit: CombatUnit,
    elementId: string,
): { effect: CombatEffectInstance; accuracy: number; cooldown: number } | null {
    const effect = unit.effects.find((active) => active.nextActionBonus
        && (!active.nextActionBonus.element || active.nextActionBonus.element === elementId));
    if (!effect?.nextActionBonus) return null;

    const bonus = effect.nextActionBonus;
    bonus.charges -= 1;
    const result = { effect, accuracy: bonus.accuracy, cooldown: bonus.cooldown };
    if (bonus.charges <= 0) {
        removeEffect(unit, effect);
    }
    return result;
}

/**
 * Reads the authored lane-cascade rule off an action. Kept here so the
 * resolver and the forger share one vocabulary.
 */
export function laneCascadeSpec(action: { lane_cascade?: unknown }): { first: number; subsequent: number } | null {
    const record = asRecord(action.lane_cascade);
    if (!record) return null;
    return {
        first: clamp(readNumber(record.first, 1), 0, 4),
        subsequent: clamp(readNumber(record.subsequent, 0.6), 0, 1),
    };
}


