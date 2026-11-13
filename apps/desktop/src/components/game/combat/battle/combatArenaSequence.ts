/**
 * Turns the events of one resolved combat step into a short choreography.
 *
 * The backend resolves an action in a single call and hands back both the new state and
 * the events it produced, so the arena cannot watch the fight unfold on its own. This
 * module is the missing narration: it reads those events once and describes *what* to
 * show (who lunged, who was struck, for how much, in what element, who died), leaving
 * `CombatEncounter` to decide *when* each beat plays and the components to draw them.
 */

import {
    ARENA_ENTER_MS,
    ARENA_ENTER_STAGGER_MS,
    ARENA_HIT_STAGGER_MS,
    ARENA_IMPACT_MS,
    ARENA_QUIET_TOTAL_MS,
    ARENA_SETTLE_MS,
    ARENA_SHAKE_RATIO,
    ARENA_STATUS_MS,
    ARENA_STATUS_STAGGER_MS,
    ARENA_STEP_MS,
    ARENA_STEP_STAGGER_MS,
    ARENA_TOTAL_MS,
} from '../../../../constants/CombatAnimationConstants';
import type { CombatEvent, CombatState, CombatUnit } from '../../../../types/CombatType';

/** One unit taking damage or being healed, already totalled per source. */
export interface ArenaHit {
    targetId: string;
    /** Damage dealt (positive) or health restored, already resolved. */
    amount: number;
    kind: 'damage' | 'heal';
    /** `false` when the blow missed; the reaction is then a "MISS", not a number. */
    isHit: boolean;
    /** Element of the action, for the flash/spark tint. */
    elementId: string | null;
    /** Element efficacy (`x0`…`x1.6`), read by the damage number's colour. */
    multiplier: number;
    /** The hit brought the target to 0. */
    fatal: boolean;
    /**
     * How many individual blows this entry stands for.
     *
     * A multi-hit action rolls once and reports its strike count; the arena then
     * rattles the target per blow and prints `×N` beside the total.
     */
    hits: number;
    /**
     * The reaction waits this long after the impact.
     *
     * Consecutive targets of one action are staggered so the numbers do not all
     * appear on the same frame.
     */
    delayMs: number;
    /**
     * A health tick that did not come from a direct action: a damage-over-time,
     * a regen, an upkeep or an item. Drawn smaller, without a knockback or sparks.
     */
    ambient: boolean;
}

/** A status effect landing on a unit, or being shrugged off. */
export interface ArenaStatusBeat {
    unitId: string;
    label: string | null;
    /** How the effect reads: a buff, a debuff, or neither. */
    tone: 'buff' | 'debuff' | 'neutral';
    /** Element the effect came from, for the label's outline. */
    elementId: string | null;
    /** The target resisted the effect; the label says so instead of naming it. */
    resisted: boolean;
}

/** Damage thrown back at the unit that dealt it. */
export interface ArenaReflectBeat {
    unitId: string;
    amount: number;
}

/** Everything one resolved step should show on the board. */
export interface ArenaSequence {
    /** Monotonic id, so a component can tell one sequence from the next. */
    id: number;
    actorId: string | null;
    actorName: string | null;
    actionName: string | null;
    /** When the blow lands, in ms from the start of the sequence. */
    impactAtMs: number;
    /** When the whole sequence is over and the next turn may begin. */
    totalMs: number;
    hits: ArenaHit[];
    statuses: ArenaStatusBeat[];
    defeated: string[];
    reflected: ArenaReflectBeat[];
    summoned: string[];
    transformed: string[];
    /**
     * Units whose battle line changed this step.
     *
     * The rear line steps up into an emptied front slot when the front one is wiped, and
     * a movement effect can re-place a unit outright. The node remounts into its new row
     * when the state swaps, so the row hands the entrance animation its part.
     */
    stepped: string[];
    /** The board should jolt: a fatal blow, or one that took a huge share of a health pool. */
    shake: boolean;
}

/** The element of an action, read off whichever unit still carries it. */
function findActionElement(units: readonly CombatUnit[], actionId: string): string | null {
    for (const unit of units) {
        const action = unit.actions.find((candidate) => candidate.id === actionId);
        if (action) return action.elementId || null;
    }
    return null;
}

/**
 * How one applied effect reads once the new state is in place.
 *
 * The event names the effect but not its tone; the instance carries the derived
 * polarity and the element, so the label can be drawn in the same colours as the
 * status chips already are.
 */
function findAppliedEffect(
    units: readonly CombatUnit[],
    unitId: string,
    effectId: string,
): { tone: ArenaStatusBeat['tone']; elementId: string | null; label: string | null } {
    const effect = units
        .find((unit) => unit.id === unitId)
        ?.effects.find((candidate) => candidate.effectId === effectId);

    if (!effect) return { tone: 'neutral', elementId: null, label: null };

    return {
        tone: effect.polarity === 'positive' ? 'buff' : effect.polarity === 'negative' ? 'debuff' : 'neutral',
        elementId: effect.elementId,
        label: effect.statusEffect,
    };
}

/**
 * Builds the choreography for one resolved step.
 *
 * Returns `null` when the step has nothing to show — an empty event list, or events that
 * only move bookkeeping (a turn starting, a cooldown ticking) — in which case the caller
 * applies the new state immediately instead of waiting on an animation.
 */
export function buildArenaSequence(
    id: number,
    events: readonly CombatEvent[],
    state: CombatState,
): ArenaSequence | null {
    const actionUsed = events.find((event) => event.type === 'action_used');

    // Direct blows are merged per target: a chain or splash can land more than one
    // `attack_resolved` on the same unit, and the board should print one total, not
    // one number per hop. Ambient ticks (DoT, regen, upkeep) are kept apart so they
    // never borrow the action's element colour.
    const directHits = new Map<string, ArenaHit>();
    const ambientHits = new Map<string, ArenaHit>();
    const statuses: ArenaStatusBeat[] = [];
    const defeated: string[] = [];
    const reflected: ArenaReflectBeat[] = [];
    const summoned: string[] = [];
    const transformed: string[] = [];
    const stepped: string[] = [];
    let shake = false;

    const pushDirectHit = (
        key: string,
        hit: Omit<ArenaHit, 'delayMs' | 'ambient'>,
    ) => {
        const existing = directHits.get(key);
        if (!existing) {
            directHits.set(key, { ...hit, hits: hit.isHit ? hit.hits : 0, delayMs: 0, ambient: false });
            return;
        }

        existing.amount += hit.amount;
        existing.isHit = existing.isHit || hit.isHit;
        existing.fatal = existing.fatal || hit.fatal;
        // A missed hop still produces a resolution; it must not inflate `×N`.
        existing.hits += hit.isHit ? hit.hits : 0;
    };

    for (const event of events) {
        switch (event.type) {
            case 'attack_resolved': {
                const { resolution } = event;
                const target = state.units.find((unit) => unit.id === resolution.targetId);
                const maxHp = target?.stats.maxHp ?? 0;
                const fatal = resolution.targetHpAfter <= 0;

                if (fatal || (maxHp > 0 && resolution.finalDamage >= maxHp * ARENA_SHAKE_RATIO)) {
                    shake = true;
                }

                pushDirectHit(`damage:${resolution.targetId}`, {
                    targetId: resolution.targetId,
                    amount: resolution.finalDamage,
                    kind: 'damage',
                    isHit: resolution.isHit,
                    elementId: findActionElement(state.units, resolution.actionId),
                    multiplier: resolution.elementMultiplier,
                    fatal,
                    hits: Math.max(1, resolution.hits),
                });
                break;
            }
            case 'healed': {
                const { resolution } = event;
                pushDirectHit(`heal:${resolution.targetId}`, {
                    targetId: resolution.targetId,
                    amount: resolution.amount,
                    kind: 'heal',
                    isHit: true,
                    elementId: findActionElement(state.units, resolution.actionId),
                    multiplier: 1,
                    fatal: false,
                    hits: 1,
                });
                break;
            }
            case 'resource_changed': {
                // Only health is choreographed: the idle mana/stamina curve runs every
                // turn and would bury the board in numbers.
                if (event.resource !== 'hp' || event.previous === event.next) break;

                const amount = Math.abs(event.next - event.previous);
                const kind: ArenaHit['kind'] = event.next < event.previous ? 'damage' : 'heal';
                const fatal = kind === 'damage' && event.next <= 0;
                const key = `${kind}:${event.unitId}`;
                const existing = ambientHits.get(key);

                if (fatal) shake = true;

                if (existing) {
                    existing.amount += amount;
                    existing.fatal = existing.fatal || fatal;
                } else {
                    ambientHits.set(key, {
                        targetId: event.unitId,
                        amount,
                        kind,
                        isHit: true,
                        elementId: null,
                        multiplier: 1,
                        fatal,
                        hits: 1,
                        delayMs: 0,
                        ambient: true,
                    });
                }
                break;
            }
            case 'effect_applied': {
                const applied = findAppliedEffect(state.units, event.unitId, event.effectId);
                statuses.push({
                    unitId: event.unitId,
                    label: event.statusEffect ?? applied.label,
                    tone: applied.tone,
                    elementId: applied.elementId,
                    resisted: false,
                });
                break;
            }
            case 'effect_resisted':
                statuses.push({
                    unitId: event.unitId,
                    label: event.statusEffect,
                    tone: 'neutral',
                    elementId: actionUsed?.elementId ?? null,
                    resisted: true,
                });
                break;
            case 'unit_defeated':
                if (!defeated.includes(event.unitId)) defeated.push(event.unitId);
                break;
            case 'damage_reflected':
                reflected.push({ unitId: event.sourceId, amount: event.amount });
                break;
            case 'unit_summoned':
                if (!summoned.includes(event.unitId)) summoned.push(event.unitId);
                break;
            case 'unit_transformed':
                if (!transformed.includes(event.unitId)) transformed.push(event.unitId);
                break;
            case 'unit_line_changed':
                if (!stepped.includes(event.unitId)) stepped.push(event.unitId);
                break;
            default:
                break;
        }
    }

    // One stagger step per target, in the order the action reached them.
    const targetOrder = new Map<string, number>();
    for (const hit of directHits.values()) {
        if (!targetOrder.has(hit.targetId)) targetOrder.set(hit.targetId, targetOrder.size);
    }
    for (const hit of directHits.values()) {
        hit.delayMs = (targetOrder.get(hit.targetId) ?? 0) * ARENA_HIT_STAGGER_MS;
    }

    const hits: ArenaHit[] = [...directHits.values(), ...ambientHits.values()];

    const actorId = actionUsed?.actorId ?? null;
    const actorName = actorId
        ? state.units.find((unit) => unit.id === actorId)?.name ?? null
        : null;

    const worthShowing = actionUsed !== undefined
        || hits.length > 0
        || statuses.length > 0
        || defeated.length > 0
        || reflected.length > 0
        || summoned.length > 0
        || transformed.length > 0
        || stepped.length > 0;

    if (!worthShowing) return null;

    // Nothing to react to (a brace, a reposition): the actor's motion is the whole beat.
    const quiet = hits.length === 0
        && statuses.length === 0
        && defeated.length === 0
        && reflected.length === 0
        && summoned.length === 0
        && transformed.length === 0
        && stepped.length === 0;

    // Entrances and line changes mount at the impact and can run longer than the
    // settle that follows a blow, so they extend the whole beat when they need to —
    // staggered per extra unit, since they wait for each other to land. Targets are
    // staggered too: the last one's number must still finish before the next turn.
    const enterBursts = Math.max(summoned.length, transformed.length);
    const stepBursts = stepped.length;
    const lastHitDelay = hits.reduce((latest, hit) => Math.max(latest, hit.delayMs), 0);
    const lastStatusDelay = Math.max(0, Math.min(statuses.length - 1, 3)) * ARENA_STATUS_STAGGER_MS;
    const totalMs = Math.max(
        quiet ? ARENA_QUIET_TOTAL_MS : ARENA_TOTAL_MS,
        hits.length > 0 ? ARENA_IMPACT_MS + lastHitDelay + ARENA_SETTLE_MS : 0,
        statuses.length > 0 ? ARENA_IMPACT_MS + lastStatusDelay + ARENA_STATUS_MS : 0,
        enterBursts > 0
            ? ARENA_IMPACT_MS + ARENA_ENTER_MS + Math.max(0, enterBursts - 1) * ARENA_ENTER_STAGGER_MS
            : 0,
        stepBursts > 0
            ? ARENA_IMPACT_MS + ARENA_STEP_MS + Math.max(0, stepBursts - 1) * ARENA_STEP_STAGGER_MS
            : 0,
    );

    return {
        id,
        actorId,
        actorName,
        actionName: actionUsed?.actionName ?? null,
        impactAtMs: ARENA_IMPACT_MS,
        totalMs,
        hits,
        statuses,
        defeated,
        reflected,
        summoned,
        transformed,
        stepped,
        shake,
    };
}

/** Every beat a unit took in a sequence: the direct hit first, then any ambient tick. */
export function hitsFor(
    sequence: ArenaSequence | null | undefined,
    unitId: string,
): ArenaHit[] {
    if (!sequence) return [];
    return sequence.hits.filter((hit) => hit.targetId === unitId);
}

/** The direct hit a unit took in a sequence, if any (ambient ticks excluded). */
export function hitFor(
    sequence: ArenaSequence | null | undefined,
    unitId: string,
): ArenaHit | undefined {
    return hitsFor(sequence, unitId).find((hit) => !hit.ambient);
}
