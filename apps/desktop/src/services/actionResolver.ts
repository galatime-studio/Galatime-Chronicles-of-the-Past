/**
 * Action resolver.
 *
 * Turns one validated action into the damage it deals, the effects it applies
 * and the feedback the HUD plays. It mutates the units it touches and returns
 * the events; deciding *when* an action may run is the session service's job.
 *
 * Resolution order for an attack is: `before_attack`, roll hits per target, apply
 * the main damage, apply the action's effects (honouring each effect's own
 * `apply_to` scope — which wakes `on_status_applied` where they land), let the
 * targets' reactive abilities fire, reap the defeated (firing their `on_death`
 * abilities), then report the attack itself as `after_attack` and `on_hit` or
 * `on_miss`. Effects are applied before the resolutions are emitted so each
 * resolution can list the effects it landed.
 */

import { COUNTER_REFLECT_FRACTION } from '../constants/CombatConstants';
import type { AttackEffect } from '../types/AttackDataType';
import type {
    CombatEffectInstance,
    AttackResolution,
    CombatAction,
    CombatElementIndex,
    CombatEvent,
    CombatOutcome,
    CombatRandom,
    CombatState,
    CombatUnit,
    DamageType,
} from '../types/CombatType';
import { asRecord, readBoolean, readNumber, readString } from '../utils/combatUtils';
import type { AbilityTriggerContext } from './combat/abilityContext';
import { foldAttackModifiers } from './combat/abilityModifiers';
import { resolveAbilityEvent } from './combat/abilityTriggers';
import { phaseEffectMultiplier, resolveDamage, isProjectileAction } from './combat/damageCalculator';
import { reapDefeated, promoteRearLines } from './combat/defeatResolver';
import { idleRegenAmount } from './combat/resourceRegen';
import {
    absorbShieldDamage,
    applyEffectResources,
    applyEffectToUnit,
    bonusVsHpBelowFromEffects,
    changeResource,
    claimTargetLock,
    confusionChance,
    effectiveStats,
    expireStatusesOnElementHit,
    isHealBlocked,
    invertBuffsOn,
    liftLuxCurses,
    resolveEffectTargets,
} from './combat/effectResolver';
import {
    applyCleanse,
    applyDispel,
    applyMove,
    applyMoveSpec,
    applyRewind,
    applyTurnPostpone,
    effectConditionSatisfied,
    readConditionRecord,
} from './combat/effectMechanics';
import { reachableTargets, scatterCandidates } from './combat/targetResolver';
import { effectiveTimePhase, setPhaseBlock } from './combat/phaseOverride';
import { canPlaceInLine, moveUnitToLine, wouldLeaveFrontLineEmpty } from './combat/positionRules';
import { fleeChanceFor } from './combat/fleeRules';
import {
    applyInstabilityCharge,
    dealFlatDamage,
    groundConductorShield,
    hasStatusLabel,
    selectBacklaneTarget,
    selectChainTarget,
    selectConductorTarget,
    selectFriendlyFireTargets,
    selectOnKillTargets,
    selectShrapnelTarget,
} from './combat/chaosMechanics';
import { weaponStackMultiplier, effectPowerMultiplier } from './combat/weaponEffects';
import { applyWeaponActionHooks } from './combat/weaponActionHooks';
import { applyWeather, readWeatherSpec, weatherElementMultiplierFor } from './combat/weather';

export interface ActionResolutionContext {
    state: CombatState;
    actor: CombatUnit;
    action: CombatAction;
    /** The chosen target for `any_one`; `null` for rule-based actions. */
    target: CombatUnit | null;
    elementIndex: CombatElementIndex;
    random: CombatRandom;
    /**
     * The actor's live inventory for this fight, when the caller has one
     * (the session owns it). Weapon ammo is spent against it, so arrows shot
     * leave the quiver at the end of the fight.
     */
    unitInventory?: Record<string, number>;
}

export interface ActionResolution {
    events: CombatEvent[];
    /** Set when the action itself ends the fight (a successful `flee`). */
    outcome: CombatOutcome | null;
}

/** The units an action addresses: the named one, or every reachable candidate. */
function resolveActionTargets(context: ActionResolutionContext): CombatUnit[] {
    const { state, actor, action, target } = context;
    // A scatter action does not aim: every ray draws its own target, so the
    // action addresses the whole pool.
    if (action.scatterTargets && action.dealsDamage) {
        return scatterCandidates(state.units, actor, action);
    }
    if (action.targeting === 'any_one' && target) return [target];
    // A lane-scoped action (`avalanche`) crashes over the aim's whole lane:
    // every living member of the aim's side standing in its line.
    if (action.targeting === 'enemies_lane' && target) {
        return state.units.filter((unit) => (
            unit.status === 'alive'
            && unit.side === target.side
            && unit.line === target.line
        ));
    }
    return reachableTargets(state.units, actor, action);
}

/**
 * The context an attack's own abilities are evaluated against.
 *
 * `source` is the actor and `target` the unit it aimed at, so `scope: attacker`
 * and `scope: defender` mean the same thing here as they do in a damage event.
 */
function attackAbilityContext(
    context: ActionResolutionContext,
    primaryTarget: CombatUnit | null,
): AbilityTriggerContext {
    return {
        source: context.actor,
        target: primaryTarget,
        damageType: context.action.damageType,
        elementId: context.action.elementId,
        damage: 0,
        units: context.state.units,
        random: context.random,
    };
}

/**
 * Applies any eclipse block the action authors (`block_lunar` / `block_solar`).
 *
 * Lunar eclipses only take effect during the night and solar only during the
 * day; a cast outside its window does nothing. It runs after the action's own
 * hit and effects, so the eclipse cannot change the cast that created it.
 */
function resolveForcedPhase(
    state: CombatState,
    actor: CombatUnit,
    action: CombatAction,
): void {
    for (const effect of action.effects) {
        const record = asRecord(effect);
        if (!record) continue;

        const rounds = Math.max(1, Math.round(readNumber(record.phase_rounds ?? record.turns, 5)));
        const blocksLunar = readBoolean(record.block_lunar, false);
        const blocksSolar = readBoolean(record.block_solar, false);
        // An author who writes both flags means *hide whichever body is up now*
        // (`Clouds` nulls the day's solar or the night's lunar, automatically).
        if (blocksLunar && blocksSolar) {
            const blocked = state.timePhase === 'night' ? 'lunar' : 'solar';
            setPhaseBlock(state, blocked, rounds, actor.id);
            return;
        }
        if (blocksLunar) {
            if (state.timePhase === 'night') setPhaseBlock(state, 'lunar', rounds, actor.id);
            return;
        }
        if (blocksSolar) {
            if (state.timePhase === 'day') setPhaseBlock(state, 'solar', rounds, actor.id);
            return;
        }
    }
}

/** Resolves a submitted action. Assumes the action was already validated. */
export function resolveCombatAction(context: ActionResolutionContext): ActionResolution {
    const { state, actor, action } = context;
    const events: CombatEvent[] = [
        {
            type: 'action_used',
            actorId: actor.id,
            actionId: action.id,
            actionName: action.name,
            kind: action.kind,
            targetIds: resolveActionTargets(context).map((unit) => unit.id),
            elementId: action.elementId,
            sfxId: action.sfxId ?? null,
        },
    ];

    let outcome: CombatOutcome | null = null;

    switch (action.kind) {
        case 'defend':
            actor.defending = true;
            break;
        case 'rest':
            events.push(...resolveRest(context));
            break;
        case 'flee':
            outcome = resolveFlee(context, events);
            break;
        case 'skill':
        case 'weapon': {
            const attackContext = attackAbilityContext(context, resolveActionTargets(context)[0] ?? null);
            events.push(...resolveAbilityEvent(state, actor, 'before_attack', attackContext));

            const attackEvents = resolveAttack(context);
            events.push(...attackEvents);

            // A battlefield-phase override lands after the cast that authored
            // it, so an eclipse does not change its own damage retroactively.
            resolveForcedPhase(state, actor, action);

            const landed = attackEvents.some(
                (event) => event.type === 'attack_resolved' && event.resolution.isHit,
            );

            // Weapon bookkeeping: bank the hit streak, spend ammo, wear durability
            // (and destroy the weapon at 0). Runs before the actor's own
            // after_attack abilities so a broken weapon is already gone.
            if (action.kind === 'weapon') {
                const resolutions = attackEvents
                    .filter((event): event is Extract<CombatEvent, { type: 'attack_resolved' }> => event.type === 'attack_resolved')
                    .map((event) => event.resolution);
                events.push(...applyWeaponActionHooks(
                    actor,
                    action,
                    resolutions,
                    context.random,
                    context.unitInventory,
                ));
            }

            events.push(...resolveAbilityEvent(state, actor, 'after_attack', attackContext));
            events.push(...resolveAbilityEvent(state, actor, landed ? 'on_hit' : 'on_miss', attackContext));
            break;
        }
        case 'inventory':
            // Items are not wired to the backend yet; the service rejects this kind.
            break;
        case 'switch_line':
            events.push(...resolveSwitchLine(context));
            break;
    }

    return { events, outcome };
}

function resolveSwitchLine(context: ActionResolutionContext): CombatEvent[] {
    const { state, actor } = context;
    const targetLine = actor.line === 'front' ? 'rear' : 'front';

    if (!moveUnitToLine(state.units, actor, targetLine)) return [];

    return [{ type: 'unit_line_changed', unitId: actor.id, line: actor.line, slot: actor.slot }];
}

function resolveRest(context: ActionResolutionContext): CombatEvent[] {
    const { actor } = context;
    const stats = effectiveStats(actor);
    const events: CombatEvent[] = [];

    for (const resource of ['mana', 'stamina'] as const) {
        // Rest is one extra idle step: advance the Fibonacci streak and pay the
        // step it reaches. Spending still resets the streak on the next tick,
        // so resting never undoes the cost of a previous turn.
        actor.resourceIdleTurns[resource] += 1;
        const max = resource === 'mana' ? stats.maxMana : stats.maxStamina;
        if (max <= 0) continue;

        events.push(
            ...changeResource(actor, resource, idleRegenAmount(max, actor.resourceIdleTurns[resource])),
        );
    }

    return events;
}

/**
 * Rolls a panic escape.
 *
 * The unit must already be below its health gate (the service refuses the
 * action otherwise), so this only owns the dice and the consequence. A
 * player-controlled success ends the fight as `'fled'`; an enemy success takes
 * that enemy out of the fight instead, leaving the rest of the battle running.
 */
function resolveFlee(context: ActionResolutionContext, events: CombatEvent[]): CombatOutcome | null {
    const { actor, state } = context;
    const chance = fleeChanceFor(actor);
    const escaped = chance > 0 && context.random() < chance;

    events.push({ type: 'flee_attempted', unitId: actor.id, escaped });

    if (!escaped) return null;
    if (actor.isPlayerControlled) return 'fled';

    // An enemy that escapes is out of the fight but was not killed: mark it so
    // victory still resolves, keep it out of the loot table, and let the rear
    // line step up if it was holding the front.
    actor.status = 'defeated';
    actor.flags.fled = true;
    promoteRearLines(state, events);
    return null;
}

/** Consumes a live dodge status that answers this damage channel. */
function consumeEvade(
    target: CombatUnit,
    damageType: DamageType,
    random: CombatRandom,
    events: CombatEvent[],
): CombatEffectInstance | null {
    const evade = target.effects.find((effect) => effect.evadeNext
        && (!effect.evadeNext.damageTypes?.length || effect.evadeNext.damageTypes.includes(damageType))
        && random() < effect.evadeNext.chance);
    if (!evade) return null;

    target.effects = target.effects.filter((effect) => effect !== evade);
    events.push({ type: 'effect_expired', unitId: target.id, effectId: evade.effectId });
    return evade;
}

/** A resolution for a hit that was dodged before it could land. */
function makeMissResolution(actor: CombatUnit, target: CombatUnit, action: CombatAction): AttackResolution {
    return {
        attackerId: actor.id,
        targetId: target.id,
        actionId: action.id,
        isHit: false,
        attackMultiplier: 1,
        immune: false,
        hits: 0,
        attackValue: 0,
        defenseValue: 0,
        power: action.power,
        damageType: action.damageType,
        elementMultiplier: 1,
        variance: 1,
        positionModifier: 1,
        defenseReduction: 0,
        baseDamage: 0,
        finalDamage: 0,
        shielded: 0,
        critChance: 0,
        isCrit: false,
        hitChance: action.accuracy,
        targetHpBefore: target.currentHp,
        targetHpAfter: target.currentHp,
        appliedEffectIds: [],
    };
}

/**
 * Rolls one target's damage and records the whole chain.
 *
 * The numbers come from {@link resolveDamage}, so a real hit and the HUD preview
 * can never drift apart.
 */
function buildResolution(
    context: ActionResolutionContext,
    target: CombatUnit,
    options: { attempts?: number; action?: CombatAction } = {},
): AttackResolution {
    const { actor, elementIndex, random, state } = context;
    const action = options.action ?? context.action;
    // A `bulwark` ally takes the blow aimed at its protected friend; a clay
    // doll intercepts it first, with a chance the blow breaks through.
    const cover = findCover(state.units, target);
    const recipient = cover ?? target;
    // A clay doll/sentinel on the bearer absorbs the next hit(s); a roll may let
    // the blow break through instead.
    const interceptEffect = recipient.effects.find((effect) => effect.intercept
        && effect.intercept.hits > 0);
    let intercepted = false;
    if (interceptEffect?.intercept) {
        const spec = interceptEffect.intercept;
        spec.hits -= 1;
        intercepted = random() >= spec.breakChance;
        if (spec.hits <= 0) {
            recipient.effects = recipient.effects.filter((effect) => effect !== interceptEffect);
        }
    }

    const result = resolveDamage({
        action,
        attempts: options.attempts,
        attackerStats: effectiveStats(actor),
        defenderStats: effectiveStats(recipient),
        defenderElementIds: recipient.elementIds,
        defender: recipient,
        attacker: actor,
        weather: state.weather ?? null,
        elementIndex,
        attackerLine: actor.line,
        defenderLine: recipient.line,
        sameSide: actor.side === recipient.side,
        defenderDefending: recipient.defending,
        // The hour of the day decides what a solar or lunar action is worth.
        timePhase: effectiveTimePhase(state),
        // The wounded-target bonus reads how much of its health is left.
        defenderHpFraction: hpFraction(recipient),
        // A status such as Blood Moon can add damage against wounded targets.
        attackerTraits: bonusVsHpBelowFromEffects(actor, hpFraction(recipient)),
        modifier: foldAttackModifiers(
            recipient,
            { damageType: action.damageType, elementId: action.elementId },
            random,
            state.units,
            actor,
            weaponStackMultiplier(actor, action),
        ),
        random,
    });

    const targetHpBefore = recipient.currentHp;
    // A wall status crumbles only to a critical or super-effective hit.
    if (result.isCrit || result.elementMultiplier > 1) {
        recipient.effects = recipient.effects.filter((effect) => {
            if (!effect.barrier) return true;
            if (result.isCrit && effect.barrier.breakOnCrit) return false;
            if (result.elementMultiplier > 1 && effect.barrier.breakOnSuperEffective) return false;
            return true;
        });
    }
    // A live status shield (Condensation, and later the ice walls) soaks the
    // hit before the holder's health pays: shields absorb first, health next.
    const ward = recipient.effects.find((effect) => effect.damageReduction
        && effect.damageReduction.charges > 0);
    const reduced = intercepted
        ? 0
        : (ward?.damageReduction
            ? Math.max(0, Math.round(result.finalDamage * (1 - ward.damageReduction.percent)))
            : Math.max(0, result.finalDamage));
    if (ward?.damageReduction) {
        ward.damageReduction.charges -= 1;
        if (ward.damageReduction.charges <= 0) {
            recipient.effects = recipient.effects.filter((effect) => effect !== ward);
        }
    }
    const shield = absorbShieldDamage(recipient, reduced, random);
    const healthDamage = shield.leftover;
    if (healthDamage > 0) {
        recipient.currentHp = Math.max(0, recipient.currentHp - healthDamage);
        recipient.eventCounts.damage_taken = (recipient.eventCounts.damage_taken ?? 0) + healthDamage;
    }

    return {
        attackerId: actor.id,
        targetId: recipient.id,
        actionId: action.id,
        ...result,
        finalDamage: healthDamage,
        shielded: reduced - healthDamage,
        targetHpBefore,
        targetHpAfter: recipient.currentHp,
        appliedEffectIds: [],
    };
}

/** The `bulwark` unit that steps in front of `target`, if any. */
function findCover(units: readonly CombatUnit[], target: CombatUnit): CombatUnit | null {
    if (target.effects.some((effect) => effect.damageRedirect)) return null;
    return units.find((unit) => (
        unit.id !== target.id
        && unit.status === 'alive'
        && unit.side === target.side
        && unit.effects.some((effect) => effect.damageRedirect
            && (effect.damageRedirect.scope === 'allies_all' || unit.line === target.line))
    )) ?? null;
}

/** How much of its maximum health a unit still has, as a fraction. */
function hpFraction(unit: CombatUnit): number {
    const max = effectiveStats(unit).maxHp;
    return max > 0 ? unit.currentHp / max : 0;
}

/**
 * Rolls a scatter action's rays.
 *
 * Each ray picks a random living enemy from the pool, so the same unit may take
 * several rays and the back line can be reached without a lane penalty when the
 * action authors `can_hit_any_enemy` / `ignore_position_penalty`. A ray that
 * empties a target's health removes it from the pool for the remaining rays;
 * the deaths themselves are reaped once the whole cast is over.
 */
function rollScatter(
    context: ActionResolutionContext,
    pool: readonly CombatUnit[],
    resolutions: Map<string, AttackResolution>,
): void {
    const { action, random } = context;
    const rays = Math.max(1, action.scatterHits ?? action.hitCount);
    const candidates = [...pool];

    for (let ray = 0; ray < rays && candidates.length > 0; ray += 1) {
        // Clamp only guards a random source that returns exactly `1`.
        const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
        const target = candidates[index];

        // One ray is one hit: the damage chain must not multiply it by hitCount.
        const resolution = buildResolution(context, target, { attempts: 1 });
        const existing = resolutions.get(target.id);
        resolutions.set(target.id, existing ? mergeResolution(existing, resolution) : resolution);

        if (target.currentHp <= 0) candidates.splice(index, 1);
    }
}

/** Folds one scatter ray's outcome into the target's running total. */
function mergeResolution(into: AttackResolution, ray: AttackResolution): AttackResolution {
    return {
        ...into,
        isHit: into.isHit || ray.isHit,
        hits: into.hits + ray.hits,
        isCrit: into.isCrit || ray.isCrit,
        finalDamage: into.finalDamage + ray.finalDamage,
        shielded: into.shielded + ray.shielded,
        targetHpAfter: ray.targetHpAfter,
    };
}

/**
 * Throws a `collateral` splash at the aimed targets' neighbours.
 *
 * Every living unit sharing the main target's side and line — which was not
 * already aimed or splashed — takes a reduced copy of the hit (`riptide`
 * drenches the line next to the pulled victim). Returns how much damage each
 * main target's splash dealt, so the caster's `drain_percent_of_damage` can
 * heal off the whole tide, not just its first wave; a shared neighbour is
 * rolled once and only attributed to its first puller.
 */
function resolveCollateralDamage(
    context: ActionResolutionContext,
    actionTargets: readonly CombatUnit[],
    resolutions: Map<string, AttackResolution>,
): Map<string, number> {
    const { state, actor, random } = context;
    const action = context.action;
    const collateral = action.collateral;
    const extra = new Map<string, number>();
    if (!collateral || !action.dealsDamage) return extra;

    // A chance autorizada decide (uma vez por feitiço) se o splash sai.
    if ((collateral.chance ?? 1) < 1 && random() >= (collateral.chance ?? 1)) return extra;

    const splashPower = Math.round(action.power * collateral.damageMultiplier * 10) / 10;
    if (splashPower <= 0) return extra;
    const splashAction: CombatAction = { ...action, power: splashPower };

    for (const primary of actionTargets) {
        const main = resolutions.get(primary.id);
        if (!main || !main.isHit) continue;

        const candidates = state.units.filter((unit) => (
            unit.status === 'alive'
            && unit.id !== primary.id
            && !resolutions.has(unit.id)
            && unit.side === primary.side
            && unit.line === primary.line
        ));
        const pool = collateral.includeCaster && actor.status === 'alive' && !resolutions.has(actor.id)
            ? [...candidates, actor]
            : candidates;

        for (const adjacent of pool) {
            const resolution = buildResolution(context, adjacent, { attempts: 1, action: splashAction });
            const existing = resolutions.get(adjacent.id);
            resolutions.set(adjacent.id, existing ? mergeResolution(existing, resolution) : resolution);
            if (!resolution.isHit) continue;

            // Splash damage is double-keyed: under the neighbour for its own
            // `attack_resolved`, under the puller for a drain that reads it.
            const attributed = extra.get(primary.id) ?? 0;
            extra.set(primary.id, attributed + resolution.finalDamage);
        }
    }

    return extra;
}

/**
 * Spends a `bonus_per_charge` trait's charges: the consuming hit strips the
 * whole stacking status from every target it hit (`avalanche` burns Freeze).
 */
function consumeCharges(
    target: CombatUnit,
    spec: { status: string; multiplierPerCharge: number; consume: boolean } | null | undefined,
): CombatEvent[] {
    if (!spec || !spec.consume) return [];

    const wanted = spec.status.trim().toLowerCase();
    const consumed = target.effects.filter((effect) => (
        effect.chargeMax
        && (effect.statusEffect ?? '').trim().toLowerCase() === wanted
    ));
    if (consumed.length === 0) return [];

    const consumedIds = new Set(consumed.map((effect) => effect.effectId));
    target.effects = target.effects.filter((effect) => !consumedIds.has(effect.effectId));

    return consumed.map((effect) => ({
        type: 'effect_expired' as const,
        unitId: target.id,
        effectId: effect.effectId,
    }));
}

/**
 * Whether an action is aimed at the enemy side.
 *
 * Only these actions can be turned by confusion; a self-buff or a team heal is
 * never redirected.
 */
function isHostileAction(action: CombatAction): boolean {
    return action.dealsDamage
        || action.targeting === 'any_one'
        || action.targeting === 'enemies_all';
}

/**
 * The actor's own side, as the target of a confused action.
 *
 * A single-target action picks one ally at random (the actor included); an area
 * action covers the whole side, mirroring how it would have covered the enemy
 * side.
 */
function confusedTargets(
    state: CombatState,
    actor: CombatUnit,
    action: CombatAction,
    random: CombatRandom,
): CombatUnit[] {
    const allies = state.units.filter(
        (unit) => unit.status === 'alive' && unit.side === actor.side,
    );
    if (allies.length === 0) return [actor];

    if (action.targeting === 'enemies_all' || action.targeting === 'both_teams') return allies;

    const index = Math.min(allies.length - 1, Math.floor(random() * allies.length));
    return [allies[index]];
}

/** Mirrors a team scope when confusion turns an action on its own side. */
function swapTeamScope(scope: string): string {
    if (scope === 'enemies_all') return 'allies_all';
    if (scope === 'allies_all') return 'enemies_all';
    return scope;
}

/**
 * Takes a random subset of a resolved scope (`random_targets`).
 *
 * Plague uses it to curse only some of the enemies rather than the whole line.
 * The roll happens after the scope is resolved, so it composes with `both_teams`.
 */
function pickRandomTargets(
    targets: CombatUnit[],
    effect: AttackEffect,
    random: CombatRandom,
): CombatUnit[] {
    const spec = asRecord(asRecord(effect)?.random_targets);
    if (!spec || targets.length <= 1) return targets;

    const min = Math.max(1, Math.round(readNumber(spec.min, 1)));
    const max = Math.max(min, Math.round(readNumber(spec.max, targets.length)));
    const count = Math.min(targets.length, min + Math.floor(random() * (max - min + 1)));

    const pool = [...targets];
    for (let index = pool.length - 1; index > 0; index -= 1) {
        const swap = Math.min(index, Math.floor(random() * (index + 1)));
        const held = pool[index];
        pool[index] = pool[swap];
        pool[swap] = held;
    }

    return pool.slice(0, count);
}

function resolveAttack(context: ActionResolutionContext): CombatEvent[] {
    const { state, actor, action, random } = context;
    const events: CombatEvent[] = [];
    // A scatter action does not aim: every ray draws its own target from the
    // pool. The rest of the resolver still works off the units the action hit.
    const scatter = action.dealsDamage && action.scatterTargets;

    // Confusion is rolled once per action: an entire area attack either turns on
    // the actor's own side or lands normally.
    const confused = isHostileAction(action) && random() < confusionChance(actor);
    const actionTargets = confused
        ? confusedTargets(state, actor, action, random)
        : resolveActionTargets(context);
    const primaryTarget = actionTargets[0] ?? null;

    const resolutions = new Map<string, AttackResolution>();
    if (action.dealsDamage) {
        if (scatter) {
            rollScatter(context, actionTargets, resolutions);
        } else {
            for (const target of actionTargets) {
                const evade = consumeEvade(target, action.damageType, random, events);
                if (evade) {
                    resolutions.set(target.id, makeMissResolution(actor, target, action));
                    if ((evade.evadeNext?.power ?? 0) > 0) {
                        dealFlatDamage(events, target, actor, evade.evadeNext?.power ?? 0, action.id, 'physical', random);
                    }
                    continue;
                }
                resolutions.set(target.id, buildResolution(context, target));
            }
            // A single-shot projectile miss may be re-shot on the spot
            // (`Second Chance`): once per its bearer's turn, same target.
            rerollSingleShot(context, actionTargets, resolutions, events);
        }
    }

    // A weather skill (`Rain`, `Storm`) forces its sky on landing: the newest
    // cast replaces whatever held, regardless of hits.
    for (const effect of action.effects) {
        const spec = readWeatherSpec(effect);
        if (!spec) continue;
        events.push(...applyWeather(state, action.id, action.name, actor.side, spec));
    }

    // A `collateral` splash (riptide) throws a reduced copy of the hit onto
    // the aimed target's adjacent compatriots; the splash's damage is keyed
    // by the main target so a caster-facing drain can read the tide in full.
    const splashDamage = resolveCollateralDamage(context, actionTargets, resolutions);
    const resolvedUnits: CombatUnit[] = [...actionTargets];
    for (const id of resolutions.keys()) {
        if (resolvedUnits.some((unit) => unit.id === id)) continue;
        const unit = state.units.find((candidate) => candidate.id === id);
        if (unit) resolvedUnits.push(unit);
    }

    // The `target` scope of a scatter action follows the rays: only the units a
    // ray actually hit receive the effect. The team scopes keep their literal
    // meaning and are resolved once for the whole battlefield.
    const targetScope = scatter
        ? actionTargets.filter((target) => resolutions.get(target.id)?.isHit)
        : actionTargets;

    // The same hour-of-the-day curve the direct hit uses also scales the effect
    // magnitudes — never their duration, costs or control flags. A battlefield
    // weather (`Rain`) and the caster's own element power (`Gale Resonance`)
    // multiply their listed elements the same way, on top of the hour and the
    // weapon's own output boost.
    const phaseMultiplier = phaseEffectMultiplier(action, effectiveTimePhase(state));

    // Any Lux attack that lands lifts a `removable_by_lux` curse (Curse, Hex,
    // Plague), whether it belonged to the caster or to somebody else.
    if (action.elementId === 'lux') {
        for (const target of actionTargets) {
            if (!resolutions.get(target.id)?.isHit) continue;
            events.push(...liftLuxCurses(target));
        }
    }

    // Effects honour their own `apply_to` scope. `target` tracks the action's
    // targets; the team scopes are resolved once for the whole battlefield. A
    // status that lands wakes the victim's `on_status_applied` abilities.
    const appliedByUnit = new Map<string, string[]>();
    // A resisted control effect (`shock` on a boss) still pays its flat damage,
    // once per bearer, no matter how many control clauses the action carries.
    const controlImmunePaid = new Set<string>();
    for (const effect of action.effects) {
        const applyTo = readString(effect.apply_to, '') || null;
        const scopeTargets = applyTo === null || applyTo === 'target'
            ? targetScope
            : resolveEffectTargets(
                confused ? swapTeamScope(applyTo) : applyTo,
                actor,
                primaryTarget,
                state.units,
            );
        const effectTargets = pickRandomTargets(scopeTargets, effect, random);
        // Weather and the caster's element power scale one effect's magnitude;
        // the strongest wording wins over pure stacking.
        const effectElementId = readString(asRecord(effect)?.element_id, '') || action.elementId;
        const weatherMult = weatherElementMultiplierFor(state, effectElementId);
        const outputBoost = effectPowerMultiplier(actor)
            * weatherMult
            * elementPowerFor(actor, effectElementId);

        for (const scopeTarget of effectTargets) {
            if (scopeTarget.status !== 'alive') continue;

            // A conditional effect (`Wind Funnel`'s pending seal, `Crosswind`'s
            // rear-line penalty) only lands on units matching its clause.
            const condition = readConditionRecord((asRecord(effect) ?? {}).condition);
            if (!effectConditionSatisfied(state, scopeTarget, condition)) continue;

            // A charge-bearing landing only marks a hit: a target the ice
            // skill missed stays dry of charges.
            const landedResolution = resolutions.get(scopeTarget.id);
            if (asRecord(effect)?.charges && action.dealsDamage && (!landedResolution || !landedResolution.isHit)) {
                continue;
            }
            // `require_all_hits`: a two-strike combo only pays its tail when
            // the whole flurry landed (`ice_blades`).
            if (readBoolean(asRecord(effect)?.require_all_hits, false)
                && action.dealsDamage
                && (landedResolution?.hits ?? 0) < action.hitCount) {
                continue;
            }

            const applied = applyEffectToUnit(scopeTarget, effect, action.id, action.elementId, random, outputBoost, phaseMultiplier);
            if (applied) {
                events.push(applied);
                if (applied.type === 'effect_applied') {
                    const list = appliedByUnit.get(scopeTarget.id) ?? [];
                    list.push(applied.effectId);
                    appliedByUnit.set(scopeTarget.id, list);

                    events.push(...resolveAbilityEvent(state, scopeTarget, 'on_status_applied', {
                        source: actor,
                        target: scopeTarget,
                        damageType: action.damageType,
                        elementId: action.elementId,
                        damage: 0,
                        units: state.units,
                        random,
                    }));
                } else if ((action.controlImmuneDamage ?? 0) > 0 && !controlImmunePaid.has(scopeTarget.id)) {
                    controlImmunePaid.add(scopeTarget.id);
                    dealFlatDamage(
                        events,
                        actor,
                        scopeTarget,
                        action.controlImmuneDamage ?? 0,
                        action.id,
                        action.damageType,
                        random,
                    );
                }
            }

            // A `heal_block` holder cannot be healed by anybody else; its own
            // healing still works.
            const healBlocked = isHealBlocked(scopeTarget) && scopeTarget.id !== actor.id;

            events.push(...applyEffectResources(
                scopeTarget,
                effect,
                random,
                outputBoost,
                {
                    healBlocked,
                    drainRecipient: actor,
                    transferSource: actor,
                    phaseMultiplier,
                    sourceElementId: action.elementId,
                    damageDealt:
                        (resolutions.get(scopeTarget.id)?.finalDamage ?? 0)
                        + (splashDamage.get(scopeTarget.id) ?? 0),
                },
            ));

            // The effects that change the battlefield rather than a number.
            events.push(...applyCleanse(scopeTarget, effect));
            events.push(...applyDispel(scopeTarget, effect));
            // An `invert_buffs` landing turns the gifts the target still holds
            // into curses of the same size (Solar Exorcism).
            if (readBoolean((asRecord(effect) ?? {}).invert_buffs, false)) {
                events.push(...invertBuffsOn(scopeTarget));
            }
            events.push(...applyMove(state, actor, scopeTarget, effect));
            events.push(...applyTurnPostpone(state, actor, scopeTarget, effect));
            events.push(...applyRewind(scopeTarget, effect));

            // A cooldown tick takes turns off the target's waiting actions.
            const cooldownTick = readNumber(asRecord(effect)?.cooldown_tick, 0);
            if (cooldownTick > 0) {
                for (const actionId of Object.keys(scopeTarget.cooldowns)) {
                    const remaining = scopeTarget.cooldowns[actionId] - Math.round(cooldownTick);
                    if (remaining <= 0) delete scopeTarget.cooldowns[actionId];
                    else scopeTarget.cooldowns[actionId] = remaining;
                }
            }
        }
    }

    // A healing action can also consume a stack status (`ashen_carapace`).
    if (!action.dealsDamage && action.consumeStacks?.length) {
        for (const target of actionTargets) {
            if (target.status === 'alive') consumeStacksOnHit(actor, target, action, events, random);
        }
    }

    for (const target of resolvedUnits) {
        const resolution = resolutions.get(target.id);
        if (!resolution) continue;
        resolution.appliedEffectIds = appliedByUnit.get(target.id) ?? [];
        events.push({ type: 'attack_resolved', resolution });
    }

    // A `last_stand` status answers the direct hit that felled its bearer.
    const recipients = new Set<string>([
        ...resolvedUnits.map((unit) => unit.id),
        ...Array.from(resolutions.values()).map((resolution) => resolution.targetId),
    ]);
    for (const unit of state.units) {
        if (!recipients.has(unit.id) || unit.currentHp > 0) continue;
        const lastStand = unit.effects.find((effect) => effect.onDeathBlast);
        if (!lastStand?.onDeathBlast) continue;
        dealFlatDamage(events, unit, actor, lastStand.onDeathBlast.power, action.id, 'physical', random);
        unit.effects = unit.effects.filter((effect) => effect !== lastStand);
        events.push({ type: 'effect_expired', unitId: unit.id, effectId: lastStand.effectId });
    }

    // Chaos aftermath: chains, shrapnel, recoil, marks, conductors and the
    // unstable-charge ladder all read the same authored specs and reuse the
    // main resolution helpers.
    resolveChaosFollowUp(context, resolutions, resolvedUnits, events, primaryTarget);

    // A status carrying an `on_miss_move` clause answers misses on its own:
    // whenever a damaging action misses its holder, the holder steps across
    // the field by itself, without spending a turn (`Zephyr Veil`), and the
    // status breaks once it has done its job — unless the author keeps it.
    if (action.dealsDamage) {
        for (const target of resolvedUnits) {
            const resolution = resolutions.get(target.id);
            if (!resolution || resolution.isHit || target.status !== 'alive') continue;

            const moveClause = target.effects.find((effect) => effect.onMissMove);
            if (!moveClause?.onMissMove) continue;

            events.push(...applyMoveSpec(state, actor, target, moveClause.onMissMove));
            if (moveClause.onMissMove.breakAfter) {
                target.effects = target.effects.filter(
                    (effect) => effect.effectId !== moveClause.effectId,
                );
                events.push({ type: 'effect_expired', unitId: target.id, effectId: moveClause.effectId });
            }
        }
    }

    // A hit of an element statuses name as their undo (Wet vs ignis) lifts
    // them the moment it lands, before the victim reacts to the hit.
    if (action.dealsDamage) {
        for (const target of resolvedUnits) {
            const resolution = resolutions.get(target.id);
            if (!resolution || !resolution.isHit) continue;
            events.push(...expireStatusesOnElementHit(target, action.elementId));
            events.push(...consumeCharges(target, action.bonusPerCharge));
        }
    }

    // A landed hit can wake the target's reactive abilities (a reflection, a
    // first-hit immunity). Only survivors react: a corpse's abilities belong to
    // `on_death`, which the reap below fires.
    for (const target of resolvedUnits) {
        const resolution = resolutions.get(target.id);
        if (!resolution || !resolution.isHit || target.status !== 'alive') continue;

        events.push(...resolveAbilityEvent(state, target, 'after_damage', {
            source: actor,
            target,
            damageType: action.damageType,
            elementId: action.elementId,
            damage: resolution.finalDamage,
            units: state.units,
            random,
        }));

        // A `counter` status throws the next hit back at the attacker (on a
        // chance, when authored one — `frost_mirror`); the status survives a
        // failed roll and is spent by the throw itself.
        const counter = readyCounter(target, action.elementId);
        if (counter && resolution.finalDamage > 0) {
            const chance = counter.counterChance ?? 1;
            if (chance >= 1 || random() < chance) {
                events.push(...reflectCounter(actor, target, resolution.finalDamage, counter));
            }
            // A missed roll costs nothing: the mirror stays live until its turns end.
        }
    }

    // A `locks_target` status grows its focus on the first target a damaging
    // action reaches while the buff lives (Keen Focus cast on oneself).
    if (action.dealsDamage) {
        for (const target of actionTargets) {
            if (target.status !== 'alive') continue;
            if (!resolutions.get(target.id)?.isHit) continue;

            claimTargetLock(actor, target.id);
            break;
        }
    }

    // A skill that says "the target panics below this much health" takes it
    // out of the fight when the hit leaves it that low. Control skills (Fear and
    // friends) have no damage roll, so they reach their targets outright.
    const fleeBelowHp = action.fleeBelowHp;
    if (fleeBelowHp !== null && fleeBelowHp > 0) {
        for (const target of actionTargets) {
            const resolution = resolutions.get(target.id);
            const landed = resolution ? resolution.isHit : !action.dealsDamage;
            if (!landed || target.status !== 'alive') continue;
            if (hpFraction(target) > fleeBelowHp) continue;

            target.status = 'defeated';
            events.push({ type: 'flee_attempted', unitId: target.id, escaped: true });
            events.push({ type: 'unit_defeated', unitId: target.id });
            promoteRearLines(state, events);
        }
    }

    reapDefeated(state, events, random);
    return events;
}

/** Finds a live status by id or label. */
function findStatus(target: CombatUnit, status: string): CombatEffectInstance | null {
    const wanted = status.trim().toLowerCase();
    return target.effects.find((effect) => (
        (effect.statusEffect ?? '').trim().toLowerCase() === wanted
        || effect.effectId.trim().toLowerCase() === wanted
    )) ?? null;
}

/** Consumes named stack statuses for flat damage and/or healing. */
function consumeStacksOnHit(
    actor: CombatUnit,
    target: CombatUnit,
    action: CombatAction,
    events: CombatEvent[],
    random: CombatRandom,
): void {
    if (!action.consumeStacks?.length) return;
    for (const spec of action.consumeStacks) {
        const effect = findStatus(target, spec.status);
        if (!effect) continue;
        const stacks = Math.max(1, effect.stacks);
        if (spec.perStack > 0) {
            dealFlatDamage(
                events,
                actor,
                target,
                spec.perStack * stacks,
                action.id,
                action.damageType,
                random,
            );
        }
        if (spec.healPercentPerStack > 0) {
            const amount = Math.round(effectiveStats(target).maxHp * spec.healPercentPerStack / 100 * stacks);
            if (amount > 0) events.push(...changeResource(target, 'hp', amount));
        }
        target.effects = target.effects.filter((entry) => entry !== effect);
        events.push({ type: 'effect_expired', unitId: target.id, effectId: effect.effectId });
    }
}

/** Applies a Burn stack bundle to a unit. */
function applyBurn(
    unit: CombatUnit,
    sourceId: string,
    stacks: number,
    turns: number,
    events: CombatEvent[],
    random: CombatRandom,
): void {
    if (stacks <= 0 || turns <= 0 || unit.status !== 'alive') return;
    const burn: AttackEffect = {
        effect_id: 'burn',
        status_effect: 'Burn',
        turns,
        polarity: 'negative',
        damage_per_turn: 4,
        damage_timing: 'turn_end',
        stacking: { extend_turns: 1, initial: stacks },
    };
    const applied = applyEffectToUnit(unit, burn, sourceId, 'ignis', random);
    if (applied) events.push(applied);
}

/** Applies on-hit Burn riders and fire-wall erosion. */
function applyIgniteAndErosion(
    actor: CombatUnit,
    target: CombatUnit,
    action: CombatAction,
    events: CombatEvent[],
    random: CombatRandom,
): void {
    for (const effect of [...target.effects]) {
        if (effect.igniteOnHit && action.elementId && effect.igniteOnHit.elements.includes(action.elementId)) {
            applyBurn(
                target,
                effect.sourceId,
                effect.igniteOnHit.burnStacks,
                effect.igniteOnHit.burnTurns,
                events,
                random,
            );
        }

        if (effect.igniteAttackerOnHit
            && (!effect.igniteAttackerOnHit.damageTypes?.length
                || effect.igniteAttackerOnHit.damageTypes.includes(action.damageType))
            && random() < effect.igniteAttackerOnHit.chance) {
            applyBurn(
                actor,
                effect.sourceId,
                effect.igniteAttackerOnHit.burnStacks,
                effect.igniteAttackerOnHit.burnTurns,
                events,
                random,
            );
        }

        if (effect.fireWall && !effect.fireWall.noErode
            && effect.fireWall.erodeElements?.includes(action.elementId ?? '')) {
            effect.turns = effect.turns === null ? null : effect.turns - 1;
            if (effect.turns !== null && effect.turns <= 0) {
                target.effects = target.effects.filter((entry) => entry !== effect);
                events.push({ type: 'effect_expired', unitId: target.id, effectId: effect.effectId });
            }
        }
    }
}

/**
 * Resolves the Chaos follow-ups an attack leaves behind.
 *
 * The authored specs are element-agnostic: serial chains, rear-line splashes,
 * shrapnel, recoil, friendly fire, on-kill detonations, instability, marks,
 * conductors and flat reflect all read their own clause and reuse the main
 * damage/shield machinery. Keeping the sequencing here means a future element
 * can opt into any of them without touching the core hit loop.
 */
function resolveChaosFollowUp(
    context: ActionResolutionContext,
    resolutions: Map<string, AttackResolution>,
    resolvedUnits: CombatUnit[],
    events: CombatEvent[],
    primaryTarget: CombatUnit | null,
): void {
    const { state, actor, action, random } = context;
    const primaryResolution = primaryTarget ? resolutions.get(primaryTarget.id) : null;
    const mainHit = Boolean(primaryResolution?.isHit);

    // A serial chain starts from the aimed unit and hops through units that
    // have not been hit yet. Each hop rolls its own accuracy and pays a fraction
    // of the previous hop's power; a miss ends the chain.
    if (action.chain && primaryTarget && mainHit) {
        const spec = action.chain;
        // Only the aimed unit and previous jumps are excluded: an area chain
        // may still arc onto other enemies the main blast already clipped.
        const hitIds = new Set<string>(primaryTarget ? [primaryTarget.id] : []);
        const branches = Math.max(1, spec.branches ?? 1);
        const powerPercent = spec.powerPercent ?? 0.6;
        const maxJumps = Math.max(1, spec.jumps ?? 1);

        for (let branch = 0; branch < branches; branch += 1) {
            let from = primaryTarget;
            let power = action.power * powerPercent;
            let chance = spec.chance ?? 1;

            for (let jump = 0; jump < maxJumps; jump += 1) {
                if (chance < 1 && random() >= chance) break;

                const target = selectChainTarget(state, actor, from, hitIds, spec, random);
                if (!target) break;

                const chainAction: CombatAction = {
                    ...action,
                    power,
                    accuracy: spec.accuracy ?? action.accuracy,
                    hitCount: 1,
                    scatterTargets: false,
                    scatterHits: null,
                };
                const resolution = buildResolution(context, target, { attempts: 1, action: chainAction });
                if (!resolutions.has(target.id)) resolutions.set(target.id, resolution);
                if (!resolvedUnits.some((unit) => unit.id === target.id)) resolvedUnits.push(target);
                events.push({ type: 'attack_resolved', resolution });
                hitIds.add(target.id);

                if (resolution.isHit && (spec.stunChance ?? 0) > 0 && random() < (spec.stunChance ?? 0)) {
                    const stun: AttackEffect = {
                        effect_id: `${action.id}_chain_stun`,
                        status_effect: 'Stunned',
                        turns: 1,
                        polarity: 'negative',
                        prevent_actions: ['attack', 'skill', 'weapon'],
                    };
                    const applied = applyEffectToUnit(target, stun, actor.id, action.elementId, random);
                    if (applied) events.push(applied);
                }

                if (!resolution.isHit) break;
                from = target;
                power *= powerPercent;
                chance = Math.max(spec.minChance ?? 0.15, chance + (spec.chanceStep ?? 0));
            }
        }
    }

    // A rear-line clip: a low chance to catch an enemy backliner, optionally
    // paying the aimed target the same flat PWR as well.
    if (action.backlaneSplash && primaryTarget && mainHit) {
        const spec = action.backlaneSplash;
        if (random() < spec.chance) {
            const splashPower = spec.percentOfDamage > 0
                ? Math.round((primaryResolution?.finalDamage ?? 0) * spec.percentOfDamage)
                : spec.power;
            const target = selectBacklaneTarget(state, actor, new Set(resolutions.keys()), random);
            if (target) {
                const splashAction: CombatAction = {
                    ...action,
                    power: splashPower,
                    hitCount: 1,
                    scatterTargets: false,
                    scatterHits: null,
                };
                const resolution = buildResolution(context, target, { attempts: 1, action: splashAction });
                if (!resolutions.has(target.id)) resolutions.set(target.id, resolution);
                if (!resolvedUnits.some((unit) => unit.id === target.id)) resolvedUnits.push(target);
                events.push({ type: 'attack_resolved', resolution });
            }
            if (spec.both && primaryTarget && splashPower > 0) {
                dealFlatDamage(events, actor, primaryTarget, splashPower, action.id, action.damageType, random);
            }
        }
    }

    // Shrapnel: low-accuracy debris that can clip anyone in reach, allies
    // included. A focus status (Precision Burst) concentrates it on the target.
    if (action.shrapnel) {
        const spec = action.shrapnel;
        for (let piece = 0; piece < Math.max(0, spec.count); piece += 1) {
            const target = selectShrapnelTarget(
                state,
                actor,
                primaryTarget,
                spec.includeAllies ?? false,
                spec.focusStatus ?? null,
                random,
            );
            if (!target) continue;

            const shrapnelAction: CombatAction = {
                ...action,
                power: spec.power,
                accuracy: spec.accuracy ?? 40,
                hitCount: 1,
                scatterTargets: false,
                scatterHits: null,
            };
            const resolution = buildResolution(context, target, { attempts: 1, action: shrapnelAction });
            if (!resolutions.has(target.id)) resolutions.set(target.id, resolution);
            if (!resolvedUnits.some((unit) => unit.id === target.id)) resolvedUnits.push(target);
            events.push({ type: 'attack_resolved', resolution });
        }
    }

    // Marks, conductors and flat reflect answer the units the main hit landed on.
    const chainDetonated = new Set<string>();
    for (const target of resolvedUnits) {
        const resolution = resolutions.get(target.id);
        if (!resolution?.isHit || target.status !== 'alive') continue;

        consumeStacksOnHit(actor, target, action, events, random);
        applyIgniteAndErosion(actor, target, action, events, random);

        // A `chain_detonation` mark pays extra when another chaos hit lands and
        // can set off its neighbours' marks, once each. Every extra mark costs
        // the caster recoil.
        if (action.elementId === 'chaos') {
            const mark = target.effects.find((effect) => effect.chainDetonation && effect.sourceId !== action.id);
            if (mark?.chainDetonation) {
                dealFlatDamage(
                    events,
                    actor,
                    target,
                    mark.chainDetonation.power,
                    action.id,
                    action.damageType,
                    random,
                );

                const neighbours = state.units.filter((unit) => (
                    unit.status === 'alive'
                    && unit.id !== target.id
                    && unit.line === target.line
                    && unit.effects.some((effect) => effect.chainDetonation)
                    && !chainDetonated.has(unit.id)
                ));
                for (const neighbour of neighbours) {
                    chainDetonated.add(neighbour.id);
                    const neighbourMark = neighbour.effects.find((effect) => effect.chainDetonation);
                    if (!neighbourMark?.chainDetonation) continue;
                    dealFlatDamage(
                        events,
                        actor,
                        neighbour,
                        neighbourMark.chainDetonation.power,
                        action.id,
                        action.damageType,
                        random,
                    );
                    neighbour.effects = neighbour.effects.filter((effect) => effect !== neighbourMark);
                    events.push({ type: 'effect_expired', unitId: neighbour.id, effectId: neighbourMark.effectId });
                    if (neighbourMark.chainDetonation.recoilPerTarget > 0) {
                        events.push(...changeResource(actor, 'hp', -neighbourMark.chainDetonation.recoilPerTarget));
                    }
                }
            }
        }

        // A conductor carries an electric hit to the nearest enemy; a Lapis
        // skill grounds it, consumes the status and shields its nearest ally.
        const conductor = target.effects.find((effect) => effect.conductor);
        if (conductor?.conductor) {
            if (action.elementId === 'chaos') {
                const jumpTarget = selectConductorTarget(state, target);
                if (jumpTarget) {
                    dealFlatDamage(
                        events,
                        actor,
                        jumpTarget,
                        conductor.conductor.jumpPower,
                        action.id,
                        action.damageType,
                        random,
                    );
                }
            } else if (action.elementId === 'lapis') {
                target.effects = target.effects.filter((effect) => effect !== conductor);
                events.push({ type: 'effect_expired', unitId: target.id, effectId: conductor.effectId });

                const shield = groundConductorShield(conductor);
                const ally = [...state.units]
                    .filter((unit) => unit.status === 'alive' && unit.side === target.side && unit.id !== target.id)
                    .sort((a, b) => Math.abs(a.slot - target.slot) - Math.abs(b.slot - target.slot))[0];
                if (shield && ally) {
                    const applied = applyEffectToUnit(ally, shield, actor.id, 'lapis', random);
                    if (applied) events.push(applied);
                }
            }
        }

        // A flat reflect status throws authored PWR back at the attacker.
        const reflect = target.effects.find((effect) => effect.reflect);
        if (reflect?.reflect && (reflect.reflect.chance ?? 1) > 0 && resolution.finalDamage > 0) {
            const spec = reflect.reflect;
            const typeAllowed = !spec.damageTypes?.length || spec.damageTypes.includes(action.damageType);
            if (typeAllowed && ((spec.chance ?? 1) >= 1 || random() < (spec.chance ?? 1))) {
                const exception = spec.exceptElements?.some(
                    (entry) => entry.trim().toLowerCase() === action.elementId.trim().toLowerCase(),
                );
                if (exception) {
                    // Lux burns through the mirror: the bearer takes extra and
                    // the mirror shatters instead of reflecting.
                    const extra = Math.round(resolution.finalDamage * Math.max(0, (spec.exceptionMultiplier ?? 1) - 1));
                    if (extra > 0) events.push(...changeResource(target, 'hp', -extra));
                    if (spec.exceptionBreaks) {
                        target.effects = target.effects.filter((effect) => effect !== reflect);
                        events.push({ type: 'effect_expired', unitId: target.id, effectId: reflect.effectId });
                    }
                } else {
                    const amount = spec.percentOfDamage > 0
                        ? Math.round(resolution.finalDamage * spec.percentOfDamage)
                        : Math.max(0, spec.power);
                    actor.currentHp = Math.max(0, actor.currentHp - amount);
                    events.push({
                        type: 'damage_reflected',
                        sourceId: target.id,
                        targetId: actor.id,
                        abilityId: reflect.effectId,
                        abilityName: reflect.statusEffect ?? 'Reflect',
                        isHit: true,
                        amount,
                        targetHpAfter: actor.currentHp,
                    });
                    if (spec.consume) {
                        target.effects = target.effects.filter((effect) => effect !== reflect);
                        events.push({ type: 'effect_expired', unitId: target.id, effectId: reflect.effectId });
                    } else if (spec.charges !== undefined) {
                        spec.charges -= 1;
                        if (spec.charges <= 0) {
                            target.effects = target.effects.filter((effect) => effect !== reflect);
                            events.push({ type: 'effect_expired', unitId: target.id, effectId: reflect.effectId });
                        }
                    }
                }
            }
        }
        // A crystalised target shatters when a matching channel reaches it and
        // leaves a bleed behind.
        const shatter = target.effects.find((effect) => effect.shatterOnDamageType
            && effect.shatterOnDamageType.damageType === action.damageType);
        if (shatter?.shatterOnDamageType) {
            target.effects = target.effects.filter((effect) => effect !== shatter);
            events.push({ type: 'effect_expired', unitId: target.id, effectId: shatter.effectId });
            const bleed: AttackEffect = {
                effect_id: 'bleeding',
                status_effect: shatter.shatterOnDamageType.statusEffect,
                turns: shatter.shatterOnDamageType.turns,
                polarity: 'negative',
                damage_per_turn: shatter.shatterOnDamageType.damagePerTurn,
            };
            const applied = applyEffectToUnit(target, bleed, actor.id, action.elementId, random);
            if (applied) events.push(applied);
        }
    }

    // An earthquake throws the survivors around after the main blow.
    if (action.shufflePositions && mainHit) {
        const spec = action.shufflePositions;
        for (const target of resolvedUnits) {
            if (target.status !== 'alive') continue;
            if (random() >= spec.chance) continue;
            if (random() < spec.laneChance) {
                const destination = target.line === 'front' ? 'rear' : 'front';
                if (canPlaceInLine(state.units, target.side, destination)
                    && !wouldLeaveFrontLineEmpty(state.units, target, destination)) {
                    moveUnitToLine(state.units, target, destination);
                    events.push({ type: 'unit_line_changed', unitId: target.id, line: target.line, slot: target.slot });
                    continue;
                }
            }
            const line = state.units
                .filter((unit) => unit.status === 'alive' && unit.side === target.side && unit.line === target.line);
            const slots = line.map((unit) => unit.slot);
            for (let i = slots.length - 1; i > 0; i -= 1) {
                const j = Math.floor(random() * (i + 1));
                [slots[i], slots[j]] = [slots[j], slots[i]];
            }
            line.forEach((unit, index) => { unit.slot = slots[index]; });
            events.push({ type: 'unit_line_changed', unitId: target.id, line: target.line, slot: target.slot });
        }
    }

    // Tremor schedules its delayed global aftershock.
    if (action.aftershock && mainHit) {
        const spec = action.aftershock;
        const rounds = spec.minTurns + Math.floor(random() * (spec.maxTurns - spec.minTurns + 1));
        state.pendingAftershocks = state.pendingAftershocks ?? [];
        state.pendingAftershocks.push({
            sourceId: actor.id,
            power: spec.power,
            rounds: Math.max(1, rounds),
            elementId: action.elementId,
        });
    }

    // A landed hit on a target carrying the authored status trims the caster's
    // own cooldowns (`arc_lash` on a Paralyzed target).
    if (action.cooldownReset) {
        const landed = resolvedUnits.some((target) => (
            target.status === 'alive'
            && resolutions.get(target.id)?.isHit
            && hasStatusLabel(target, action.cooldownReset?.status ?? '')
        ));
        if (landed) {
            for (const actionId of Object.keys(actor.cooldowns)) {
                const remaining = actor.cooldowns[actionId] - (action.cooldownReset.amount || 1);
                if (remaining <= 0) delete actor.cooldowns[actionId];
                else actor.cooldowns[actionId] = remaining;
            }
        }
    }

    // Recoil the caster pays for a reckless action, flat or as a fraction of
    // the main hit.
    if (action.recoil) {
        const flat = Math.max(0, action.recoil.hp ?? 0);
        const fraction = Math.max(0, action.recoil.fractionOfDamage ?? 0);
        const amount = Math.round(flat + (primaryResolution?.finalDamage ?? 0) * fraction);
        if (amount > 0) events.push(...changeResource(actor, 'hp', -amount));
    }

    // A blast that cannot push because the target line is full reflects part of
    // the blow onto its own caster.
    if (action.noSpaceRecoil && primaryTarget && primaryResolution && mainHit) {
        if (!canPlaceInLine(state.units, primaryTarget.side, primaryTarget.line)) {
            const amount = Math.round(primaryResolution.finalDamage * action.noSpaceRecoil.fraction);
            if (amount > 0) events.push(...changeResource(actor, 'hp', -amount));
        }
    }

    // Reckless area blasts also scar the caster's own line.
    if (action.friendlyFire) {
        const spec = action.friendlyFire;
        if ((spec.chance ?? 1) >= 1 || random() < (spec.chance ?? 1)) {
            const power = spec.damage
                ?? Math.round(action.power * (spec.percentOfPower ?? 0));
            if (power > 0) {
                const allies = selectFriendlyFireTargets(
                    state,
                    actor,
                    spec.scope ?? 'allies_all',
                    primaryTarget?.line ?? actor.line,
                );
                for (const ally of allies) {
                    dealFlatDamage(events, actor, ally, power, action.id, action.damageType, random);
                }
            }
        }
    }

    // A demolition blast throws a secondary charge around every target it
    // defeated.
    if (action.onKillDetonation) {
        for (const target of resolvedUnits) {
            if (target.currentHp > 0 && target.status === 'alive') continue;
            const targets = selectOnKillTargets(state, target, action.onKillDetonation.includeAllies ?? true);
            for (const victim of targets) {
                dealFlatDamage(
                    events,
                    actor,
                    victim,
                    action.onKillDetonation.power,
                    action.id,
                    action.damageType,
                    random,
                );
            }
        }
    }

    // The explosive ladder grows after the action, whatever it hit.
    events.push(...applyInstabilityCharge(actor, action, random));
}

/**
 * Throws part of a landed hit back at the attacker.
 *
 * The counter is spent by the throw: a chance-based counter (a `frost_mirror`)
 * cannot reflect again, a flat `counter` keeps standing but has nothing left.
 */
function reflectCounter(
    attacker: CombatUnit,
    reflector: CombatUnit,
    damage: number,
    counter: CombatEffectInstance,
): CombatEvent[] {
    const amount = Math.max(1, Math.round(damage * COUNTER_REFLECT_FRACTION));
    if (counter.counterChance !== undefined) counter.counterChance = 0;
    else counter.counter = false;

    attacker.currentHp = Math.max(0, attacker.currentHp - amount);

    return [{
        type: 'damage_reflected',
        sourceId: reflector.id,
        targetId: attacker.id,
        abilityId: counter.effectId,
        abilityName: counter.statusEffect ?? 'Counter',
        isHit: true,
        amount,
        targetHpAfter: attacker.currentHp,
    }];
}

/**
 * The live counter of a unit that may answer this element.
 *
 * A counter that refuses the hit's element (`frost_mirror` will not bounce
 * ignis) reads as if it was not there. The first live counter wins.
 */
function readyCounter(
    target: CombatUnit,
    elementId: string | null,
): CombatEffectInstance | null {
    for (const effect of target.effects) {
        const chanceReady = (effect.counter ?? false) || (effect.counterChance ?? 0) > 0;
        if (!chanceReady) continue;

        const refuses = effect.counterExceptElements?.some(
            (entry) => elementId && entry.trim().toLowerCase() === elementId.trim().toLowerCase(),
        ) ?? false;
        if (refuses) continue;

        return effect;
    }
    return null;
}

/**
 * The strongest effect-strength boost the unit's live statuses grant for one
 * element (`Gale Resonance`, caeli ×1.15). Boosts do not stack: the strongest
 * wording wins.
 */
function elementPowerFor(unit: CombatUnit, elementId: string | null | undefined): number {
    if (!elementId) return 1;

    let best = 1;
    for (const effect of unit.effects) {
        const value = effect.elementPower?.[elementId];
        if (typeof value === 'number' && Number.isFinite(value) && value > best) best = value;
    }
    return best;
}

/**
 * Re-shots the first missed projectile hit, when the caster holds a live
 * `Second Chance` with a re-roll still in the bank.
 *
 * Only single-shot, non-scatter damaging actions qualify: a volley is several
 * rolls at once, and the clause speaks of one shot. The fresh resolution
 * replaces the missed one whole, and the re-roll is spent on the spot.
 */
function rerollSingleShot(
    context: ActionResolutionContext,
    actionTargets: CombatUnit[],
    resolutions: Map<string, AttackResolution>,
    events: CombatEvent[],
): void {
    const { state } = context;
    const action = context.action;
    if (!action.dealsDamage || action.scatterTargets) return;
    if (Math.max(1, action.hitCount) !== 1) return;
    if (!isProjectileAction(action)) return;

    const holder = state.units.find((unit) => unit.id === context.actor.id)
        ?? context.actor;
    const reroll = holder.effects.find((effect) => (
        effect.projectileReroll
        && effect.projectileReroll.used < effect.projectileReroll.perTurn
    ));
    if (!reroll?.projectileReroll) return;

    for (const target of actionTargets) {
        const missed = resolutions.get(target.id);
        if (!missed || missed.isHit) continue;

        resolutions.set(target.id, buildResolution(context, target, { attempts: 1 }));
        reroll.projectileReroll = {
            ...reroll.projectileReroll,
            used: reroll.projectileReroll.used + 1,
        };
        events.push({ type: 'attack_retried', attackerId: holder.id, targetId: target.id });
        // One re-roll per action, even against several aims.
        return;
    }
}
