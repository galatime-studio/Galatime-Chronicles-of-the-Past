/**
 * Action factories.
 *
 * Normalises the three authored action sources — a skill from the shared
 * catalogue, an entity's weapon, and the universal movements — into the single
 * {@link CombatAction} shape the resolver consumes.
 *
 * The catalogue does not author a reach, so a skill defaults to `medium` and a
 * weapon to `short`. Authors can set `range: short|medium|long` on a skill (or
 * weapon) to opt into the plan's range restrictions.
 */

import {
    CURSED_WEAR_BONUS,
    DEFAULT_ACCURACY,
    DEFAULT_AMMO_CONSUME_CHANCE,
    DEFAULT_SKILL_RANGE,
    DEFAULT_WEAPON_RANGE,
    FRAGILE_WEAPON_BREAK_CHANCE,
    WEAPON_DAMAGE_TYPE,
} from '../../constants/CombatConstants';
import { WEAPON_SFX_ID } from '../../constants/CombatSoundConstants';
import type { AttackEffect, PublicAttack } from '../../types/AttackDataType';
import type {
    CombatAction,
    CombatActionCost,
    CombatRange,
    CombatStats,
    CombatTargetRule,
    DamageType,
} from '../../types/CombatType';
import type { WeaponDefinition, WeaponRuntimeState, WeaponTypeId } from '../../types/WeaponType';
import { asRecord, clamp, readBoolean, readNumber, readPower, readString, readVariance } from '../../utils/combatUtils';
import { effectHeals } from './effectResolver';

/**
 * Maps every authored targeting word onto the runtime rule.
 *
 * The old `enemy_one`/`ally_one` split is gone: both collapse into `any_one`,
 * which lets the frontend offer every living unit on the battlefield — the
 * actor included — as the single target. Legacy content keeps loading unchanged.
 */
export function normalizeTargeting(raw: unknown): CombatTargetRule {
    const value = typeof raw === 'string' ? raw : readString(asRecord(raw)?.target, '');

    switch (value) {
        case 'enemies_all':
        case 'all_enemies':
        case 'enemies':
            return 'enemies_all';
        case 'allies_all':
        case 'all_allies':
        case 'allies':
            return 'allies_all';
        case 'self':
            return 'self';
        case 'both_teams':
        case 'all':
            return 'both_teams';
        case 'enemies_lane':
        case 'enemies_local':
            return 'enemies_lane';
        case 'any_one':
        case 'enemy_one':
        case 'ally_one':
        case 'unit_one':
        case 'individual':
        case 'single':
        case 'enemy':
        case 'ally':
        case 'unit':
        case 'target':
        default:
            return 'any_one';
    }
}

/** Reads an authored reach, falling back when it is missing or unrecognised. */
function readRange(raw: unknown, fallback: CombatRange): CombatRange {
    const value = readString(raw, '');
    return value === 'short' || value === 'medium' || value === 'long' ? value : fallback;
}

function readDamageType(raw: unknown, fallback: DamageType): DamageType {
    const value = readString(raw, '');
    return value === 'physical' || value === 'magical' ? value : fallback;
}

function readCosts(source: Record<string, unknown> | null, fallbackStamina: number): CombatActionCost {
    return {
        mana: readNumber(source?.mana, 0),
        stamina: readNumber(source?.stamina, fallbackStamina),
        hp: Math.max(0, readNumber(source?.hp, 0)),
        cooldown: readNumber(source?.cooldown, 0),
    };
}

/** Reads a record of multipliers, keeping only the usable numbers. */
function readMultiplierRecord(source: unknown): Record<string, number> {
    const record = asRecord(source);
    if (!record) return {};

    const result: Record<string, number> = {};
    for (const [key, raw] of Object.entries(record)) {
        const value = readNumber(raw, Number.NaN);
        if (Number.isFinite(value)) result[key] = value;
    }

    return result;
}

/** Reads the extra multiplier a skill gets against a wounded target. */
function readBonusVsHpBelow(source: unknown): { threshold: number; multiplier: number } | null {
    const record = asRecord(source);
    if (!record) return null;

    const threshold = readNumber(record.threshold, Number.NaN);
    const multiplier = readNumber(record.multiplier, Number.NaN);
    if (!Number.isFinite(threshold) || !Number.isFinite(multiplier)) return null;

    return { threshold, multiplier };
}

/** Reads a `bonus_vs_status` trait (object or list); every entry folds in. */
function readBonusVsStatus(source: Record<string, unknown>): CombatAction['bonusVsStatus'] {
    const raw = source.bonus_vs_status;
    const records = Array.isArray(raw) ? raw : [raw];
    const specs: Array<{ status: string; multiplier: number; defensePierce: number }> = [];

    for (const entry of records) {
        const record = asRecord(entry);
        const status = record ? readString(record.status, '').trim() : '';
        if (!status) continue;

        specs.push({
            status,
            multiplier: Math.max(1, readNumber(record?.multiplier, 1)),
            defensePierce: clamp(readNumber(record?.defense_pierce, 0), 0, 1),
        });
    }

    return specs.length > 0 ? specs : null;
}

/** Reads a `collateral` splash spec (`riptide` clips the target's neighbours). */
function readCollateral(source: Record<string, unknown>): CombatAction['collateral'] {
    const record = asRecord(source.collateral);
    if (!record) return null;

    // O Forger autoriza um intervalo (`[min, max]`); o motor usa a média.
    const multiplier = Array.isArray(record.damage_multiplier)
        ? (Number(record.damage_multiplier[0]) + Number(record.damage_multiplier[1])) / 2
        : readNumber(record.damage_multiplier, 0.5);
    const chance = readNumber(record.chance, 1);

    return {
        // Half of the main power is the supported-authored default.
        damageMultiplier: clamp(Number.isFinite(multiplier) ? multiplier : 0.5, 0, 1),
        chance: clamp(Number.isFinite(chance) ? chance : 1, 0, 1),
        includePrimaryTargets: readBoolean(record.include_primary_targets, false),
        includeCaster: readBoolean(record.include_caster, false),
    };
}

/** Reads a `bonus_per_charge` trait (`avalanche` spends Freeze charges). */
function readBonusPerCharge(source: Record<string, unknown>): CombatAction['bonusPerCharge'] {
    const record = asRecord(source.bonus_per_charge);
    const status = record ? readString(record.status, '').trim() : '';
    if (!status) return null;

    return {
        status,
        multiplierPerCharge: Math.max(0, readNumber(record?.multiplier_per_charge, 0)),
        consume: readBoolean(record?.consume, true),
    };
}

/** Reads a `power_scaling` trait (`Tempest Flurry` scales with speed). */
function readPowerScaling(source: Record<string, unknown>): CombatAction['powerScaling'] {
    const record = asRecord(source.power_scaling);
    const stat = record ? readString(record.stat, '') : '';
    const perPoint = record ? readNumber(record.per_point, 0) : 0;
    if (!stat || perPoint <= 0) return null;

    return { stat: stat as keyof CombatStats, perPoint };
}

/** Reads the caster's own price for a reckless action. */
function readRecoil(source: Record<string, unknown>): CombatAction['recoil'] {
    const record = asRecord(source.recoil);
    if (!record) return null;
    const hp = Math.max(0, readNumber(record.hp, 0));
    const fractionOfDamage = clamp(readNumber(record.fraction_of_damage, 0), 0, 1);
    return hp > 0 || fractionOfDamage > 0 ? { hp, fractionOfDamage } : null;
}

/** Reads the splash a reckless action throws onto its caster's allies. */
function readFriendlyFire(source: Record<string, unknown>): CombatAction['friendlyFire'] {
    const record = asRecord(source.friendly_fire);
    if (!record) return null;
    const damage = Math.max(0, readNumber(record.damage, 0));
    const percentOfPower = clamp(readNumber(record.percent_of_power, 0), 0, 1);
    if (damage <= 0 && percentOfPower <= 0) return null;
    const scope = readString(record.scope, 'allies_lane') === 'allies_all' ? 'allies_all' : 'allies_lane';
    return {
        damage,
        percentOfPower,
        chance: clamp(readNumber(record.chance, 1), 0, 1),
        scope,
    };
}

/** Reads the chance a blast clips the enemy rear line. */
function readBacklaneSplash(source: Record<string, unknown>): CombatAction['backlaneSplash'] {
    const record = asRecord(source.backlane_splash);
    if (!record) return null;
    const power = Math.max(0, readNumber(record.power, 0));
    const percentOfDamage = clamp(readNumber(record.percent_of_damage, 0), 0, 1);
    if (power <= 0 && percentOfDamage <= 0) return null;
    return {
        chance: clamp(readNumber(record.chance, 0.2), 0, 1),
        power,
        percentOfDamage,
        both: readBoolean(record.both, false),
    };
}

/** Reads a `no_space_recoil` clause. */
function readNoSpaceRecoil(source: Record<string, unknown>): CombatAction['noSpaceRecoil'] {
    const record = asRecord(source.no_space_recoil);
    if (!record) return null;
    const fraction = clamp(readNumber(record.fraction, 0), 0, 1);
    return fraction > 0 ? { fraction } : null;
}

/** Reads a serial chain / fork specification. */
function readChain(source: Record<string, unknown>): CombatAction['chain'] {
    const record = asRecord(source.chain);
    if (!record) return null;
    const jumps = Math.max(0, Math.round(readNumber(record.jumps, 0)));
    const branches = Math.max(0, Math.round(readNumber(record.branches, 0)));
    if (jumps <= 0 && branches <= 0) return null;
    return {
        chance: clamp(readNumber(record.chance, 1), 0, 1),
        chanceStep: clamp(readNumber(record.chance_step, 0), -1, 1),
        minChance: clamp(readNumber(record.min_chance, 0), 0, 1),
        jumps,
        powerPercent: clamp(readNumber(record.power_percent, 0.6), 0, 1),
        accuracy: ((): number | null => {
            const value = readNumber(record.accuracy, Number.NaN);
            return Number.isFinite(value) ? clamp(value, 0, 100) : null;
        })(),
        includeAllies: readBoolean(record.include_allies, false),
        weightedBacklane: readBoolean(record.weighted_backlane, false),
        prioritizeStatus: readString(record.prioritize_status, '') || null,
        stunChance: clamp(readNumber(record.stun_chance, 0), 0, 1),
        branches,
    };
}

/** Reads a shrapnel burst specification. */
function readShrapnel(source: Record<string, unknown>): CombatAction['shrapnel'] {
    const record = asRecord(source.shrapnel);
    if (!record) return null;
    const count = Math.max(0, Math.round(readNumber(record.count, 0)));
    const power = Math.max(0, readNumber(record.power, 0));
    if (count <= 0 || power <= 0) return null;
    return {
        count,
        power,
        accuracy: ((): number | null => {
            const value = readNumber(record.accuracy, Number.NaN);
            return Number.isFinite(value) ? clamp(value, 0, 100) : null;
        })(),
        includeAllies: readBoolean(record.include_allies, true),
        focusStatus: readString(record.focus_status, '') || null,
    };
}

/** Reads the instability charges an explosive builds on its caster. */
function readInstability(source: Record<string, unknown>): CombatAction['instability'] {
    const record = asRecord(source.instability);
    if (!record) return null;
    return {
        status: readString(record.status, 'Instability') || 'Instability',
        max: Math.max(1, Math.round(readNumber(record.max, 3))),
        damagePerCharge: Math.max(0, readNumber(record.damage_per_charge, 0.1)),
        variancePerCharge: Math.max(0, readNumber(record.variance_per_charge, 0.1)),
        selfDamage: Math.max(0, readNumber(record.self_damage, 0)),
        selfDamageChance: clamp(readNumber(record.self_damage_chance, 0.25), 0, 1),
        turns: Math.max(1, Math.round(readNumber(record.turns, 3))),
    };
}

/** Reads a secondary blast that fires when the action defeats somebody. */
function readOnKillDetonation(source: Record<string, unknown>): CombatAction['onKillDetonation'] {
    const record = asRecord(source.on_kill_detonation);
    if (!record) return null;
    const power = Math.max(0, readNumber(record.power, 0));
    return power > 0
        ? { power, includeAllies: readBoolean(record.include_allies, false) }
        : null;
}

/** Reads a cooldown refund that fires when a hit target carries a named status. */
function readCooldownReset(source: Record<string, unknown>): CombatAction['cooldownReset'] {
    const record = asRecord(source.cooldown_reset);
    if (!record) return null;
    const status = readString(record.status, '').trim();
    const amount = Math.max(1, Math.round(readNumber(record.amount, 1)));
    return status ? { status, amount } : null;
}

/** Reads a hit that grows with the caster's accumulated damage taken. */
function readDamageTakenScaling(source: Record<string, unknown>): CombatAction['damageTakenScaling'] {
    const record = asRecord(source.damage_taken_scaling);
    if (!record) return null;
    const perPoint = Math.max(0, readNumber(record.per_point, 0));
    if (perPoint <= 0) return null;
    const max = Math.max(0, readNumber(record.max, 0));
    return max > 0 ? { perPoint, max } : { perPoint };
}

/** Reads the weak/resist nudge applied after the element table. */
function readElementEffectiveness(source: Record<string, unknown>): CombatAction['elementEffectiveness'] {
    const record = asRecord(source.element_effectiveness);
    if (!record) return null;
    const weak = Math.max(0, readNumber(record.weak, 1));
    const resist = Math.max(0, readNumber(record.resist, 1));
    return weak !== 1 || resist !== 1 ? { weak, resist } : null;
}

/** Reads status-stack consumption (`flash_point`, `melt_down`, `ashen_carapace`). */
function readConsumeStacks(source: Record<string, unknown>): CombatAction['consumeStacks'] {
    if (!Array.isArray(source.consume_stacks)) return null;
    const specs = source.consume_stacks
        .map((entry) => {
            const record = asRecord(entry);
            if (!record) return null;
            const status = readString(record.status, '').trim();
            if (!status) return null;
            return {
                status,
                perStack: Math.max(0, readNumber(record.per_stack, 0)),
                ignoreDefense: readBoolean(record.ignore_defense, false),
                healPercentPerStack: Math.max(0, readNumber(record.heal_percent_per_stack, 0)),
            };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return specs.length > 0 ? specs : null;
}

/** Reads a delayed battlefield-wide aftershock (`tremor`). */
function readAftershock(source: Record<string, unknown>): CombatAction['aftershock'] {
    const record = asRecord(source.aftershock);
    if (!record) return null;
    const power = Math.max(0, readNumber(record.power, 0));
    if (power <= 0) return null;
    const minTurns = Math.max(1, Math.round(readNumber(record.min_turns, 2)));
    const maxTurns = Math.max(minTurns, Math.round(readNumber(record.max_turns, 4)));
    return { power, minTurns, maxTurns };
}

/** Reads an earthquake-style position shuffle. */
function readShufflePositions(source: Record<string, unknown>): CombatAction['shufflePositions'] {
    const record = asRecord(source.shuffle_positions);
    if (!record) return null;
    return {
        chance: clamp(readNumber(record.chance, 0.4), 0, 1),
        laneChance: clamp(readNumber(record.lane_chance, 0.25), 0, 1),
    };
}

/** Reads damage that grows with the distance between caster and target. */
function readDistanceScaling(source: Record<string, unknown>): CombatAction['distanceScaling'] {
    const record = asRecord(source.distance_scaling);
    if (!record) return null;
    const perLane = Math.max(0, readNumber(record.per_lane, 0));
    if (perLane <= 0) return null;
    return {
        perLane,
        maxLanes: Math.max(1, Math.round(readNumber(record.max_lanes, 1))),
    };
}

/** Reads a cascading lane strike. */
function readLaneCascade(source: Record<string, unknown>): CombatAction['laneCascade'] {
    const record = asRecord(source.lane_cascade);
    if (!record) return null;
    const subsequent = clamp(readNumber(record.subsequent, 0.6), 0, 1);
    return {
        first: clamp(readNumber(record.first, 1), 0, 4),
        subsequent,
    };
}

/**
 * The traits every action carries, whatever it came from.
 *
 * A weapon or a universal movement has none of them: the traits belong to the
 * skills the catalogue authors.
 */
function defaultTraits(): Pick<
    CombatAction,
    'solar' | 'lunar' | 'onlyDuringDay' | 'onlyDuringNight' | 'critChance' | 'ignoreAccuracy' | 'defensePierce'
    | 'bonusVsElements' | 'bonusVsHpBelow' | 'fleeBelowHp' | 'guaranteedCritVsStatus'
    | 'bonusVsStatus' | 'bonusPerCharge' | 'collateral'
    | 'scatterTargets' | 'scatterHits' | 'canHitAnyEnemy' | 'ignorePositionPenalty'
    | 'powerScaling' | 'critMultiplier'
    | 'recoil' | 'friendlyFire' | 'backlaneSplash' | 'noSpaceRecoil'
    | 'chain' | 'shrapnel' | 'instability' | 'controlImmuneDamage' | 'onKillDetonation'
    | 'cooldownReset'
    | 'damageTakenScaling'
    | 'elementEffectiveness'
    | 'consumeStacks'
    | 'aftershock'
    | 'shufflePositions'
    | 'ignoreEvasion' | 'cannotCrit' | 'failIfTargetMoves' | 'failCostFraction'
    | 'frontLaneBonus' | 'distanceScaling' | 'laneCascade' | 'bonusVsImmobile' | 'echoBurst'
> {
    return {
        solar: false,
        lunar: false,
        onlyDuringDay: false,
        onlyDuringNight: false,
        critChance: 0,
        ignoreAccuracy: false,
        defensePierce: 0,
        bonusVsElements: {},
        bonusVsHpBelow: null,
        fleeBelowHp: null,
        guaranteedCritVsStatus: null,
        bonusVsStatus: null,
        bonusPerCharge: null,
        collateral: null,
        scatterTargets: false,
        scatterHits: null,
        canHitAnyEnemy: false,
        ignorePositionPenalty: false,
        powerScaling: null,
        critMultiplier: null,
        recoil: null,
        friendlyFire: null,
        backlaneSplash: null,
        noSpaceRecoil: null,
        chain: null,
        shrapnel: null,
        instability: null,
        controlImmuneDamage: 0,
        onKillDetonation: null,
        cooldownReset: null,
        damageTakenScaling: null,
        elementEffectiveness: null,
        consumeStacks: null,
        aftershock: null,
        shufflePositions: null,
        ignoreEvasion: false,
        cannotCrit: false,
        failIfTargetMoves: false,
        failCostFraction: 0.5,
        frontLaneBonus: 0,
        distanceScaling: null,
        laneCascade: null,
        bonusVsImmobile: 0,
        echoBurst: null,
    };
}

/** Reads an optional scatter ray count; `null` means "use `hitCount`". */
function readScatterHits(raw: unknown): number | null {
    const value = readNumber(raw, Number.NaN);
    if (!Number.isFinite(value)) return null;
    return Math.max(1, Math.round(value));
}

/** Builds an action from one catalogue skill. */
export function createCombatActionFromSkill(skill: PublicAttack): CombatAction {
    const damage = asRecord(skill.damage);
    const effects: AttackEffect[] = Array.isArray(skill.effects) ? skill.effects : [];
    const power = readPower(damage?.power ?? skill.power);
    // `range` and a top-level `damage_variance` are not part of the public skill
    // projection yet, so they are read off the raw record.
    const raw = skill as unknown as Record<string, unknown>;
    const dealsDamage = power > 0
        || Boolean(asRecord(raw.damage_taken_scaling))
        || Boolean(asRecord(raw.chain));

    return {
        id: skill.id,
        kind: 'skill',
        name: skill.name,
        description: readString(skill.description, ''),
        elementId: skill.element_id,
        sfxId: readString(skill.sfx, '') || null,
        damageType: readDamageType(damage?.damage_type ?? damage?.kind, 'magical'),
        range: readRange(raw.range, DEFAULT_SKILL_RANGE),
        power,
        accuracy: readNumber(skill.accuracy, DEFAULT_ACCURACY),
        hitCount: Math.max(1, Math.round(readNumber(skill.hit_count, 1))),
        scatterTargets: readBoolean(skill.scatter_targets, false),
        scatterHits: readScatterHits(skill.scatter_hits),
        canHitAnyEnemy: readBoolean(skill.can_hit_any_enemy, false),
        ignorePositionPenalty: readBoolean(skill.ignore_position_penalty, false),
        costs: readCosts(asRecord(skill.costs), 0),
        targeting: normalizeTargeting(skill.targeting),
        effects,
        damageVariance: readVariance(damage?.damage_variance) ?? readVariance(raw.damage_variance),
        dealsDamage,
        // Only a non-damaging action can be a *heal*: a damaging attack with a
        // self-lifesteal effect (Chaoseater) is still an attack, and marking it
        // `heals` would make the AI aim it at allies.
        heals: !dealsDamage && effects.some(effectHeals),
        // The traits the skill forger writes and the engine reads.
        solar: readBoolean(skill.solar, false),
        lunar: readBoolean(skill.lunar, false),
        onlyDuringDay: readBoolean(skill.only_during_day, false),
        onlyDuringNight: readBoolean(skill.only_during_night, false),
        critChance: clamp(readNumber(skill.crit_chance, 0), 0, 100),
        ignoreAccuracy: readBoolean(skill.ignore_accuracy, false),
        defensePierce: clamp(readNumber(skill.defense_pierce, 0), 0, 1),
        bonusVsElements: readMultiplierRecord(skill.bonus_vs_elements),
        bonusVsHpBelow: readBonusVsHpBelow(skill.bonus_vs_hp_below),
        fleeBelowHp: typeof skill.flee_below_hp === 'number' && Number.isFinite(skill.flee_below_hp)
            ? clamp(skill.flee_below_hp, 0, 1)
            : null,
        guaranteedCritVsStatus: readString(skill.guaranteed_crit_vs_status, '') || null,
        bonusVsStatus: readBonusVsStatus(skill as unknown as Record<string, unknown>),
        bonusPerCharge: readBonusPerCharge(skill as unknown as Record<string, unknown>),
        collateral: readCollateral(skill as unknown as Record<string, unknown>),
        powerScaling: readPowerScaling(skill as unknown as Record<string, unknown>),
        critMultiplier: ((): number | null => {
            const value = readNumber(raw.crit_multiplier, 0);
            return Number.isFinite(value) && value > 0 ? value : null;
        })(),
        recoil: readRecoil(raw),
        friendlyFire: readFriendlyFire(raw),
        backlaneSplash: readBacklaneSplash(raw),
        noSpaceRecoil: readNoSpaceRecoil(raw),
        chain: readChain(raw),
        shrapnel: readShrapnel(raw),
        instability: readInstability(raw),
        controlImmuneDamage: Math.max(0, readNumber(raw.control_immune_damage, 0)),
        onKillDetonation: readOnKillDetonation(raw),
        cooldownReset: readCooldownReset(raw),
        damageTakenScaling: readDamageTakenScaling(raw),
        elementEffectiveness: readElementEffectiveness(raw),
        consumeStacks: readConsumeStacks(raw),
        aftershock: readAftershock(raw),
        shufflePositions: readShufflePositions(raw),
        ignoreEvasion: readBoolean(raw.ignore_evasion, false),
        cannotCrit: readBoolean(raw.cannot_crit, false),
        failIfTargetMoves: readBoolean(raw.fail_if_target_moves, false),
        failCostFraction: clamp(readNumber(raw.fail_cost_fraction, 0.5), 0, 1),
        frontLaneBonus: Math.max(0, readNumber(raw.front_lane_bonus, 0)),
        distanceScaling: readDistanceScaling(raw),
        laneCascade: readLaneCascade(raw),
        bonusVsImmobile: Math.max(0, readNumber(raw.bonus_vs_immobile, 0)),
        echoBurst: ((): CombatAction['echoBurst'] => {
            const record = asRecord(raw.echo_burst);
            const percent = record ? Math.max(0, readNumber(record.percent, 0)) : 0;
            return percent > 0 ? { percent } : null;
        })(),
    };
}

/**
 * Builds the action(s) an entity's weapon provides.
 *
 * A weapon resolves through the exact same damage chain as a skill: the same
 * `ATK x EFFECT x PWR / RES` formula, the same element efficacy, variance and
 * hit rolls. Unlike a skill it may also offer a second, thrown action (a lance
 * hurled at the back line), so the factory returns a list — the swing first.
 *
 * The authored `damage_type`, `effects`, `cooldown` and `range` are honoured: a
 * scepter channels magically and a mace can go on cooldown.
 */
export function createCombatActionFromWeapon(weapon: WeaponDefinition): CombatAction[] {
    const actions: CombatAction[] = [buildWeaponAction(weapon)];
    if (weapon.throw) actions.push(buildWeaponAction(weapon, true));
    return actions;
}

/** Builds one weapon action; `throwing` selects the hurl variant. */
function buildWeaponAction(weapon: WeaponDefinition, throwing = false): CombatAction {
    const id = readString(weapon.id, 'weapon');
    const type: WeaponTypeId = weapon.type ?? 'sword';
    const throwSpec = throwing ? weapon.throw : undefined;
    const power = readPower(throwSpec?.power ?? weapon.power);
    const effects: AttackEffect[] = Array.isArray(weapon.effects) ? weapon.effects : [];
    const dealsDamage = power > 0;

    return {
        id: throwing ? `weapon:${id}:throw` : `weapon:${id}`,
        kind: 'weapon',
        name: throwing ? `${readString(weapon.name, 'Attack')} (Thrown)` : readString(weapon.name, 'Attack'),
        // The authored summary is what the hover tooltips read; `description` is
        // the bare fallback the catalogue rarely fills.
        description: readString(weapon.display?.summary, '') || readString(weapon.description, ''),
        elementId: readString(weapon.element, 'inanus'),
        sfxId: WEAPON_SFX_ID,
        damageType: readDamageType(weapon.damage_type, WEAPON_DAMAGE_TYPE),
        range: readRange(throwSpec?.range ?? weapon.range, DEFAULT_WEAPON_RANGE),
        power,
        accuracy: readNumber(throwSpec?.accuracy ?? weapon.accuracy, DEFAULT_ACCURACY),
        hitCount: Math.max(1, Math.round(readNumber(weapon.hits, 1))),
        costs: {
            mana: 0,
            stamina: readNumber(weapon.stamina_cost, 0),
            hp: 0,
            cooldown: Math.max(0, readNumber(weapon.cooldown, 0)),
        },
        targeting: normalizeTargeting(weapon.target),
        effects,
        damageVariance: readVariance(weapon.damage_variance),
        dealsDamage,
        // See the skill factory: a weapon that also drains/heals is not a heal.
        heals: !dealsDamage && effects.some(effectHeals),
        ...defaultTraits(),
        weapon: {
            weaponId: id,
            type,
            throw: throwing || undefined,
            returns: throwing ? throwSpec?.returns === true : undefined,
            accuracyByRange: weapon.accuracy_by_range,
            exponential: weapon.exponential,
            damageModifiers: weapon.damage_modifiers,
            ammo: throwing ? undefined : weapon.ammo,
            randomizePower: weapon.flags?.includes('randomize_power') ?? false,
        },
    };
}

/**
 * Projects a weapon definition onto the mutable state its holder carries.
 *
 * The action list is shared between every unit of the same blueprint, so the
 * shared parts (power, range, effects) stay on the actions while the per-holder
 * parts — durability, ammo, passive multipliers — are cloned here, once per
 * unit, by {@link instantiateUnit}.
 */
export function createWeaponRuntimeState(
    weapon: WeaponDefinition,
    actionIds: string[],
): WeaponRuntimeState {
    const durability = weapon.durability;
    const max = durability ? Math.max(1, Math.round(readNumber(durability.max, 1))) : null;
    const cursed = weapon.flags?.includes('cursed') === true;

    return {
        id: readString(weapon.id, 'weapon'),
        name: readString(weapon.name, 'Attack'),
        summary: readString(weapon.display?.summary, '') || readString(weapon.description, ''),
        type: weapon.type ?? 'sword',
        actionIds,
        durability: max,
        maxDurability: max,
        indestructible: durability?.indestructible === true,
        // A cursed weapon eats durability faster than it should.
        wear: Math.max(0, readNumber(durability?.wear, 1)) + (cursed ? CURSED_WEAR_BONUS : 0),
        ammoItem: readString(weapon.ammo?.item, '') || null,
        ammoType: readString(weapon.ammo?.item_type, '') || null,
        ammoConsumeChance: readNumber(weapon.ammo?.consume_chance, DEFAULT_AMMO_CONSUME_CHANCE),
        ammo: null,
        effectPower: Math.max(1, readNumber(weapon.effect_power, 1)),
        lootChanceMultiplier: Math.max(0, readNumber(weapon.loot?.chance_multiplier, 1)),
        costModifiers: weapon.cost_modifiers ?? null,
        damageModifiers: weapon.damage_modifiers ?? null,
        breakChance: weapon.flags?.includes('fragile') ? FRAGILE_WEAPON_BREAK_CHANCE : 0,
        stacks: 0,
        stackTargetId: null,
        flags: Array.isArray(weapon.flags) ? weapon.flags : [],
    };
}

/**
 * Small helper so the universal list stays declarative.
 *
 * The reach is `medium`, not the weapon default of `short`: these are not ranged
 * attacks, and a `short` reach is illegal from the rear line — which would leave
 * every rear-line unit unable to brace or recover.
 */
function universalAction(
    id: string,
    name: string,
    kind: CombatAction['kind'],
    description: string,
): CombatAction {
    return {
        id,
        kind,
        name,
        description,
        elementId: 'inanus',
        damageType: 'physical',
        range: 'medium',
        power: 0,
        accuracy: DEFAULT_ACCURACY,
        hitCount: 1,
        costs: { mana: 0, stamina: 0, hp: 0, cooldown: 0 },
        targeting: 'self',
        effects: [],
        damageVariance: null,
        dealsDamage: false,
        heals: false,
        ...defaultTraits(),
    };
}

/**
 * The movements every unit can always pick.
 *
 * Ids are stable (`defend`, `rest`, `inventory`) so the HUD can localise the
 * labels. Fleeing is deliberately not part of this list: only a unit that may
 * actually run carries it — the player, or an enemy whose `ai.flee` profile
 * authorises it (see {@link createFleeAction}).
 */
export function createUniversalActions(): CombatAction[] {
    return [
        universalAction(
            'defend',
            'Defend',
            'defend',
            'Reduce incoming damage and gain evasion until your next turn.',
        ),
        universalAction(
            'rest',
            'Rest',
            'rest',
            'Recover mana and stamina exponentially.',
        ),
        universalAction('inventory', 'Inventory', 'inventory', 'Open your backpack and use an item or switch weapons.'),
        universalAction('switch_line', 'Switch Line', 'switch_line', 'Move to the other battle line, if there is room.'),
    ];
}

/**
 * The panic escape offered to units that may flee.
 *
 * It is intentionally not universal: the unit factory only appends it for
 * player-controlled units and for enemies whose profile authors `ai.flee`. The
 * action itself is cheap; whether it is legal and how likely it is to work live
 * in `fleeRules`.
 */
export function createFleeAction(): CombatAction {
    return universalAction(
        'flee',
        'Flee',
        'flee',
        'Try to escape the fight. Only possible when badly wounded; the closer to death, the better the odds.',
    );
}
