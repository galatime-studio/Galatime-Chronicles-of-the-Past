/**
 * Combat unit factory.
 *
 * Projects an entity from `data/entities/*` onto the runtime {@link CombatUnit}.
 * The entity files are untyped YAML, so every read goes through the tolerant
 * helpers and a malformed field degrades to a safe default instead of crashing
 * the fight.
 */

import {
    BASE_ACCURACY_MODIFIER,
    BASE_CRIT_CHANCE,
    BASE_EVASION,
} from '../../constants/CombatConstants';
import type { EntitiesData } from '../../types/EntityDataType';
import type { CombatAbilityInstance } from '../../types/AbilityType';
import type { AiProfile } from '../../types/AiType';
import type { WeaponRuntimeState, WeaponStatDelta } from '../../types/WeaponType';
import type {
    CombatAction,
    CombatEffectInstance,
    CombatEntityType,
    CombatLine,
    CombatSide,
    CombatStats,
    CombatUnit,
} from '../../types/CombatType';
import { readNumber, readString } from '../../utils/combatUtils';
import { createAbilityInstances } from './abilityFactory';
import { createFleeAction } from './actionFactory';
import { createAiProfile } from './ai/aiProfileFactory';
import { createStatusEffect } from './effectResolver';
import { recordTimelineSnapshot } from './rewind';

/** An entity as loaded from the catalogue; characters and mobs both carry a name. */
export type CombatEntitySource = EntitiesData & { name?: string };

export interface CreateUnitParams {
    /** Unique id within the fight, e.g. `enemies_front_0_slime`. */
    id: string;
    /** Catalogue id used to load the entity. */
    entityId: string;
    entityType: CombatEntityType;
    entity: CombatEntitySource;
    side: CombatSide;
    line: CombatLine;
    slot: number;
    /** Actions available to the unit (skills, weapon, universal movements). */
    actions: CombatAction[];
    /**
     * Generated-unit stat overlay. Merged over the entity's `base_stats`; the
     * current pools start full at the resolved maxima.
     */
    stats?: Partial<CombatStats>;
    /** Generated-unit element overlay; defaults to the entity's `elements`. */
    elementIds?: string[];
    /** Opening statuses, cloned per unit so two generated units never share one. */
    startingEffects?: CombatEffectInstance[];
    /**
     * Resolved AI profile override. Generated units use their scenario
     * personality here instead of inheriting the borrowed entity's `ai:` block.
     */
    aiProfile?: AiProfile;
    /**
     * Abilities to give the unit.
     *
     * Defaults to the entity's own `abilities:` list; a blueprint passes the
     * normalised instances so the per-unit trigger state is cloned once.
     */
    abilities?: CombatAbilityInstance[];
    isPlayerControlled?: boolean;
    /** Display override. */
    name?: string;
    /** Max-HP override; defaults to the entity's `base_stats.hp`. */
    hp?: number;
    /** The equipped weapon's runtime state (cloned per unit). */
    weapon?: WeaponRuntimeState | null;
}

/**
 * Builds the permanent effect a weapon's `stats:` produce.
 *
 * It carries the delta on `buff` (negative values read as a drop), lasting until
 * the fight ends, so the flat modifier flows through `effectiveStats` like any
 * other buff.
 */
export function createWeaponStatEffect(weaponId: string, stats: WeaponStatDelta): CombatEffectInstance {
    return createStatusEffect({
        effectId: `weapon:${weaponId}:stats`,
        sourceId: `weapon:${weaponId}`,
        buff: stats,
        polarity: 'positive',
    });
}

/** Reads an entity's `base_stats` into the runtime stat block. */
export function buildCombatStats(entity: CombatEntitySource): CombatStats {
    const base = entity.base_stats ?? null;

    return {
        maxHp: Math.max(1, Math.round(readNumber(base?.hp, 1))),
        maxMana: Math.max(0, Math.round(readNumber(base?.mana, 0))),
        maxStamina: Math.max(0, Math.round(readNumber(base?.stamina, 0))),
        physicalAttack: readNumber(base?.physical_attack, 0),
        magicalAttack: readNumber(base?.magical_attack, 0),
        physicalDefense: readNumber(base?.physical_defense, 0),
        magicalDefense: readNumber(base?.magical_defense, 0),
        speed: readNumber(base?.speed, 0),
        // The combat modifiers start at the centralised baselines: they are
        // offsets a buff moves, not percentages the entity is born with. Crit
        // and evasion are both `BASE_*` in `CombatConstants`.
        accuracy: BASE_ACCURACY_MODIFIER,
        evasion: BASE_EVASION,
        critChance: BASE_CRIT_CHANCE,
    };
}

/** Builds a fresh, full-health combat unit from an entity. */
export function createCombatUnit(params: CreateUnitParams): CombatUnit {
    const stats: CombatStats = {
        ...buildCombatStats(params.entity),
        ...(params.stats ?? {}),
    };
    stats.maxHp = Math.max(1, Math.round(stats.maxHp));
    stats.maxMana = Math.max(0, Math.round(stats.maxMana));
    stats.maxStamina = Math.max(0, Math.round(stats.maxStamina));
    const maxHp = params.hp && params.hp > 0 ? Math.round(params.hp) : stats.maxHp;
    const resolved: CombatStats = { ...stats, maxHp };

    const abilities = params.abilities ?? createAbilityInstances(params.entity.abilities);
    const aiProfile = params.aiProfile ?? createAiProfile(params.entity.ai, abilities);

    // Fleeing is opt-in: the player always carries it, an enemy only when its
    // profile authors `ai.flee`. Appending here keeps the cached blueprint
    // shared while the per-unit permission stays per-unit.
    const mayFlee = (params.isPlayerControlled ?? false) || aiProfile.flee !== null;
    const actions = mayFlee && !params.actions.some((action) => action.kind === 'flee')
        ? [...params.actions, createFleeAction()]
        : params.actions;

    const elementIds = params.elementIds
        ?? (Array.isArray(params.entity.elements)
            ? params.entity.elements.filter((element): element is string => typeof element === 'string')
            : []);

    const unit: CombatUnit = {
        id: params.id,
        entityId: params.entityId,
        entityType: params.entityType,
        name: params.name ?? readString(params.entity.name, params.entityId),
        side: params.side,
        line: params.line,
        slot: params.slot,
        isPlayerControlled: params.isPlayerControlled ?? false,
        status: 'alive',
        elementIds,
        stats: resolved,
        currentHp: resolved.maxHp,
        currentMana: resolved.maxMana,
        currentStamina: resolved.maxStamina,
        actions,
        effects: params.startingEffects?.map((effect) => structuredClone(effect)) ?? [],
        abilities,
        aiProfile,
        immunities: [],
        turnCount: 0,
        resourceIdleTurns: { mana: 0, stamina: 0 },
        resourceSpentSinceTurnStart: { mana: false, stamina: false },
        eventCounts: {},
        flags: {},
        cooldowns: {},
        defending: false,
        lockedTargetId: null,
        lockedByEffectId: null,
        weapon: params.weapon ?? null,
        carriedWeapons: [],
        timeline: [],
    };

    // The fight opens with one snapshot of the unit, so a rewind that goes all
    // the way back lands on the state the unit started the fight in.
    recordTimelineSnapshot(unit);

    return unit;
}
