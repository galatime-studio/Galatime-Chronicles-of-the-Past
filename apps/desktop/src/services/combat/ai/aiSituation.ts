/**
 * Builds the situational snapshot one decision reads.
 *
 * The Utility score is otherwise a function of the board *right now*: it cannot
 * tell a fight that has ten rounds left from one that ends next turn, and it
 * only sees the statuses a candidate would apply, not the ones already running.
 * This module folds that missing context into one read-only object:
 *
 * - every live effect on every unit, buffs, debuffs, stacks and durations alike;
 * - all three pools per unit (health, mana, stamina), plus shields;
 * - the last {@link AI_SITUATION_HISTORY_EVENTS} log events, reduced to per-side
 *   damage, healing, statuses, defeats and spending;
 * - a horizon estimate: how many rounds until one side falls, and therefore how
 *   much time is left to set something up.
 *
 * Threat comes from the shared threat model: the actor reads the precise,
 * memoised {@link estimateThreatAgainst} (so the considerations reuse the same
 * cache), and each side's damage per round is one {@link threatFrom} read per
 * living attacker against the side's weakest defender.
 */

import {
    AI_FUTURE_REFERENCE_ROUNDS,
    AI_HORIZON_MAX_ROUNDS,
    AI_HORIZON_MIN_ROUNDS,
    AI_SETUP_WINDOW_MAX,
    AI_SETUP_WINDOW_MIN,
    AI_SITUATION_HISTORY_EVENTS,
} from '../../../constants/AiConstants';
import type { AiDecisionContext } from '../../../types/AiType';
import type {
    AiSituation,
    AiSituationEffect,
    AiSituationHistory,
    AiSituationHorizon,
    AiSituationPressure,
    AiSituationUnit,
} from '../../../types/AiSituationType';
import type {
    CombatEffectInstance,
    CombatEvent,
    CombatSide,
    CombatStatDelta,
    CombatUnit,
} from '../../../types/CombatType';
import { clamp } from '../../../utils/combatUtils';
import { effectiveStats } from '../effectResolver';
import { estimateThreatAgainst, threatFrom } from './aiThreat';

/** Builds the snapshot for the context's actor. */
export function buildAiSituation(context: AiDecisionContext): AiSituation {
    const { state, actor } = context;
    const livingAllies = state.units.filter(
        (unit) => unit.side === actor.side && unit.status === 'alive',
    );
    const livingEnemies = state.units.filter(
        (unit) => unit.side !== actor.side && unit.status === 'alive',
    );

    // One representative defender per side keeps the read cheap: the threat
    // model runs once per attacker instead of once per attacker/defender pair.
    const allyDamagePerRound = sideDamagePerRound(context, livingAllies, livingEnemies);
    const enemyDamagePerRound = sideDamagePerRound(context, livingEnemies, livingAllies);
    const actorThreat = estimateThreatAgainst(context, actor);

    const allyThreat = livingAllies.length > 0 ? enemyDamagePerRound / livingAllies.length : 0;
    const enemyThreat = livingEnemies.length > 0 ? allyDamagePerRound / livingEnemies.length : 0;

    const allies = state.units
        .filter((unit) => unit.side === actor.side)
        .map((unit) => buildUnit(unit, actor, unit.id === actor.id ? actorThreat : allyThreat))
        .sort(bySlot);
    const enemies = state.units
        .filter((unit) => unit.side !== actor.side)
        .map((unit) => buildUnit(unit, actor, enemyThreat))
        .sort(bySlot);

    const history = buildHistory(state.log, state.units, actor, actor.side);
    const horizon = buildHorizon(
        history,
        allyDamagePerRound,
        enemyDamagePerRound,
        allies,
        enemies,
    );
    const pressure = buildPressure(allies, enemies);

    return {
        round: state.round,
        actorId: actor.id,
        actorSide: actor.side,
        actor: allies.find((unit) => unit.isActor) ?? buildUnit(actor, actor, actorThreat),
        allies,
        enemies,
        history,
        horizon,
        pressure,
        weather: state.weather
            ? {
                id: state.weather.id,
                label: state.weather.label,
                side: state.weather.side,
                rounds: state.weather.rounds,
                chipDamage: state.weather.chipDamage,
            }
            : null,
    };
}

/**
 * Damage one side is expected to land per round, read against the weakest
 * living defender - the target the default `weakest` preference already picks.
 */
function sideDamagePerRound(
    context: AiDecisionContext,
    attackers: readonly CombatUnit[],
    defenders: readonly CombatUnit[],
): number {
    if (attackers.length === 0 || defenders.length === 0) return 0;
    const target = defenders.reduce((weakest, unit) => (
        unit.currentHp < weakest.currentHp ? unit : weakest
    ));
    return attackers.reduce(
        (total, attacker) => total + threatFrom(context, attacker, target),
        0,
    );
}

/** One unit, with every pool and every effect. */
function buildUnit(unit: CombatUnit, actor: CombatUnit, threatValue: number): AiSituationUnit {
    const stats = effectiveStats(unit);
    const maxHp = Math.max(1, stats.maxHp);
    const maxMana = Math.max(1, stats.maxMana);
    const maxStamina = Math.max(1, stats.maxStamina);
    const isAlive = unit.status === 'alive';
    const effects = unit.effects.map((effect) => buildEffect(effect, maxHp));

    return {
        id: unit.id,
        side: unit.side,
        line: unit.line,
        slot: unit.slot,
        isActor: unit.id === actor.id,
        isAlive,
        hp: Math.max(0, unit.currentHp),
        maxHp,
        hpFraction: isAlive ? clamp(unit.currentHp / maxHp, 0, 1) : 0,
        mana: Math.max(0, unit.currentMana),
        maxMana,
        manaFraction: isAlive ? clamp(unit.currentMana / maxMana, 0, 1) : 0,
        stamina: Math.max(0, unit.currentStamina),
        maxStamina,
        staminaFraction: isAlive ? clamp(unit.currentStamina / maxStamina, 0, 1) : 0,
        threatFraction: isAlive ? clamp(threatValue / maxHp, 0, 3) : 0,
        shieldFraction: Math.max(0, effects.reduce((total, effect) => total + effect.shieldFraction, 0)),
        damageOverTimeFraction: Math.max(
            0,
            effects.reduce((total, effect) => total + effect.damagePerTurn, 0) / maxHp,
        ),
        healingOverTimeFraction: Math.max(
            0,
            effects.reduce((total, effect) => total + effect.regenPerTurn, 0) / maxHp,
        ),
        control: effects.reduce((current, effect) => Math.max(current, effect.control), 0),
        effects,
        statuses: [...new Set(effects.map((effect) => effect.status).filter(isString))].sort(),
        cooldownCount: Object.values(unit.cooldowns).filter((turns) => turns > 0).length,
        actionCount: unit.actions.length,
    };
}

/** One effect, buffs and debuffs on the same footing. */
function buildEffect(effect: CombatEffectInstance, maxHp: number): AiSituationEffect {
    const regen = effect.regenPerTurn;
    const regenPercent = effect.regenPerTurnPercent;

    return {
        effectId: effect.effectId,
        sourceId: effect.sourceId,
        status: normalizeStatus(effect.statusEffect),
        elementId: effect.elementId ?? null,
        polarity: effect.polarity,
        stacks: Math.max(0, effect.stacks ?? 0),
        turns: effect.turns === null ? null : Math.max(0, effect.turns),
        damagePerTurn: Math.max(0, effect.damagePerTurn ?? 0),
        regenPerTurn: Math.max(
            0,
            stat(regen, 'hp') + (stat(regenPercent, 'hp') / 100) * maxHp,
        ),
        shieldFraction: shieldFraction(effect, maxHp),
        control: effect.preventActions && effect.preventActions.length > 0
            ? 1
            : effect.preventSkills
                ? 0.5
                : 0,
        laneChangeFree: effect.laneChangeFree === true,
        counter: effect.counter === true,
        buffMagnitude: magnitude(effect.buff),
        debuffMagnitude: magnitude(effect.debuff),
    };
}

function shieldFraction(effect: CombatEffectInstance, maxHp: number): number {
    if (typeof effect.shieldRemaining === 'number' && effect.shieldRemaining > 0) {
        return clamp(effect.shieldRemaining / maxHp, 0, 2);
    }
    return clamp((effect.shieldPercentOfMaxHp ?? 0) / 100, 0, 2);
}

/**
 * Folds the recent log into per-side pressure.
 *
 * The log records the *bearer* of an effect, not its caster, so "statuses
 * applied" counts hostile effects that landed on the other side and "resisted"
 * counts hostile attempts that failed. That is the only attribution the events
 * support, and it is enough to tell a fight where setups are landing from one
 * where they are being shrugged off.
 */
function buildHistory(
    events: readonly CombatEvent[],
    units: readonly CombatUnit[],
    actor: CombatUnit,
    actorSide: CombatSide,
): AiSituationHistory {
    const window = events.slice(-AI_SITUATION_HISTORY_EVENTS);
    const byId = new Map<string, CombatUnit>();
    for (const unit of units) byId.set(unit.id, unit);

    const sideOf = (unitId: string): CombatSide | null => {
        if (unitId === actor.id) return actorSide;
        return byId.get(unitId)?.side ?? null;
    };
    const maxHpOf = (unitId: string): number => {
        const unit = byId.get(unitId);
        return unit ? Math.max(1, effectiveStats(unit).maxHp) : 1;
    };
    const ally = (unitId: string): boolean => sideOf(unitId) === actorSide;
    const enemy = (unitId: string): boolean => {
        const side = sideOf(unitId);
        return side !== null && side !== actorSide;
    };

    const history: AiSituationHistory = {
        window: window.length,
        rounds: 0,
        actions: 0,
        allyActions: 0,
        enemyActions: 0,
        allyDamage: 0,
        enemyDamage: 0,
        allyDamageFraction: 0,
        enemyDamageFraction: 0,
        allyHealingFraction: 0,
        allyStatuses: 0,
        enemyStatuses: 0,
        allyStatusesResisted: 0,
        enemyStatusesResisted: 0,
        allyDefeats: 0,
        enemyDefeats: 0,
        allyResourceSpent: 0,
        enemyResourceSpent: 0,
        itemsUsed: 0,
        fleesAttempted: 0,
        lastActorActionId: null,
        repeatedActorActions: 0,
    };

    const rounds = new Set<number>();

    for (const event of window) {
        switch (event.type) {
            case 'turn_started':
                rounds.add(event.round);
                break;
            case 'action_used': {
                history.actions += 1;
                if (ally(event.actorId)) history.allyActions += 1;
                else if (enemy(event.actorId)) history.enemyActions += 1;
                if (ally(event.actorId) && event.kind === 'inventory') history.itemsUsed += 1;
                break;
            }
            case 'attack_resolved': {
                const { attackerId, targetId, finalDamage } = event.resolution;
                const fraction = Math.max(0, finalDamage) / maxHpOf(targetId);
                if (ally(attackerId)) {
                    history.allyDamage += Math.max(0, finalDamage);
                    history.allyDamageFraction += fraction;
                } else if (enemy(attackerId)) {
                    history.enemyDamage += Math.max(0, finalDamage);
                    history.enemyDamageFraction += fraction;
                }
                break;
            }
            case 'healed':
                if (ally(event.resolution.targetId)) {
                    history.allyHealingFraction += Math.max(0, event.resolution.amount) / maxHpOf(event.resolution.targetId);
                }
                break;
            case 'effect_applied':
                if (enemy(event.unitId)) history.allyStatuses += 1;
                else if (ally(event.unitId)) history.enemyStatuses += 1;
                break;
            case 'effect_resisted':
                if (enemy(event.unitId)) history.allyStatusesResisted += 1;
                else if (ally(event.unitId)) history.enemyStatusesResisted += 1;
                break;
            case 'unit_defeated':
                if (ally(event.unitId)) history.allyDefeats += 1;
                else if (enemy(event.unitId)) history.enemyDefeats += 1;
                break;
            case 'resource_changed': {
                const spent = Math.max(0, event.previous - event.next);
                if (ally(event.unitId)) history.allyResourceSpent += spent;
                else if (enemy(event.unitId)) history.enemyResourceSpent += spent;
                break;
            }
            case 'flee_attempted':
                history.fleesAttempted += 1;
                break;
            default:
                break;
        }
    }

    history.rounds = rounds.size;
    if (history.rounds === 0) history.rounds = window.length > 0 ? 1 : 0;

    for (let index = window.length - 1; index >= 0; index -= 1) {
        const event = window[index];
        if (event.type !== 'action_used' || event.actorId !== actor.id) continue;
        history.lastActorActionId = event.actionId;
        history.repeatedActorActions = 1;
        for (let back = index - 1; back >= 0; back -= 1) {
            const previous = window[back];
            if (previous.type !== 'action_used' || previous.actorId !== actor.id) continue;
            if (previous.actionId !== event.actionId) break;
            history.repeatedActorActions += 1;
        }
        break;
    }

    return history;
}

/**
 * How long the fight still looks like lasting.
 *
 * Both sides' damage per round come from the threat model, blended with what the
 * log actually observed, so a fight where the estimates are wrong self-corrects.
 * `roundsToFinish` is the smaller break-even time: the first side to fall sets
 * the horizon.
 */
function buildHorizon(
    history: AiSituationHistory,
    allyEstimate: number,
    enemyEstimate: number,
    allies: readonly AiSituationUnit[],
    enemies: readonly AiSituationUnit[],
): AiSituationHorizon {
    const allyPool = poolHp(enemies);
    const enemyPool = poolHp(allies);

    let allyDamagePerRound = allyEstimate;
    let enemyDamagePerRound = enemyEstimate;

    const observed = history.rounds > 0 && (history.allyDamage > 0 || history.enemyDamage > 0);
    if (observed) {
        allyDamagePerRound = blend(allyDamagePerRound, history.allyDamage / history.rounds);
        enemyDamagePerRound = blend(enemyDamagePerRound, history.enemyDamage / history.rounds);
    }

    const breaks: number[] = [];
    if (allyDamagePerRound > 0) breaks.push(allyPool / allyDamagePerRound);
    if (enemyDamagePerRound > 0) breaks.push(enemyPool / enemyDamagePerRound);

    const roundsToFinish = clampRounds(
        breaks.length > 0 ? Math.min(...breaks) : AI_HORIZON_MAX_ROUNDS,
    );

    return {
        roundsToFinish,
        setupWindow: clamp(
            roundsToFinish / AI_FUTURE_REFERENCE_ROUNDS,
            AI_SETUP_WINDOW_MIN,
            AI_SETUP_WINDOW_MAX,
        ),
        allyDamagePerRound,
        enemyDamagePerRound,
        observed,
    };
}

function poolHp(units: readonly AiSituationUnit[]): number {
    return units.reduce((total, unit) => total + unit.hp + unit.shieldFraction * unit.maxHp, 0);
}

/** Weighted average of the model and the observation. */
function blend(estimate: number, observed: number): number {
    if (observed <= 0) return estimate;
    if (estimate <= 0) return observed;
    return estimate * 0.5 + observed * 0.5;
}

function clampRounds(rounds: number): number {
    if (!Number.isFinite(rounds)) return AI_HORIZON_MAX_ROUNDS;
    return clamp(rounds, AI_HORIZON_MIN_ROUNDS, AI_HORIZON_MAX_ROUNDS);
}

/** The pressures the modulation reads. */
function buildPressure(
    allies: readonly AiSituationUnit[],
    enemies: readonly AiSituationUnit[],
): AiSituationPressure {
    const livingAllies = allies.filter((unit) => unit.isAlive);
    const livingEnemies = enemies.filter((unit) => unit.isAlive);
    const actorUnit = livingAllies.find((unit) => unit.isActor);

    return {
        ownHp: actorUnit ? 1 - actorUnit.hpFraction : 1,
        allyHp: average(livingAllies, (unit) => 1 - unit.hpFraction),
        enemyHp: 1 - hpPoolFraction(livingEnemies),
        threat: actorUnit ? clamp(actorUnit.threatFraction, 0, 1.5) : 1.5,
        mana: actorUnit ? 1 - actorUnit.manaFraction : 1,
        stamina: actorUnit ? 1 - actorUnit.staminaFraction : 1,
        allyMana: average(livingAllies, (unit) => 1 - unit.manaFraction),
        allyStamina: average(livingAllies, (unit) => 1 - unit.staminaFraction),
        enemyMana: average(livingEnemies, (unit) => 1 - unit.manaFraction),
        enemyStamina: average(livingEnemies, (unit) => 1 - unit.staminaFraction),
        outnumbered: clamp(
            (livingEnemies.length - livingAllies.length) / Math.max(1, livingAllies.length),
            0,
            1,
        ),
    };
}

function hpPoolFraction(units: readonly AiSituationUnit[]): number {
    if (units.length === 0) return 0;
    const current = poolHp(units);
    const max = units.reduce((total, unit) => total + unit.maxHp, 0);
    return clamp(current / Math.max(1, max), 0, 1);
}

function average(
    units: readonly AiSituationUnit[],
    read: (unit: AiSituationUnit) => number,
): number {
    if (units.length === 0) return 0;
    return clamp(units.reduce((total, unit) => total + read(unit), 0) / units.length, 0, 1);
}

function bySlot(a: AiSituationUnit, b: AiSituationUnit): number {
    return a.line.localeCompare(b.line) || a.slot - b.slot;
}

function stat(delta: CombatStatDelta | null | undefined, key: keyof CombatStatDelta): number {
    const value = delta?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function magnitude(delta: CombatStatDelta | null | undefined): number {
    if (!delta) return 0;
    return Object.values(delta).reduce(
        (total, value) => total + (typeof value === 'number' ? Math.abs(value) : 0),
        0,
    );
}

function normalizeStatus(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
}

function isString(value: string | null): value is string {
    return value !== null;
}
