/**
 * Chaos battlefield mechanics.
 *
 * The pieces here are intentionally generic: marks that detonate on their
 * bearer's turn, serial chains, unstable charges, fields, conductors and
 * resource theft. They read the authored specs added to actions and effects and
 * mutate the state the resolver already owns, so a later element can reuse them
 * without copying the Chaos catalogue.
 */

import type {
    AttackEffect,
    AttackDetonateOnTurnSpec,
    AttackReflectSpec,
} from '../../types/AttackDataType';
import type {
    AttackResolution,
    CombatAction,
    CombatChainSpec,
    CombatDetonateOnTurnSpec,
    CombatEffectInstance,
    CombatEvent,
    CombatInstabilitySpec,
    CombatRandom,
    CombatUnit,
    DamageType,
} from '../../types/CombatType';
import {
    absorbShieldDamage,
    applyEffectToUnit,
    carriesStatusNamed,
    changeResource,
} from './effectResolver';

/** Normalises a status id/label for comparisons. */
function statusKey(value: string | null | undefined): string {
    return (value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

/** Whether a unit carries a status by id or authored label. */
export function hasStatusLabel(unit: CombatUnit, label: string): boolean {
    const wanted = statusKey(label);
    if (!wanted) return false;
    return unit.effects.some((effect) => (
        statusKey(effect.statusEffect) === wanted || statusKey(effect.effectId) === wanted
    ));
}

/** The live charge holder of a status family, if any. */
function chargeHolder(unit: CombatUnit, label: string): CombatEffectInstance | null {
    const wanted = statusKey(label);
    return unit.effects.find((effect) => (
        effect.chargeMax !== undefined
        && (statusKey(effect.statusEffect) === wanted || statusKey(effect.effectId) === wanted)
    )) ?? null;
}

/** Living units in one line, in slot order. */
function lineUnits(units: readonly CombatUnit[], side: CombatUnit['side'], line: CombatUnit['line']): CombatUnit[] {
    return units
        .filter((unit) => unit.status === 'alive' && unit.side === side && unit.line === line)
        .sort((a, b) => a.slot - b.slot);
}

/**
 * Applies flat, defence-ignoring damage and reports it as a normal hit.
 *
 * Chaos aftermath (shrapnel, marks, conductor jumps, reflect) uses flat PWR, so
 * it shares the shield absorption and the arena's `attack_resolved` beat while
 * skipping the attack/defence formula.
 */
export function dealFlatDamage(
    events: CombatEvent[],
    source: CombatUnit,
    target: CombatUnit,
    power: number,
    actionId: string,
    damageType: DamageType,
    random: CombatRandom,
): AttackResolution | null {
    if (power <= 0 || target.status !== 'alive') return null;

    const targetHpBefore = target.currentHp;
    const absorbed = absorbShieldDamage(target, power, random);
    events.push(...absorbed.events);

    const healthDamage = Math.max(0, Math.round(absorbed.leftover));
    target.currentHp = Math.max(0, target.currentHp - healthDamage);

    const resolution: AttackResolution = {
        attackerId: source.id,
        targetId: target.id,
        actionId,
        isHit: true,
        attackMultiplier: 1,
        immune: false,
        hits: 1,
        attackValue: 0,
        defenseValue: 0,
        power,
        damageType,
        elementMultiplier: 1,
        variance: 1,
        positionModifier: 1,
        defenseReduction: 0,
        baseDamage: power,
        finalDamage: healthDamage,
        shielded: power - healthDamage,
        critChance: 0,
        isCrit: false,
        hitChance: 100,
        targetHpBefore,
        targetHpAfter: target.currentHp,
        appliedEffectIds: [],
    };

    events.push({ type: 'attack_resolved', resolution });
    return resolution;
}

/**
 * Resolves every `detonate_on_turn` mark as its bearer's turn opens.
 *
 * The mark pays its bearer (and optionally the whole line), scales with the
 * turns it has waited, caps at `max_power`, and may cost the bearer the turn
 * (`time_bomb`). Expired marks are removed here, before the turn resolves.
 */
export function resolveTurnStartMechanics(
    state: { units: readonly CombatUnit[] },
    unit: CombatUnit,
    random: CombatRandom,
): CombatEvent[] {
    const events: CombatEvent[] = [];

    const marks = unit.effects.filter((effect) => effect.detonateOnTurn);
    if (marks.length === 0) return events;

    for (const mark of marks) {
        const spec = mark.detonateOnTurn as CombatDetonateOnTurnSpec;
        const elapsed = Math.max(0, unit.turnCount - (mark.appliedTurnCount ?? unit.turnCount));
        const scaled = spec.power + (spec.scalePerTurn ?? 0) * elapsed;
        const power = Math.max(0, Math.min(spec.maxPower ?? scaled, scaled));

        const targets = spec.includeLine
            ? [unit, ...lineUnits(state.units, unit.side, unit.line).filter((target) => target.id !== unit.id)]
            : [unit];

        for (const target of targets) {
            dealFlatDamage(
                events,
                unit,
                target,
                power,
                mark.effectId,
                'magical',
                random,
            );
        }

        unit.effects = unit.effects.filter((effect) => effect !== mark);
        events.push({ type: 'effect_expired', unitId: unit.id, effectId: mark.effectId });

        if ((spec.turnSkipChance ?? 0) > 0 && random() < (spec.turnSkipChance ?? 0)) {
            unit.flags.skipTurn = true;
        }
    }

    return events;
}

/**
 * Applies the unstable-explosive ladder after an action.
 *
 * Each explosive use leaves a charge. At the cap the next use may detonate
 * prematurely: the caster pays the authored self-damage and the charges clear
 * instead of growing. The damage multiplier itself lives in the damage
 * calculator, which reads the same charge stacks.
 */
export function applyInstabilityCharge(
    actor: CombatUnit,
    action: CombatAction,
    random: CombatRandom,
): CombatEvent[] {
    const spec = action.instability as CombatInstabilitySpec | null | undefined;
    if (!spec) return [];

    const events: CombatEvent[] = [];
    const label = spec.status?.trim() || 'Instability';
    const max = Math.max(1, Math.round(spec.max ?? 3));
    const holder = chargeHolder(actor, label);
    const stacks = Math.min(max, holder?.stacks ?? 0);

    if (holder && stacks >= max) {
        if ((spec.selfDamage ?? 0) > 0 && random() < (spec.selfDamageChance ?? 0)) {
            events.push(...changeResource(actor, 'hp', -(spec.selfDamage ?? 0)));
        }
        actor.effects = actor.effects.filter((effect) => effect !== holder);
        events.push({ type: 'effect_expired', unitId: actor.id, effectId: holder.effectId });
        return events;
    }

    const synthetic: AttackEffect = {
        effect_id: 'instability_charge',
        status_effect: label,
        turns: Math.max(1, Math.round(spec.turns ?? 3)),
        polarity: 'negative',
        // One extra slot so the fully charged status survives to be read by
        // the *next* explosive instead of releasing at the cap.
        charges: { max: max + 1, initial: 1 },
    };

    const outcome = applyEffectToUnit(actor, synthetic, actor.id, action.elementId, random);
    if (outcome) events.push(outcome);
    return events;
}

/** Picks the next ring of a serial chain, preferring the same line. */
export function selectChainTarget(
    state: { units: readonly CombatUnit[] },
    actor: CombatUnit,
    from: CombatUnit,
    hitIds: ReadonlySet<string>,
    spec: CombatChainSpec,
    random: CombatRandom,
): CombatUnit | null {
    const sides = spec.includeAllies
        ? ['allies', 'enemies']
        : [actor.side === 'allies' ? 'enemies' : 'allies'];

    const candidates = state.units.filter((unit) => (
        unit.status === 'alive'
        && unit.id !== actor.id
        && unit.id !== from.id
        && !hitIds.has(unit.id)
        && sides.includes(unit.side)
    ));
    if (candidates.length === 0) return null;

    const sameLine = candidates.filter((unit) => unit.line === from.line);
    const preferred = sameLine.length > 0
        ? sameLine
        : candidates.filter((unit) => unit.line !== from.line);

    const marked = spec.prioritizeStatus
        ? preferred.filter((unit) => carriesStatusNamed(unit, spec.prioritizeStatus as string))
        : [];
    const pool = marked.length > 0 ? marked : preferred;

    const weighted = pool.map((unit) => ({
        unit,
        weight: spec.weightedBacklane && unit.line === 'rear' ? 0.8 : 1,
    }));
    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) return weighted[0]?.unit ?? null;

    let roll = random() * total;
    for (const entry of weighted) {
        roll -= entry.weight;
        if (roll <= 0) return entry.unit;
    }
    return weighted[weighted.length - 1]?.unit ?? null;
}

/** A random living enemy in the rear line, or `null` when none is there. */
export function selectBacklaneTarget(
    state: { units: readonly CombatUnit[] },
    actor: CombatUnit,
    excludeIds: ReadonlySet<string>,
    random: CombatRandom,
): CombatUnit | null {
    const enemies = state.units.filter((unit) => (
        unit.status === 'alive'
        && unit.side !== actor.side
        && unit.line === 'rear'
        && !excludeIds.has(unit.id)
    ));
    if (enemies.length === 0) return null;
    return enemies[Math.floor(random() * enemies.length)] ?? null;
}

/** The allies a reckless blast splashes onto. */
export function selectFriendlyFireTargets(
    state: { units: readonly CombatUnit[] },
    actor: CombatUnit,
    scope: 'allies_all' | 'allies_lane',
    line: CombatUnit['line'],
): CombatUnit[] {
    return state.units.filter((unit) => (
        unit.status === 'alive'
        && unit.id !== actor.id
        && unit.side === actor.side
        && (scope === 'allies_all' || unit.line === line)
    ));
}

/** A random entity a shrapnel projectile can clip, allies included. */
export function selectShrapnelTarget(
    state: { units: readonly CombatUnit[] },
    actor: CombatUnit,
    primary: CombatUnit | null,
    includeAllies: boolean,
    focusStatus: string | null,
    random: CombatRandom,
): CombatUnit | null {
    if (focusStatus && primary && hasStatusLabel(actor, focusStatus) && primary.status === 'alive') {
        return primary;
    }

    const pool = state.units.filter((unit) => (
        unit.status === 'alive'
        && unit.id !== actor.id
        && (includeAllies || unit.side !== actor.side)
    ));
    if (pool.length === 0) return null;
    return pool[Math.floor(random() * pool.length)] ?? null;
}

/** Entities caught in a secondary blast around a defeated target. */
export function selectOnKillTargets(
    state: { units: readonly CombatUnit[] },
    defeated: CombatUnit,
    includeAllies: boolean,
): CombatUnit[] {
    return state.units.filter((unit) => (
        unit.status === 'alive'
        && unit.id !== defeated.id
        && unit.line === defeated.line
        && (includeAllies || unit.side !== defeated.side)
    ));
}

/** The nearest enemy of a conductor, used by its jump. */
export function selectConductorTarget(
    state: { units: readonly CombatUnit[] },
    conductor: CombatUnit,
): CombatUnit | null {
    const enemies = state.units
        .filter((unit) => unit.status === 'alive' && unit.side !== conductor.side)
        .sort((a, b) => {
            const lineDistance = (unit: CombatUnit): number => Math.abs(
                (unit.line === 'front' ? 0 : 1) - (conductor.line === 'front' ? 0 : 1),
            );
            return lineDistance(a) - lineDistance(b) || Math.abs(a.slot - conductor.slot) - Math.abs(b.slot - conductor.slot);
        });
    return enemies[0] ?? null;
}

/** Whether an action kind is one an interrupt status watches. */
function interruptMatches(actions: readonly string[] | undefined, action: CombatAction): boolean {
    const kinds = actions && actions.length > 0 ? actions : ['skill', 'weapon'];
    if (kinds.includes(action.kind)) return true;
    return (action.kind === 'skill' || action.kind === 'weapon') && kinds.includes('attack');
}

/**
 * Checks whether a `shock`-style status interrupts the action about to be used.
 *
 * The caller still pays the costs; the action simply fails and the status is
 * consumed, so a paralysis buys its victim one wasted turn.
 */
export function checkInterrupt(
    actor: CombatUnit,
    action: CombatAction,
    random: CombatRandom,
): CombatEffectInstance | null {
    for (const effect of actor.effects) {
        const spec = effect.interrupt;
        if (!spec) continue;
        if (!interruptMatches(spec.actions ?? undefined, action)) continue;
        if (random() >= spec.chance) continue;
        return effect;
    }
    return null;
}

/**
 * Builds the synthetic conductor effect created when a Lapis skill grounds it.
 *
 * Kept here so the action resolver does not own the shield arithmetic.
 */
export function groundConductorShield(
    conductor: CombatEffectInstance,
): AttackEffect | null {
    const percent = conductor.conductor?.groundShieldPercent ?? 0;
    if (percent <= 0) return null;
    return {
        effect_id: `${conductor.effectId}_grounded`,
        status_effect: 'Grounded',
        turns: 2,
        polarity: 'positive',
        shield: { percent_of_max_hp: percent },
    };
}

/** Flat reflect damage paid by a status, clamped to the authored power. */
export function reflectPower(spec: AttackReflectSpec | null | undefined): number {
    return Math.max(0, Math.round(spec?.power ?? 0));
}

/**
 * A convenience bundle for a detonation mark's authored spec.
 *
 * Kept exported so tests and the forger parity notes can read the same shape.
 */
export function readDetonation(spec: AttackDetonateOnTurnSpec | null | undefined): AttackDetonateOnTurnSpec | null {
    return spec ?? null;
}
