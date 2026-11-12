/**
 * The single health-damage sink.
 *
 * Every hit that reaches a health pool — a resolved attack, Chaos aftermath, a
 * reflected status — goes through {@link applyHealthDamage}, so the suspension
 * bank, the rune rescue, the `damage_taken` counter, the Spatium echo and the
 * chant interruption happen exactly once and in the same order.
 *
 * The attack/defence formula stays in `damageCalculator`/`actionResolver`; this
 * module only owns what happens after a number is known to reach health.
 */

import type { CombatEvent, CombatRandom, CombatUnit } from '../../types/CombatType';
import {
    captureRuneReturn,
    interruptChantOnDamage,
    recordRuneDamage,
} from './effectResolver';
import { deferSuspendedDamage, recordEchoDamage } from './spatiumMechanics';

export interface HealthDamageOptions {
    /** Who caused the damage, recorded by the rescue rune. */
    sourceId?: string;
    /** Element of the hit, recorded by the rescue rune. */
    elementId?: string | null;
    /** Fraction of the damage the caster's echo mark records. */
    echoPercent?: number;
    /** Bank the hit in a time suspension instead of applying it (default `true`). */
    deferSuspension?: boolean;
    /** Let a rescue rune cancel the hit (default `true`). */
    captureRune?: boolean;
    /** Update `damage_taken`, the echo and the chant (default `true`). */
    track?: boolean;
    random?: CombatRandom;
}

export interface HealthDamageResult {
    /** How much the health pool actually lost. */
    damage: number;
    events: CombatEvent[];
}

/** Applies damage to a unit's health pool after every mitigation is done. */
export function applyHealthDamage(
    target: CombatUnit,
    amount: number,
    options: HealthDamageOptions = {},
): HealthDamageResult {
    let damage = Math.max(0, Math.round(amount));
    if (damage <= 0 || target.status !== 'alive') return { damage: 0, events: [] };

    const random = options.random ?? Math.random;

    if (options.deferSuspension !== false && deferSuspendedDamage(target, damage)) {
        return { damage: 0, events: [] };
    }
    if (options.captureRune !== false && captureRuneReturn(
        target,
        damage,
        'damage',
        options.sourceId ?? '',
        options.elementId ?? null,
    )) {
        return { damage: 0, events: [] };
    }

    target.currentHp = Math.max(0, target.currentHp - damage);

    const events: CombatEvent[] = [];
    if (options.track !== false) {
        target.eventCounts.damage_taken = (target.eventCounts.damage_taken ?? 0) + damage;
        recordEchoDamage(target, damage, options.echoPercent ?? 0);
        recordRuneDamage(target, damage);
        events.push(...interruptChantOnDamage(target, random));
    }

    return { damage, events };
}

export interface ReflectDamageMeta {
    abilityId: string;
    abilityName: string;
    /** Whether the reflection roll landed; a miss still reports a `0` event. */
    isHit?: boolean;
}

/**
 * Pays reflected damage and reports it as a `damage_reflected` event.
 *
 * Reflection is not a tracked hit: it must not count as damage taken or feed
 * the echo, so the health sink runs with `track: false`.
 */
export function reflectHealthDamage(
    reflector: CombatUnit,
    attacker: CombatUnit,
    amount: number,
    meta: ReflectDamageMeta,
): CombatEvent {
    const dealt = applyHealthDamage(attacker, amount, { track: false });
    return {
        type: 'damage_reflected',
        sourceId: reflector.id,
        targetId: attacker.id,
        abilityId: meta.abilityId,
        abilityName: meta.abilityName,
        isHit: meta.isHit ?? true,
        amount: dealt.damage,
        targetHpAfter: attacker.currentHp,
    };
}
