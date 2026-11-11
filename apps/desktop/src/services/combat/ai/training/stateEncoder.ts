/** Element-agnostic, fixed-shape observation encoding for offline policies. */

import {
    AI_ENCODING_SCHEMA_VERSION,
    AI_HISTORY_TURNS,
    AI_MAX_UNITS_PER_SIDE,
    AI_TRAINING_DIFFICULTIES,
    AI_TRAINING_PERSONALITIES,
} from '../../../../constants/AiTrainingConstants';
import type {
    AiEncodedObservation,
    AiEncodedSlot,
    AiPolicyObservation,
    AiTurnHistoryEntry,
} from '../../../../types/AiTrainingType';
import type {
    CombatAction,
    CombatEffectInstance,
    CombatState,
    CombatUnit,
} from '../../../../types/CombatType';
import { estimateThreatAgainst } from '../aiThreat';

export const AI_UNIT_FEATURE_COUNT = 31;
export const AI_HISTORY_FEATURE_COUNT = 24;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const ratio = (value: number, maximum: number): number =>
    maximum > 0 ? clamp01(value / maximum) : 0;
const bool = (value: boolean): number => value ? 1 : 0;
const mean = (values: number[]): number =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function oneHot<T extends string>(value: T | undefined, values: readonly T[]): number[] {
    return values.map((candidate) => bool(candidate === value));
}

function emptySlot(featureCount: number): AiEncodedSlot {
    return { features: Array.from({ length: featureCount }, () => 0), mask: 0 };
}

function effectTone(effect: CombatEffectInstance): { beneficial: boolean; harmful: boolean } {
    const hasPositive =
        Object.values(effect.buff ?? {}).some((value) => value > 0) ||
        Object.values(effect.statMultipliers ?? {}).some((value) => value > 1);
    const hasNegative =
        Object.values(effect.debuff ?? {}).some((value) => value > 0) ||
        Object.values(effect.statMultipliers ?? {}).some((value) => value > 0 && value < 1) ||
        effect.damagePerTurn > 0 ||
        (effect.preventActions?.length ?? 0) > 0;

    return {
        beneficial: effect.polarity === 'positive' || hasPositive,
        harmful: effect.polarity === 'negative' || hasNegative,
    };
}

function orderedUnits(state: CombatState, actor: CombatUnit): CombatUnit[] {
    const allies = state.units.filter((unit) => unit.side === actor.side);
    const enemies = state.units.filter((unit) => unit.side !== actor.side);
    if (allies.length > AI_MAX_UNITS_PER_SIDE || enemies.length > AI_MAX_UNITS_PER_SIDE) {
        throw new RangeError(
            `AI encoding supports at most ${AI_MAX_UNITS_PER_SIDE} units per side; ` +
            `received ${allies.length} vs ${enemies.length}.`,
        );
    }

    const byStableSlot = (left: CombatUnit, right: CombatUnit): number =>
        left.slot - right.slot || left.id.localeCompare(right.id);
    return [...allies.sort(byStableSlot), ...enemies.sort(byStableSlot)];
}

function totalStatValue(delta: Record<string, number> | null | undefined): number {
    if (!delta) return 0;
    return Object.values(delta).reduce((sum, value) => sum + Math.max(0, value), 0);
}

function encodeUnit(
    observation: AiPolicyObservation,
    unit: CombatUnit,
    slotIndex: number,
): AiEncodedSlot {
    const { context, protagonistId } = observation;
    const actor = context.actor;
    const { stats } = unit;
    const gauge = context.state.turnGauges[unit.id] ?? 0;
    const tones = unit.effects.map(effectTone);
    const cooldowns = Object.values(unit.cooldowns).filter((turns) => turns > 0).length;
    const durations = unit.effects.map((effect) =>
        effect.turns === null ? 1 : ratio(effect.turns, 10));
    const damageOverTime = unit.effects.reduce(
        (sum, effect) => sum + Math.max(0, effect.damagePerTurn),
        0,
    );
    const shielding = unit.effects.reduce(
        (sum, effect) => sum + (effect.shieldRemaining ?? 0),
        0,
    );
    const modulationValues = unit.effects.flatMap((effect) =>
        Object.values(effect.elementModulation ?? {}));
    const strongestModulation = Math.max(1, ...modulationValues);
    const weakestModulation = Math.min(1, ...modulationValues);
    return {
        mask: 1,
        features: [
            bool(unit.id === actor.id),
            bool(unit.side === actor.side),
            bool(unit.currentHp > 0),
            bool(unit.line === 'front'),
            ratio(slotIndex % AI_MAX_UNITS_PER_SIDE, AI_MAX_UNITS_PER_SIDE - 1),
            bool(unit.id === protagonistId),
            ratio(unit.currentHp, stats.maxHp),
            ratio(unit.currentMana, stats.maxMana),
            ratio(unit.currentStamina, stats.maxStamina),
            ratio(stats.physicalAttack, 100),
            ratio(stats.magicalAttack, 100),
            ratio(stats.physicalDefense, 100),
            ratio(stats.magicalDefense, 100),
            ratio(stats.speed, 100),
            ratio(unit.effects.length, 12),
            ratio(tones.filter((tone) => tone.beneficial).length, 12),
            ratio(tones.filter((tone) => tone.harmful).length, 12),
            bool(unit.effects.some((effect) => (effect.preventActions?.length ?? 0) > 0)),
            ratio(shielding, stats.maxHp),
            ratio(damageOverTime, stats.maxHp),
            ratio(unit.effects.reduce((sum, effect) =>
                sum + totalStatValue(effect.regenPerTurn?.hp ? { hp: effect.regenPerTurn.hp } : null), 0), stats.maxHp),
            mean(durations),
            ratio(cooldowns, Math.max(1, unit.abilities.length)),
            ratio(gauge, 20),
            ratio(Math.max(1, Math.floor((gauge + Math.max(0, stats.speed)) / 20)), 5),
            ratio(estimateThreatAgainst(context, unit), stats.maxHp),
            clamp01((strongestModulation - 1) / 2),
            clamp01((1 - weakestModulation) / 2),
            ratio(unit.effects.reduce((sum, effect) => sum + effect.stacks, 0), 20),
            bool(unit.effects.some((effect) => effect.laneChangeFree)),
            bool(unit.effects.some((effect) => effect.counter || (effect.counterChance ?? 0) > 0)),
        ],
    };
}

function resolveHistoryAction(
    entry: AiTurnHistoryEntry,
): CombatAction | null {
    return entry.action;
}

function actionFlags(action: CombatAction | null): number[] {
    if (!action) return [0, 0, 0, 0, 0, 0, 0];
    const effects = action.effects ?? [];
    const moves = effects.some((effect) =>
        effect.move !== null || effect.onMissMove !== null);
    return [
        bool(action.dealsDamage),
        bool(action.heals),
        bool(action.kind === 'switch_line' || moves),
        bool(action.kind === 'defend'),
        bool(action.kind === 'rest'),
        bool(action.kind === 'flee'),
        bool(action.kind === 'inventory'),
    ];
}

function encodeHistoryEntry(
    observation: AiPolicyObservation,
    entry: AiTurnHistoryEntry,
    newestIndex: number,
): AiEncodedSlot {
    const actor = observation.context.state.units.find((unit) => unit.id === entry.actorId);
    const action = resolveHistoryAction(entry);
    const damage = entry.events.reduce((sum, event) => {
        if (event.type === 'attack_resolved') {
            return sum + event.resolution.finalDamage;
        }
        if (event.type === 'damage_reflected') {
            return sum + event.amount;
        }
        return sum;
    }, 0);
    const healing = entry.events.reduce((sum, event) =>
        sum + (event.type === 'healed' ? event.resolution.amount : 0), 0);
    const defeats = entry.events.filter((event) => event.type === 'unit_defeated').length;
    const targetCount = entry.targetIds.length;
    const primaryTarget = entry.targetIds[0]
        ? observation.context.state.units.find((unit) => unit.id === entry.targetIds[0])
        : undefined;

    return {
        mask: 1,
        features: [
            (newestIndex + 1) / AI_HISTORY_TURNS,
            bool(entry.actorSide === observation.context.actor.side),
            bool(entry.actorLine === 'front'),
            bool(entry.actorIsProtagonist),
            bool(entry.request !== null),
            ...actionFlags(action),
            ratio(targetCount, AI_MAX_UNITS_PER_SIDE * 2),
            bool(primaryTarget !== undefined && primaryTarget.side === entry.actorSide),
            ratio(damage, actor?.stats.maxHp ?? 1),
            ratio(healing, actor?.stats.maxHp ?? 1),
            ratio(defeats, AI_MAX_UNITS_PER_SIDE),
            ratio(entry.resourcesSpent.hp, actor?.stats.maxHp ?? 1),
            ratio(entry.resourcesSpent.mana, actor?.stats.maxMana ?? 1),
            ratio(entry.resourcesSpent.stamina, actor?.stats.maxStamina ?? 1),
            ratio(entry.setups.length, 8),
            ratio(entry.exploits.length, 8),
            ratio(entry.exploits.filter((exploit) =>
                exploit.setupSourceLine === 'rear' && exploit.attackerLine === 'front').length, 8),
            ratio(entry.exploits.filter((exploit) => exploit.protagonistBenefited).length, 8),
        ],
    };
}

function globalFeatures(observation: AiPolicyObservation): number[] {
    const { state, actor, previews } = observation.context;
    const allies = state.units.filter((unit) => unit.side === actor.side && unit.currentHp > 0);
    const enemies = state.units.filter((unit) => unit.side !== actor.side && unit.currentHp > 0);
    const hpRatio = (units: CombatUnit[]): number => mean(units.map((unit) =>
        ratio(unit.currentHp, unit.stats.maxHp)));
    const manaRatio = (units: CombatUnit[]): number => mean(units.map((unit) =>
        ratio(unit.currentMana, unit.stats.maxMana)));
    const staminaRatio = (units: CombatUnit[]): number => mean(units.map((unit) =>
        ratio(unit.currentStamina, unit.stats.maxStamina)));
    const usable = previews.filter((preview) => preview.usable && preview.action.kind !== 'inventory');

    return [
        ratio(state.round, 100),
        ratio(allies.length, AI_MAX_UNITS_PER_SIDE),
        ratio(enemies.length, AI_MAX_UNITS_PER_SIDE),
        hpRatio(allies),
        hpRatio(enemies),
        manaRatio(allies),
        manaRatio(enemies),
        staminaRatio(allies),
        staminaRatio(enemies),
        ratio(allies.filter((unit) => unit.line === 'front').length, AI_MAX_UNITS_PER_SIDE),
        ratio(enemies.filter((unit) => unit.line === 'front').length, AI_MAX_UNITS_PER_SIDE),
        ratio(usable.length, Math.max(1, previews.length)),
        ratio(usable.filter((preview) => preview.action.dealsDamage).length,
            Math.max(1, usable.length)),
        ratio(usable.filter((preview) => preview.action.heals).length,
            Math.max(1, usable.length)),
        bool(state.weather !== null && state.weather !== undefined),
        ratio(observation.history.length, AI_HISTORY_TURNS),
    ];
}

/**
 * Encodes allies first and opponents second, each in stable slot/id order.
 * Missing slots and history rows are zeroed and explicitly masked.
 */
export function encodeAiObservation(observation: AiPolicyObservation): AiEncodedObservation {
    const actor = observation.context.actor;
    const units = orderedUnits(observation.context.state, actor);
    const unitSlots = units.map((unit, index) => encodeUnit(observation, unit, index));
    const unitFeatureCount = unitSlots[0]?.features.length ?? AI_UNIT_FEATURE_COUNT;
    while (unitSlots.length < AI_MAX_UNITS_PER_SIDE * 2) {
        unitSlots.push(emptySlot(unitFeatureCount));
    }

    const recentHistory = observation.history.slice(-AI_HISTORY_TURNS);
    const historySlots = recentHistory.map((entry, index) =>
        encodeHistoryEntry(observation, entry, index));
    const historyFeatureCount = historySlots[0]?.features.length ?? AI_HISTORY_FEATURE_COUNT;
    while (historySlots.length < AI_HISTORY_TURNS) {
        historySlots.push(emptySlot(historyFeatureCount));
    }

    return {
        schemaVersion: AI_ENCODING_SCHEMA_VERSION,
        units: unitSlots,
        history: historySlots,
        globalFeatures: globalFeatures(observation),
        conditioningFeatures: [
            ...oneHot(observation.conditioning.personality, AI_TRAINING_PERSONALITIES),
            ...oneHot(observation.conditioning.difficulty as never, AI_TRAINING_DIFFICULTIES),
        ],
    };
}
