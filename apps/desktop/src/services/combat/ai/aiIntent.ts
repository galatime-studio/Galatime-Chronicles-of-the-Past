/**
 * What an action is *for*, independent of its raw `targeting` rule.
 *
 * Shared by the candidate builder (which refuses aims on the wrong side) and the
 * target bias (which still discounts one if it ever reaches scoring, as a
 * damaging item aimed at an ally would).
 */

import type { CombatAction, CombatUnit } from '../../../types/CombatType';
import { asRecord } from '../../../utils/combatUtils';

/** Status-only payloads whose value belongs on an enemy. */
const OFFENSIVE_STATUS_NAMES = new Set([
    'wet', 'mud', 'mud seal', 'buried in mud', 'freezing', 'frozen', 'burn', 'burning',
    'overheat', 'poison', 'bleed', 'slow', 'weakness', 'silence', 'stun', 'daze',
    'blind', 'fear',
]);

/** Status-only payloads whose value belongs on an ally. */
const SUPPORTIVE_STATUS_NAMES = new Set([
    'regen', 'regeneration', 'fortify', 'fortified', 'shield', 'shielded', 'haste',
    'evasion', 'barrier',
]);

export type ActionIntent = 'offensive' | 'supportive' | 'neutral';

/**
 * What the action is aimed at, independent of its raw `targeting` rule.
 *
 * Damage and control point at enemies; healing, buffs and protection point at
 * allies. A mixed action (a damaging hit that also buffs its caster, a debuff
 * that drains) is treated as offensive, because its target choice is the enemy.
 * Without this, a pure shield or cleanse had no side and could be aimed at an
 * enemy without penalty.
 *
 * A raw stat reduction on its own is not enough to make an action offensive:
 * defensive buffs often trade a little of one stat away, and reading that as
 * "aim it at the enemy" made the AI cast its own walls on the other side. The
 * precedence is real harm first, then benefit, then a bare debuff.
 */
export function actionIntent(action: CombatAction): ActionIntent {
    if (action.dealsDamage) return 'offensive';

    // The targeting rule is the strongest signal when the author spelled it out:
    // an ally-only buff is supportive even if it also denies a lane switch, and
    // an enemy-wide mudslide is offensive even if it also slows.
    if (action.targeting === 'self' || action.targeting === 'allies_all') return 'supportive';
    if (action.targeting === 'enemies_all' || action.targeting === 'enemies_lane') return 'offensive';
    if (action.targeting === 'both_teams') return 'neutral';

    let harmful = false;
    let helpful = false;
    let debuff = false;

    for (const effect of action.effects ?? []) {
        const record = asRecord(effect);
        if (!record) continue;

        const status = normalizeStatus(record.status_effect);
        if (status && OFFENSIVE_STATUS_NAMES.has(status)) harmful = true;
        if (status && SUPPORTIVE_STATUS_NAMES.has(status)) helpful = true;

        if (hasEntries(record.damage_per_turn)
            || readNumber(record.damage, 0) > 0
            || hasEntries(record.resource_drain)
            || hasEntries(record.prevent_actions)
            || record.prevent_skills === true
            || hasEntries(record.prevent_ranges)
            || hasEntries(record.prevent_elements)
            || record.confuse === true
            || hasEntries(record.turn_postpone)
            || hasEntries(record.suspend)
            || hasEntries(record.anchor)
            || hasEntries(record.gravity_zone)
            || hasEntries(record.rift_mark)
            || record.locks_target === true
            || hasEntries(record.cost_multiplier)
            || hasEntries(record.end_cost)
            || hasEntries(record.on_death_blast)) {
            harmful = true;
        }

        // A stat reduction is only a plan of its own when nothing else on the
        // effect explains what the cast is for.
        if (hasEntries(record.debuff)) debuff = true;

        if (action.heals
            || hasEntries(record.buff)
            || hasEntries(record.shield)
            || hasEntries(record.barrier)
            || record.taunt === true
            || hasEntries(record.intercept)
            || hasEntries(record.damage_redirect)
            || record.counter === true
            || hasEntries(record.reflect)
            || record.evade_next === true
            || record.untargetable === true
            || hasEntries(record.regen_per_turn)
            || hasEntries(record.regen_per_turn_percent)
            || hasEntries(record.heal_percent_of_max)
            || hasEntries(record.cleanse)
            || hasEntries(record.cleanse_per_turn)
            || hasEntries(record.resource_regen)
            || hasEntries(record.resource_transfer)) {
            helpful = true;
        }
    }

    if (harmful) return 'offensive';
    if (helpful) return 'supportive';
    if (debuff) return 'offensive';
    return 'neutral';
}

/**
 * Whether a target sits on the side the action does not serve: a blow at an
 * ally, a mend at an enemy.
 *
 * Friendly fire is legal in the engine, but it is never a *plan* — a difficulty
 * level may make a unit blunder, not make it attack its own team. Two places
 * enforce it: the candidate builder drops these aims outright, and the target
 * bias keeps its discount for anything that reaches scoring another way.
 */
export function isWrongSideTarget(
    actor: CombatUnit,
    intent: ActionIntent,
    target: CombatUnit,
): boolean {
    if (intent === 'offensive') return target.side === actor.side;
    if (intent === 'supportive') return target.side !== actor.side;
    return false;
}

/** Whether a clause is present and non-empty. */
function hasEntries(value: unknown): boolean {
    if (value === true) return true;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.length > 0;
    const record = asRecord(value);
    if (!record) return false;
    return Object.keys(record).length > 0;
}

/** Lowercase status ids/labels so `Mud_Seal`, `mud seal` and `Mud Seal` match. */
function normalizeStatus(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ');
    return normalized.length > 0 ? normalized : null;
}

/** Reads a numeric field from an untyped effect clause. */
function readNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
