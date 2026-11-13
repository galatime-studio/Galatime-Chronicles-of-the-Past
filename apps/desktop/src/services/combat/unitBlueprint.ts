/**
 * Unit blueprints.
 *
 * Projecting a catalogue entity onto a fresh `CombatUnit` is the same job
 * wherever it happens: the opening roster (`combatService.buildUnits`), a summon
 * and a transform all need the entity's actions and abilities resolved.
 *
 * This module owns that projection once. Loading a blueprint is async (it reads
 * YAML and resolves skill tiers), so a fight pre-loads the blueprints its
 * abilities can reach in `preloadAbilityBlueprints` — the turn loop itself can
 * then instantiate a unit synchronously.
 */

import type {
    CarriedWeapon,
    CombatAction,
    CombatEffectInstance,
    CombatEntityType,
    CombatLine,
    CombatSide,
    CombatStats,
    CombatUnit,
} from '../../types/CombatType';
import type { CombatAbilityInstance } from '../../types/AbilityType';
import type { AiProfile } from '../../types/AiType';
import { resolveAttack, resolveEntitySkill } from '../attackContentService';
import type { ResolvedAttack } from '../attackContentService';
import { getCharacterData, getMobData } from '../entityService';
import { createAbilityInstances, readAbilityEntityTarget } from './abilityFactory';
import { createCombatActionFromSkill, createUniversalActions } from './actionFactory';
import { createCombatUnit } from './unitFactory';
import type { CombatEntitySource } from './unitFactory';
import { cloneCarriedWeapon, equipCarriedWeapon, isWeaponUsable, resolveCarriedWeapon, UNARMED_STRIKE } from './weaponLoadout';

/** Everything needed to spin up a unit, resolved once per entity. */
export interface UnitBlueprint {
    entityId: string;
    entityType: CombatEntityType;
    /** The catalogue entity the blueprint was built from. */
    entity: CombatEntitySource;
    /** Skills (highest tier per base id) and universal movements. */
    actions: CombatAction[];
    /** The entity's own abilities. Weapon passives come from {@link weapons}. */
    abilities: CombatAbilityInstance[];
    /**
     * The weapons a unit of this entity carries by default: its own `weapon:`,
     * as a template. Never empty — an entity with no authored (or an
     * unresolvable) weapon carries {@link UNARMED_STRIKE}.
     */
    weapons: CarriedWeapon[];
}

export interface UnitInstantiationParams {
    /** Unique id within the fight. */
    id: string;
    side: CombatSide;
    line: CombatLine;
    slot: number;
    isPlayerControlled?: boolean;
    /** Display override. */
    name?: string;
    /** Max-HP override; defaults to the entity's `base_stats.hp`. */
    hp?: number;
    /** Fraction of max HP to start on; `1` (the default) is full health. */
    hpRatio?: number;
    /**
     * Weapons the unit carries instead of the blueprint's default. The first usable
     * one is equipped. An empty list falls back to the blueprint's own loadout, so a
     * unit is never left without an attack.
     */
    weapons?: CarriedWeapon[];
    /** Replaces the blueprint's actions (used by generated training units). */
    actions?: CombatAction[];
    /** Stat overlay merged over the entity's base stats. */
    stats?: Partial<CombatStats>;
    /** Element overlay; defaults to the entity's elements. */
    elementIds?: string[];
    /** Opening statuses, cloned per unit. */
    startingEffects?: CombatEffectInstance[];
    /** Resolved AI profile override; defaults to the entity's authored block. */
    aiProfile?: AiProfile;
}

/** How many transform/summon hops a preload follows before it gives up. */
const MAX_BLUEPRINT_HOPS = 4;

const blueprintCache = new Map<string, UnitBlueprint>();

function blueprintKey(entityId: string, entityType: CombatEntityType): string {
    return `${entityType}:${entityId}`;
}

/** Resolves an entity's skills (highest tier per base id). */
async function resolveSkillActions(entity: CombatEntitySource): Promise<CombatAction[]> {
    const skillTiers = new Map<string, ResolvedAttack>();
    for (const skill of Array.isArray(entity.skills) ? entity.skills : []) {
        const resolved = await resolveEntitySkill(skill);
        if (!resolved) {
            warnUnresolvedSkill(skill);
            continue;
        }
        const current = skillTiers.get(resolved.baseId);
        if (!current || resolved.level > current.level) skillTiers.set(resolved.baseId, resolved);
    }

    return [...skillTiers.values()].map((resolved) => createCombatActionFromSkill(resolved.attack));
}

/**
 * Resolves catalogue skill ids into actions for generated units.
 *
 * Unknown ids are skipped with a development warning, matching the authored
 * entity path. Trees are not consulted: a generated unit is a combatant, not a
 * player progressing through a skill tree.
 */
export async function resolveSkillActionsFromIds(
    skillIds: readonly string[],
): Promise<CombatAction[]> {
    const skillTiers = new Map<string, ResolvedAttack>();
    for (const skillId of skillIds) {
        const resolved = await resolveAttack(skillId);
        if (!resolved) {
            warnUnresolvedSkill(skillId);
            continue;
        }
        const current = skillTiers.get(resolved.baseId);
        if (!current || resolved.level > current.level) skillTiers.set(resolved.baseId, resolved);
    }

    return [...skillTiers.values()].map((resolved) => createCombatActionFromSkill(resolved.attack));
}

/** Invalid authoring is a content bug; surface it without breaking a live fight. */
function warnUnresolvedSkill(reference: unknown): void {
    if (!import.meta.env.DEV) return;
    const label = typeof reference === 'string'
        ? reference
        : (reference as { id?: unknown })?.id;
    console.warn(`[unitBlueprint] Unresolved entity skill "${String(label ?? 'unknown')}" was skipped.`);
}

/** A weapon reference that does not resolve degrades to bare hands, not to silence. */
function warnUnresolvedWeapon(reference: unknown): void {
    if (!import.meta.env.DEV) return;
    const label = typeof reference === 'string'
        ? reference
        : (reference as { id?: unknown })?.id;
    console.warn(`[unitBlueprint] Unresolved weapon "${String(label ?? 'unknown')}" was replaced by bare hands.`);
}

/**
 * Loads (and caches) the blueprint for one entity, or `null` when it is absent.
 *
 * A natural mob weapon (garras, mandíbulas) stays inline and carries no durability;
 * an equippable weapon is a catalogue reference. Both go through the same projection.
 * An entity that declares nothing usable carries {@link UNARMED_STRIKE}, so every
 * unit enters a fight with at least one attack.
 */
export async function loadUnitBlueprint(
    entityId: string,
    entityType: CombatEntityType,
): Promise<UnitBlueprint | null> {
    const cached = blueprintCache.get(blueprintKey(entityId, entityType));
    if (cached) return cached;

    const entity = entityType === 'mob'
        ? await getMobData(entityId)
        : await getCharacterData(entityId);

    if (!entity) return null;

    const source = entity as CombatEntitySource;
    const authored = source.weapon ? await resolveCarriedWeapon(source.weapon) : null;
    if (source.weapon && !authored) warnUnresolvedWeapon(source.weapon);
    // No weapon authored, an empty one, or a broken reference: bare hands. A unit
    // that cannot attack would only defend and rest, which reads as a stall.
    const weapon = authored ?? await resolveCarriedWeapon(UNARMED_STRIKE);
    const blueprint: UnitBlueprint = {
        entityId,
        entityType,
        entity: source,
        actions: [...await resolveSkillActions(source), ...createUniversalActions()],
        abilities: createAbilityInstances((entity as { abilities?: unknown }).abilities),
        weapons: weapon ? [weapon] : [],
    };

    blueprintCache.set(blueprintKey(entityId, entityType), blueprint);
    return blueprint;
}

/** The blueprint already in cache, for the synchronous turn loop. */
export function getUnitBlueprint(
    entityId: string,
    entityType: CombatEntityType,
): UnitBlueprint | null {
    return blueprintCache.get(blueprintKey(entityId, entityType)) ?? null;
}

/**
 * Builds a live unit from a blueprint.
 *
 * Ability state is cloned per unit, so two slimes split from the same parent do
 * not share a `triggered` flag; actions and definitions are immutable and are
 * shared by reference. Each weapon is cloned per unit too, and the first usable
 * one is equipped.
 */
export function instantiateUnit(
    blueprint: UnitBlueprint,
    params: UnitInstantiationParams,
): CombatUnit {
    const unit = createCombatUnit({
        id: params.id,
        entityId: blueprint.entityId,
        entityType: blueprint.entityType,
        entity: blueprint.entity,
        side: params.side,
        line: params.line,
        slot: params.slot,
        actions: params.actions ?? blueprint.actions,
        abilities: blueprint.abilities.map((ability) => ({ ...ability })),
        isPlayerControlled: params.isPlayerControlled ?? false,
        name: params.name,
        hp: params.hp,
        stats: params.stats,
        elementIds: params.elementIds,
        startingEffects: params.startingEffects,
        aiProfile: params.aiProfile,
    });

    const declared = params.weapons && params.weapons.length > 0
        ? params.weapons
        : blueprint.weapons;
    unit.carriedWeapons = declared.map(cloneCarriedWeapon);
    const inHand = unit.carriedWeapons.find(isWeaponUsable);
    if (inHand) equipCarriedWeapon(unit, inHand);

    const ratio = params.hpRatio ?? 1;
    if (ratio < 1) {
        unit.currentHp = Math.max(1, Math.round(unit.stats.maxHp * Math.max(0, ratio)));
    }

    return unit;
}

/**
 * Pre-loads every blueprint a roster's abilities can reach.
 *
 * A summon or transform resolves its target entity by id at trigger time, which
 * must be synchronous — so the reachable blueprints are fetched up front here.
 * The walk follows summon/transform targets transitively (a soul that turns into
 * a soul that turns back), bounded by {@link MAX_BLUEPRINT_HOPS} and de-duplicated
 * by entity id.
 */
export async function preloadAbilityBlueprints(units: readonly CombatUnit[]): Promise<void> {
    const pending: Array<{ entityId: string; entityType: CombatEntityType; depth: number }> = [];
    const visited = new Set<string>();

    const enqueueFrom = (abilities: readonly CombatAbilityInstance[], depth: number) => {
        for (const ability of abilities) {
            const target = readAbilityEntityTarget(ability.definition);
            if (target) pending.push({ ...target, depth });
        }
    };

    for (const unit of units) enqueueFrom(unit.abilities, 0);

    while (pending.length > 0) {
        const next = pending.shift();
        if (!next || next.depth >= MAX_BLUEPRINT_HOPS) continue;

        const key = blueprintKey(next.entityId, next.entityType);
        if (visited.has(key)) continue;
        visited.add(key);

        const blueprint = await loadUnitBlueprint(next.entityId, next.entityType);
        if (!blueprint) continue;

        enqueueFrom(blueprint.abilities, next.depth + 1);
        for (const weapon of blueprint.weapons) enqueueFrom(weapon.abilities, next.depth + 1);
    }
}

/** Clears the blueprint cache (tests, development reloads). */
export function clearUnitBlueprintCache(): void {
    blueprintCache.clear();
}
