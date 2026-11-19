/**
 * Setup model for the Test Playground's combat tab.
 *
 * The tab does not ship a hardcoded fight: the player fills one slot per roster
 * position on both sides and marks which of those characters they play. This
 * module owns the shape of that setup and the projection from it onto a
 * `CombatEncounter`, so the setup screen and the panel stay free of combat
 * plumbing.
 *
 * The projection is only a *description* of the fight. `CombatEncounter` runs it
 * and `services/combatService` builds the units, so nothing here duplicates how a
 * combatant is put together.
 */

import { MAX_UNITS_PER_LINE } from '../../../constants/CombatConstants';
import { getEntityImages } from '../../../services/entityImageService';
import { fetchAllCharacters, fetchAllMobs } from '../../../controllers/entityController';
import type { CharacterData, MobData } from '../../../types/EntityDataType';
import type { EntityInventoryState } from '../../../types/InventoryType';
import type {
    CombatEncounter,
    CombatEncounterMember,
    CombatEntityType,
    CombatLine,
    CombatSide,
} from '../../../types/CombatType';

export { resolveUnitSprite } from '../../../services/combatSpriteService';

/** Sides of a fight, in the order the setup lays them out. */
export const SETUP_SIDES: readonly CombatSide[] = ['allies', 'enemies'];

/** Battle lines, in the order the setup lays them out. */
export const SETUP_LINES: readonly CombatLine[] = ['front', 'rear'];

/** Slots drawn per line. Mirrors the formation board, which is what caps a fight. */
export const SLOTS_PER_LINE = MAX_UNITS_PER_LINE;

/** One catalogue entity as the picker offers it. */
export interface CatalogueEntity {
    entityId: string;
    entityType: CombatEntityType;
    /** Name the UI shows; characters carry their surname, mobs their own name. */
    name: string;
    spriteUrl?: string;
    data: CharacterData | MobData;
}

/** A filled roster position. */
export interface SetupSlot {
    entityId: string;
    entityType: CombatEntityType;
    /**
     * Set by the control mark: the player plays this character themselves.
     *
     * Everything unmarked belongs to the computer, which is what makes the battle
     * screen drop its action HUD while they act.
     */
    controlled: boolean;
    /**
     * What the character carries into this one fight, item id to quantity.
     *
     * Declared here rather than read from a store: playground entities are called
     * up for a single battle, so their stock is whatever the setup says and it
     * lives only as long as the fight does.
     */
    inventory: EntityInventoryState;
    /**
     * Catalogue weapon ids the character carries into this fight; the first is equipped.
     *
     * `null` means the setup has not touched it: the character fights with its own
     * weapon, exactly as the entity defines it.
     */
    weapons: string[] | null;
}

/** One line of one side: a fixed row of positions, empty ones included. */
export type SetupLine = Array<SetupSlot | null>;

/** A row the setup can fill: either a battle line or one on-hold lane. */
export type SetupLineId = CombatLine | `hold_${number}`;

/**
 * The rows of one side.
 *
 * `front` and `rear` are the battlefield. `hold` is the queue of waves waiting
 * off it: index 0 is the first lane to deploy, then 1, and so on.
 */
export interface SetupLanes {
    front: SetupLine;
    rear: SetupLine;
    hold: SetupLine[];
}

/** The whole setup: both sides, each with its battlefield rows and waves. */
export type CombatSetup = Record<CombatSide, SetupLanes>;

/** Turns a hold-lane index into the row id the setup helpers take. */
export function holdLaneId(index: number): SetupLineId {
    return `hold_${index}`;
}

/** The row a line id names; an unknown hold lane reads as empty. */
function lineOf(lanes: SetupLanes, line: SetupLineId): SetupLine {
    if (line === 'front' || line === 'rear') return lanes[line];
    const index = Number(line.slice('hold_'.length));
    return lanes.hold[index] ?? [];
}

/** Key a catalogue entry is indexed by, so a slot can look its entity up again. */
export function catalogueKey(entityType: CombatEntityType, entityId: string): string {
    return `${entityType}:${entityId}`;
}

/** A setup with every position empty, plus one on-hold lane per side. */
export function createEmptySetup(): CombatSetup {
    const emptyLine = (): SetupLine => Array.from({ length: SLOTS_PER_LINE }, () => null);

    return {
        allies: { front: emptyLine(), rear: emptyLine(), hold: [emptyLine()] },
        enemies: { front: emptyLine(), rear: emptyLine(), hold: [emptyLine()] },
    };
}

/** Rewrites one position, keeping the rest of the setup untouched. */
function updateSlot(
    setup: CombatSetup,
    side: CombatSide,
    line: SetupLineId,
    index: number,
    update: (slot: SetupSlot | null) => SetupSlot | null,
): CombatSetup {
    const lanes = setup[side];

    if (line === 'front' || line === 'rear') {
        return {
            ...setup,
            [side]: {
                ...lanes,
                [line]: lanes[line].map((slot, position) => (position === index ? update(slot) : slot)),
            },
        };
    }

    const laneIndex = Number(line.slice('hold_'.length));
    return {
        ...setup,
        [side]: {
            ...lanes,
            hold: lanes.hold.map((lane, position) => (
                position === laneIndex
                    ? lane.map((slot, slotIndex) => (slotIndex === index ? update(slot) : slot))
                    : lane
            )),
        },
    };
}

/** The character standing in a position, or `null` when it is empty. */
export function slotAt(
    setup: CombatSetup,
    side: CombatSide,
    line: SetupLineId,
    index: number,
): SetupSlot | null {
    return lineOf(setup[side], line)[index] ?? null;
}

/** The positions of one row, whether it is a battle line or a wave. */
export function setupLine(setup: CombatSetup, side: CombatSide, line: SetupLineId): SetupLine {
    return lineOf(setup[side], line);
}

/** Places an entity in a position. New picks start unmarked and empty-handed. */
export function fillSlot(
    setup: CombatSetup,
    side: CombatSide,
    line: SetupLineId,
    index: number,
    entity: CatalogueEntity,
): CombatSetup {
    const slot: SetupSlot = {
        entityId: entity.entityId,
        entityType: entity.entityType,
        controlled: false,
        inventory: {},
        weapons: null,
    };

    return updateSlot(setup, side, line, index, () => slot);
}

/**
 * The weapon ids a position's character would carry if the player changed nothing:
 * the entity's own catalogue weapon, when it has one.
 */
export function defaultWeaponIds(entity: CatalogueEntity): string[] {
    const weapon = entity.data.weapon;
    return typeof weapon === 'string' ? [weapon] : [];
}

/** Rewrites which weapons the character in a position carries. */
export function setSlotWeapons(
    setup: CombatSetup,
    side: CombatSide,
    line: SetupLineId,
    index: number,
    weapons: string[],
): CombatSetup {
    return updateSlot(setup, side, line, index, (slot) => (
        slot ? { ...slot, weapons: [...weapons] } : slot
    ));
}

/** Empties a position. */
export function clearSlot(
    setup: CombatSetup,
    side: CombatSide,
    line: SetupLineId,
    index: number,
): CombatSetup {
    return updateSlot(setup, side, line, index, () => null);
}

/** Flips the control mark: the player takes the character over, or lets it go. */
export function toggleControlled(
    setup: CombatSetup,
    side: CombatSide,
    line: SetupLineId,
    index: number,
): CombatSetup {
    return updateSlot(setup, side, line, index, (slot) => (
        slot ? { ...slot, controlled: !slot.controlled } : slot
    ));
}

/** Rewrites what the character in a position carries into the fight. */
export function setSlotInventory(
    setup: CombatSetup,
    side: CombatSide,
    line: SetupLineId,
    index: number,
    inventory: EntityInventoryState,
): CombatSetup {
    return updateSlot(setup, side, line, index, (slot) => (
        slot ? { ...slot, inventory: { ...inventory } } : slot
    ));
}

/** Adds another on-hold lane at the back of the queue. */
export function addHoldLane(setup: CombatSetup, side: CombatSide): CombatSetup {
    const lane: SetupLine = Array.from({ length: SLOTS_PER_LINE }, () => null);
    return {
        ...setup,
        [side]: { ...setup[side], hold: [...setup[side].hold, lane] },
    };
}

/** Drops one on-hold lane; the lanes after it close the gap. */
export function removeHoldLane(setup: CombatSetup, side: CombatSide, index: number): CombatSetup {
    return {
        ...setup,
        [side]: {
            ...setup[side],
            hold: setup[side].hold.filter((_, position) => position !== index),
        },
    };
}

/** Filled positions on one side: both battle lines and every wave. */
export function countSide(setup: CombatSetup, side: CombatSide): number {
    const laneCount = (line: SetupLine): number => line.filter((slot) => slot !== null).length;
    const lanes = setup[side];
    return laneCount(lanes.front)
        + laneCount(lanes.rear)
        + lanes.hold.reduce((total, lane) => total + laneCount(lane), 0);
}

/** Whether the setup can be fought: both sides need at least one character. */
export function isSetupValid(setup: CombatSetup): boolean {
    return SETUP_SIDES.every((side) => countSide(setup, side) > 0);
}

/** Folds a name down to letters and digits so ids and labels compare alike. */
function normalize(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Catalogue entries matching a typed id or name. An empty query browses everything. */
export function filterCatalogue(
    catalogue: readonly CatalogueEntity[],
    query: string,
    limit = 40,
): CatalogueEntity[] {
    const needle = normalize(query);
    const matches = needle === ''
        ? catalogue
        : catalogue.filter((entry) => (
            normalize(entry.entityId).includes(needle) || normalize(entry.name).includes(needle)
        ));

    return matches.slice(0, limit);
}

/** Reads the whole entity catalogue — characters and mobs — ready for the picker. */
export async function loadEntityCatalogue(): Promise<CatalogueEntity[]> {
    const [characters, mobs] = await Promise.all([fetchAllCharacters(), fetchAllMobs()]);

    const entries: CatalogueEntity[] = [
        ...characters.map((character) => ({
            entityId: character.id,
            entityType: 'character' as const,
            name: [character.name, character.surname].filter(Boolean).join(' '),
            spriteUrl: getEntityImages({ type: 'character', id: character.id, name: character.name })[0]?.url,
            data: character,
        })),
        ...mobs.map((mob) => ({
            entityId: mob.id,
            entityType: 'mob' as const,
            name: mob.name,
            spriteUrl: getEntityImages({ type: 'mob', id: mob.id, name: mob.name })[0]?.url,
            data: mob,
        })),
    ];

    return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Projects a setup onto an authored encounter.
 *
 * Positions are compacted per line, so a line with a hole in the middle still
 * deploys without a gap — the same numbering `services/combatService.buildUnits`
 * uses when it turns members into units. On-hold lanes keep their own order:
 * lane 1 deploys before lane 2.
 */
export function buildEncounter(setup: CombatSetup, encounterName: string): CombatEncounter {
    const memberOf = (slot: SetupSlot, line: CombatLine): CombatEncounterMember => ({
        entityId: slot.entityId,
        entityType: slot.entityType,
        line,
        isPlayerControlled: slot.controlled,
        inventory: { ...slot.inventory },
        ...(slot.weapons ? { weapons: [...slot.weapons] } : {}),
    });

    const roster = (side: CombatSide): CombatEncounterMember[] => {
        const field = SETUP_LINES.flatMap((line) => (
            setup[side][line]
                .filter((slot): slot is SetupSlot => slot !== null)
                .map((slot) => memberOf(slot, line))
        ));

        const waves = setup[side].hold.flatMap((lane, laneIndex) => (
            lane
                .filter((slot): slot is SetupSlot => slot !== null)
                .map((slot) => ({ ...memberOf(slot, 'rear'), hold: laneIndex + 1 }))
        ));

        return [...field, ...waves];
    };

    return {
        id: 'playground',
        name: encounterName,
        allies: roster('allies'),
        enemies: roster('enemies'),
    };
}
