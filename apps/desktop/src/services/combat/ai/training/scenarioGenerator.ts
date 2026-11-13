/**
 * Synthetic training scenarios.
 *
 * A generated unit borrows an existing entity only for presentation (sprite and
 * name). Its stats come from an archetype band, its element is sampled from the
 * element catalogue, and its skills are sampled from the union of the element's
 * allowed `skill_trees`. Prerequisites are intentionally ignored: a generated
 * combatant is not a player progressing through a tree, and the harness needs
 * coverage of the whole catalogue, not the authored curve.
 */

import {
    BASE_ACCURACY_MODIFIER,
    BASE_CRIT_CHANCE,
    BASE_EVASION,
} from '../../../../constants/CombatConstants';
import {
    AI_DEFAULT_MAX_TURNS,
    AI_MAX_TEAM_SIZE,
    AI_MIN_TEAM_SIZE,
    AI_TRAINING_PERSONALITIES,
} from '../../../../constants/AiTrainingConstants';
import type { AiScenarioSplit, AiTrainingScenario, AiTrainingScenarioSuite } from '../../../../types/AiTrainingType';
import type {
    CombatEncounter,
    CombatEncounterMember,
    CombatEntityType,
    CombatLine,
    CombatSide,
    CombatStats,
} from '../../../../types/CombatType';
import { createStatusEffect } from '../../effectResolver';
import { getLearningTrees } from '../../../attackContentService';
import { getAllElementsDataService } from '../../../elementService';
import { getAllCharactersData, getAllMobsData } from '../../../entityService';
import {
    createSeededCombatRandom,
    hashAiSeed,
    randomInt,
    randomPick,
    randomSample,
} from './seededRandom';
import type { SeededCombatRandom } from './seededRandom';

interface StatBand {
    hp: readonly [number, number];
    mana: readonly [number, number];
    stamina: readonly [number, number];
    physicalAttack: readonly [number, number];
    magicalAttack: readonly [number, number];
    physicalDefense: readonly [number, number];
    magicalDefense: readonly [number, number];
    speed: readonly [number, number];
}

interface UnitArchetype {
    id: string;
    line: CombatLine | 'either';
    skills: readonly [number, number];
    stats: StatBand;
}

/**
 * Stat bands mirror the authored character scale (roughly 700 HP, 60–100 in
 * the offensive stats, 50–60 speed). Generated skills are sampled across the
 * whole tree, so both attack stats stay usable even for a physical archetype;
 * otherwise a randomly sampled magical skill deals negligible damage and fights
 * never resolve.
 */
const ARCHETYPES: readonly UnitArchetype[] = [
    {
        id: 'vanguard',
        line: 'front',
        skills: [3, 5],
        stats: {
            hp: [750, 1300], mana: [40, 80], stamina: [40, 80],
            physicalAttack: [70, 105], magicalAttack: [55, 85],
            physicalDefense: [50, 80], magicalDefense: [40, 70],
            speed: [40, 60],
        },
    },
    {
        id: 'duelist',
        line: 'front',
        skills: [3, 5],
        stats: {
            hp: [600, 1000], mana: [30, 70], stamina: [55, 95],
            physicalAttack: [80, 115], magicalAttack: [45, 80],
            physicalDefense: [35, 60], magicalDefense: [30, 55],
            speed: [55, 80],
        },
    },
    {
        id: 'mage',
        line: 'rear',
        skills: [4, 6],
        stats: {
            hp: [500, 900], mana: [80, 130], stamina: [30, 70],
            physicalAttack: [40, 70], magicalAttack: [85, 125],
            physicalDefense: [25, 50], magicalDefense: [50, 85],
            speed: [40, 65],
        },
    },
    {
        id: 'support',
        line: 'rear',
        skills: [4, 6],
        stats: {
            hp: [550, 950], mana: [80, 130], stamina: [30, 70],
            physicalAttack: [35, 65], magicalAttack: [70, 110],
            physicalDefense: [30, 55], magicalDefense: [45, 75],
            speed: [35, 60],
        },
    },
    {
        id: 'skirmisher',
        line: 'either',
        skills: [3, 5],
        stats: {
            hp: [600, 1000], mana: [50, 90], stamina: [50, 90],
            physicalAttack: [65, 100], magicalAttack: [60, 95],
            physicalDefense: [30, 55], magicalDefense: [30, 55],
            speed: [60, 90],
        },
    },
];

const FRONT_ARCHETYPES = ARCHETYPES.filter((archetype) => archetype.line === 'front');

/**
 * Every generated unit carries a basic weapon. Sampled skills replace the
 * entity's authored loadout and are gated by cooldowns and resources; without a
 * weapon a unit with no affordable skill can only guard or rest, which stalls
 * the fight long before damage can resolve.
 */
const TRAINING_WEAPON_ID = 'rusty_sword';
const TRAINING_ITEM_ID = 'hp_potion_plus';
const TRAINING_ITEM_QUANTITY = 2;

interface OpeningStatusTemplate {
    statusEffect: string;
    turns: number;
    polarity: 'positive' | 'negative';
    damagePerTurn?: number;
    buff?: { physical_defense?: number; magical_defense?: number; magical_attack?: number; speed?: number };
    debuff?: { physical_attack?: number; speed?: number };
}

const OPENING_STATUSES: readonly OpeningStatusTemplate[] = [
    { statusEffect: 'training_burn', turns: 3, polarity: 'negative', damagePerTurn: 12 },
    { statusEffect: 'training_poison', turns: 4, polarity: 'negative', damagePerTurn: 8 },
    { statusEffect: 'training_guard', turns: 3, polarity: 'positive', buff: { physical_defense: 15, magical_defense: 15 } },
    { statusEffect: 'training_focus', turns: 2, polarity: 'positive', buff: { magical_attack: 20 } },
    { statusEffect: 'training_slow', turns: 2, polarity: 'negative', debuff: { speed: -10 } },
    { statusEffect: 'training_weakness', turns: 2, polarity: 'negative', debuff: { physical_attack: -15 } },
];

/** Everything the generator reads from the catalogue, loaded once per call. */
interface GenerationPools {
    elements: Array<{ id: string; skillTrees: string[] }>;
    treesByElement: Map<string, string[]>;
    damagingSkills: Set<string>;
    characterIds: string[];
    mobIds: string[];
}

export interface AiScenarioGenerationOptions {
    id: string;
    seed: number | string;
    split?: AiScenarioSplit;
    /** Inclusive team-size band; defaults to the training contract's 2–5. */
    teamSize?: readonly [number, number];
    maxTurns?: number;
}

export interface AiScenarioSuiteOptions {
    seed?: number | string;
    splitCounts?: Partial<Record<AiScenarioSplit, number>>;
    teamSize?: readonly [number, number];
    maxTurns?: number;
}

async function loadPools(): Promise<GenerationPools> {
    const [trees, elements, characters, mobs] = await Promise.all([
        getLearningTrees(),
        getAllElementsDataService(),
        getAllCharactersData(),
        getAllMobsData(),
    ]);

    const treesByElement = new Map<string, string[]>();
    const damagingSkills = new Set<string>();
    for (const tree of trees) {
        treesByElement.set(tree.element_id, tree.nodes.map((node) => node.attack_id));
        for (const node of tree.nodes) {
            if (node.skill.damage) damagingSkills.add(node.attack_id);
        }
    }

    return {
        elements: elements
            .filter((element) => Array.isArray(element.skillTrees) && element.skillTrees.length > 0)
            .map((element) => ({ id: element.id, skillTrees: element.skillTrees })),
        treesByElement,
        damagingSkills,
        characterIds: characters.map((character) => character.id),
        mobIds: mobs.map((mob) => mob.id),
    };
}

/** Catalogue data is immutable at runtime; one promise serves a whole suite. */
let cachedPools: Promise<GenerationPools> | null = null;

function getPools(): Promise<GenerationPools> {
    cachedPools ??= loadPools();
    return cachedPools;
}

function rollStat(random: SeededCombatRandom, band: readonly [number, number]): number {
    return randomInt(random, band[0], band[1]);
}

function buildStats(random: SeededCombatRandom, archetype: UnitArchetype): CombatStats {
    const band = archetype.stats;
    return {
        maxHp: rollStat(random, band.hp),
        maxMana: rollStat(random, band.mana),
        maxStamina: rollStat(random, band.stamina),
        physicalAttack: rollStat(random, band.physicalAttack),
        magicalAttack: rollStat(random, band.magicalAttack),
        physicalDefense: rollStat(random, band.physicalDefense),
        magicalDefense: rollStat(random, band.magicalDefense),
        speed: rollStat(random, band.speed),
        accuracy: BASE_ACCURACY_MODIFIER,
        evasion: BASE_EVASION,
        critChance: BASE_CRIT_CHANCE,
    };
}

function pickLine(random: SeededCombatRandom, archetype: UnitArchetype): CombatLine {
    if (archetype.line !== 'either') return archetype.line;
    return random() < 0.5 ? 'front' : 'rear';
}

function skillsForElement(pools: GenerationPools, elementId: string): string[] {
    const element = pools.elements.find((entry) => entry.id === elementId);
    if (!element) return [];

    const allowed = element.skillTrees
        .map((treeId) => pools.treesByElement.get(treeId) ?? [])
        .flat();
    return [...new Set(allowed)];
}

function sampleSkills(
    random: SeededCombatRandom,
    pools: GenerationPools,
    elementId: string,
    count: number,
    minDamaging: number,
): string[] {
    const primary = pools.treesByElement.get(elementId) ?? [];
    const pool = skillsForElement(pools, elementId);
    if (pool.length === 0) return [];

    const fromPrimary = Math.min(primary.length, Math.max(1, Math.ceil(count * 0.6)));
    const chosen = randomSample(random, primary, fromPrimary);

    const rest = pool.filter((skillId) => !chosen.includes(skillId));
    chosen.push(...randomSample(random, rest, Math.max(0, count - chosen.length)));

    // Buff-heavy kits spend every turn re-applying support and never deal
    // damage; keep a floor of damaging actions so battles can actually resolve.
    const damagingPool = pool.filter((skillId) => pools.damagingSkills.has(skillId));
    let missingDamage = Math.min(minDamaging, damagingPool.length)
        - chosen.filter((skillId) => pools.damagingSkills.has(skillId)).length;
    while (missingDamage > 0) {
        const available = damagingPool.filter((skillId) => !chosen.includes(skillId));
        if (available.length === 0) break;
        const damage = randomPick(random, available);
        const replaceIndex = chosen.findIndex((skillId) => !pools.damagingSkills.has(skillId));
        if (replaceIndex >= 0) chosen[replaceIndex] = damage;
        else chosen.push(damage);
        missingDamage -= 1;
    }

    return [...new Set(chosen)];
}

function sampleOpeningEffects(
    random: SeededCombatRandom,
    unitKey: string,
) {
    if (random() < 0.45) return [];

    const count = randomInt(random, 1, 2);
    return randomSample(random, OPENING_STATUSES, count).map((template, index) => (
        createStatusEffect({
            effectId: `training:${unitKey}:status:${index}`,
            sourceId: 'training',
            statusEffect: template.statusEffect,
            turns: template.turns,
            polarity: template.polarity,
            damagePerTurn: template.damagePerTurn,
            buff: template.buff,
            debuff: template.debuff,
        })
    ));
}

function entityPoolFor(side: CombatSide, pools: GenerationPools): {
    ids: string[];
    entityType: CombatEntityType;
} {
    if (side === 'allies') {
        return pools.characterIds.length > 0
            ? { ids: pools.characterIds, entityType: 'character' }
            : { ids: pools.mobIds, entityType: 'mob' };
    }
    return pools.mobIds.length > 0
        ? { ids: pools.mobIds, entityType: 'mob' }
        : { ids: pools.characterIds, entityType: 'character' };
}

function buildSide(
    random: SeededCombatRandom,
    pools: GenerationPools,
    side: CombatSide,
    size: number,
): { units: AiTrainingScenario['units']; members: CombatEncounterMember[] } {
    const entityPool = entityPoolFor(side, pools);
    const lineCounts: Record<CombatLine, number> = { front: 0, rear: 0 };
    const units: AiTrainingScenario['units'] = [];
    const members: CombatEncounterMember[] = [];

    for (let index = 0; index < size; index += 1) {
        // At least one front-liner per side: an all-rear team cannot trade melee
        // hits with an all-front team and the fight degenerates into 300 turns of
        // guarding and line swapping.
        const archetype = index === 0
            ? randomPick(random, FRONT_ARCHETYPES)
            : randomPick(random, ARCHETYPES);
        const line = pickLine(random, archetype);
        const slot = lineCounts[line];
        lineCounts[line] += 1;

        const element = randomPick(random, pools.elements);
        const skillCount = randomInt(random, archetype.skills[0], archetype.skills[1]);
        const minDamaging = archetype.id === 'support' ? 1 : 2;
        const skillIds = sampleSkills(random, pools, element.id, skillCount, minDamaging);
        const entityId = randomPick(random, entityPool.ids);
        const key = `${side}_${line}_${slot}_${entityId}`;

        units.push({
            key,
            entityId,
            entityType: entityPool.entityType,
            side,
            line,
            slot,
            isPlayerControlled: false,
            personality: randomPick(random, AI_TRAINING_PERSONALITIES),
            stats: buildStats(random, archetype),
            elementIds: [element.id],
            skillIds,
            startingEffects: sampleOpeningEffects(random, key),
        });

        members.push({
            entityId,
            entityType: entityPool.entityType,
            line,
            isPlayerControlled: false,
            weapons: [TRAINING_WEAPON_ID],
            inventory: { [TRAINING_ITEM_ID]: TRAINING_ITEM_QUANTITY },
        });
    }

    return { units, members };
}

function markProtagonist(random: SeededCombatRandom, units: AiTrainingScenario['units']): void {
    if (units.length === 0) return;
    const index = randomInt(random, 0, units.length - 1);
    units[index].isPlayerControlled = true;
}

/**
 * Builds one reproducible N-vs-M scenario. The same seed and id always produce
 * the same units, loadouts and encounter.
 */
export async function generateTrainingScenario(
    options: AiScenarioGenerationOptions,
): Promise<AiTrainingScenario> {
    const pools = await getPools();
    const random = createSeededCombatRandom(`${options.seed}:${options.id}`);
    const [minSize, maxSize] = options.teamSize ?? [AI_MIN_TEAM_SIZE, AI_MAX_TEAM_SIZE];
    const alliesSize = randomInt(random, minSize, maxSize);
    const enemiesSize = randomInt(random, minSize, maxSize);

    const allies = buildSide(random, pools, 'allies', alliesSize);
    const enemies = buildSide(random, pools, 'enemies', enemiesSize);
    markProtagonist(random, allies.units);

    // Keep the encounter's member flags in sync with the marked protagonist.
    for (const [index, unit] of allies.units.entries()) {
        allies.members[index].isPlayerControlled = unit.isPlayerControlled;
    }

    const encounter: CombatEncounter = {
        id: `training_${options.id}`,
        name: `Training ${options.id}`,
        allies: allies.members,
        enemies: enemies.members,
    };

    return {
        id: options.id,
        seed: hashAiSeed(options.seed),
        split: options.split ?? 'train',
        encounter,
        units: [...allies.units, ...enemies.units],
        maxTurns: options.maxTurns ?? AI_DEFAULT_MAX_TURNS,
    };
}

/** Stable train/validation/test partitions, each seeded from the suite seed. */
export async function generateTrainingScenarioSuite(
    options: AiScenarioSuiteOptions = {},
): Promise<AiTrainingScenarioSuite> {
    const seed = options.seed ?? 'galatime-training';
    const counts: Record<AiScenarioSplit, number> = {
        train: options.splitCounts?.train ?? 20,
        validation: options.splitCounts?.validation ?? 5,
        test: options.splitCounts?.test ?? 5,
    };

    const build = async (split: AiScenarioSplit): Promise<AiTrainingScenario[]> => {
        const scenarios: AiTrainingScenario[] = [];
        for (let index = 0; index < counts[split]; index += 1) {
            scenarios.push(await generateTrainingScenario({
                id: `${split}_${index}`,
                seed: `${seed}:${split}:${index}`,
                split,
                teamSize: options.teamSize,
                maxTurns: options.maxTurns,
            }));
        }
        return scenarios;
    };

    return {
        train: await build('train'),
        validation: await build('validation'),
        test: await build('test'),
    };
}
