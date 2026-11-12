/**
 * Status effects and effective statistics.
 *
 * Owns everything an effect does to a unit: applying a `buff`/`debuff`, the
 * flat `heal`/`damage`/`resource_regen`/`resource_drain` fields, and ticking
 * durations. {@link effectiveStats} folds live effects into a stat block so a
 * caller never has to remember which effects are active.
 */

import type { AttackEffect, AttackResourceAmounts } from '../../types/AttackDataType';
import type {
    CombatAction,
    CombatEffectInstance,
    CombatEffectPolarity,
    CombatEvent,
    CombatMoveSpec,
    CombatRandom,
    CombatResourceId,
    CombatRewindSpec,
    CombatState,
    CombatStatDelta,
    CombatStats,
    CombatUnit,
    CombatSide,
    DamageType,
} from '../../types/CombatType';
import {
    asRecord,
    clamp,
    readBoolean,
    readNumber,
    readStatDelta,
    readString,
    readVariance,
} from '../../utils/combatUtils';
import { DEFEND_EVASION_BONUS } from '../../constants/CombatConstants';
import { rollVariance } from './damageCalculator';

/**
 * Authored stat name (as written in YAML) to the runtime stat field(s).
 *
 * `attack`/`defense` cover both channels, so an authored status does not have to
 * know whether its owner fights physically or magically.
 */
const STAT_FIELDS: Record<string, Array<keyof CombatStats>> = {
    hp: ['maxHp'],
    mana: ['maxMana'],
    stamina: ['maxStamina'],
    max_hp: ['maxHp'],
    max_mana: ['maxMana'],
    max_stamina: ['maxStamina'],
    physical_attack: ['physicalAttack'],
    magical_attack: ['magicalAttack'],
    attack: ['physicalAttack', 'magicalAttack'],
    physical_defense: ['physicalDefense'],
    magical_defense: ['magicalDefense'],
    defense: ['physicalDefense', 'magicalDefense'],
    speed: ['speed'],
    /** Outgoing accuracy: how well the holder's own attacks land. */
    accuracy: ['accuracy'],
    /** Incoming evasion: how hard the holder is to hit. */
    evasion: ['evasion'],
    /** Outgoing critical chance. */
    crit_chance: ['critChance'],
};

/** The `effect_applied` member of {@link CombatEvent}. */
export type EffectAppliedEvent = Extract<CombatEvent, { type: 'effect_applied' }>;

/** The `effect_resisted` member of {@link CombatEvent}. */
export type EffectResistedEvent = Extract<CombatEvent, { type: 'effect_resisted' }>;

/** What applying one effect to one unit reports back. */
export type EffectOutcomeEvent = EffectAppliedEvent | EffectResistedEvent;

/** Adds a stat delta to a block, keeping every stat at or above zero. */
export function applyStatDelta(
    stats: CombatStats,
    delta: CombatStatDelta | null,
    sign: number,
): void {
    if (!delta) return;
    for (const [key, amount] of Object.entries(delta as Record<string, number>)) {
        for (const field of STAT_FIELDS[key] ?? []) {
            stats[field] = Math.max(0, stats[field] + sign * amount);
        }
    }
}

/** Scales a stat block by a multiplier delta, keeping every stat at or above zero. */
export function applyStatMultipliers(
    stats: CombatStats,
    multipliers: CombatStatDelta | null,
): void {
    if (!multipliers) return;
    for (const [key, factor] of Object.entries(multipliers as Record<string, number>)) {
        for (const field of STAT_FIELDS[key] ?? []) {
            stats[field] = Math.max(0, stats[field] * factor);
        }
    }
}

/** The runtime fields an authored stat name addresses. */
export function statFieldsFor(name: string): Array<keyof CombatStats> {
    return STAT_FIELDS[name] ?? [];
}

/**
 * Reads a named stat off a combatant, for the ability `stat` condition.
 *
 * `hp`/`mana`/`stamina` read the *current* pool — a condition asks "how much is
 * left", while a buff authored with the same name raises the *maximum*. A
 * multi-field name (`attack`) reports the average of its channels.
 */
export function readUnitStat(unit: CombatUnit, name: string): number | null {
    switch (name) {
        case 'hp':
            return unit.currentHp;
        case 'hp_percent': {
            const max = effectiveStats(unit).maxHp;
            return max > 0 ? unit.currentHp / max : 0;
        }
        case 'mana':
            return unit.currentMana;
        case 'stamina':
            return unit.currentStamina;
        default:
            break;
    }

    const fields = STAT_FIELDS[name];
    if (!fields || fields.length === 0) return null;

    const stats = effectiveStats(unit);
    const total = fields.reduce((sum, field) => sum + stats[field], 0);
    return total / fields.length;
}

/** Whether a named status (by id or by label) is live on the unit. */
export function hasStatusEffect(unit: CombatUnit, statusId: string): boolean {
    return unit.effects.some(
        (effect) => effect.effectId === statusId || effect.statusEffect === statusId,
    );
}

/** Whether the unit carries a status matching `wanted` by id or label (case-insensitive). */
export function carriesStatusNamed(unit: CombatUnit, wanted: string): boolean {
    const wantedKey = normalizeStatusKey(wanted);
    if (!wantedKey) return false;
    return unit.effects.some((effect) => (
        normalizeStatusKey(effect.statusEffect ?? '') === wantedKey
        || normalizeStatusKey(effect.effectId) === wantedKey
    ));
}

/** Normalises a status name for label matching (case-insensitive, trimmed). */
function normalizeStatusKey(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * The effectiveness multiplier a unit's statuses impose on incoming content
 * of `elementId` (`Wet` quarters ignis and doubles aqua/chaos on its bearer).
 *
 * Modulations compound multiplicatively when several overlap, and `null`/
 * unknown content reads as full strength.
 */
export function elementModulationFor(
    unit: CombatUnit | null | undefined,
    elementId: string | null | undefined,
): number {
    if (!unit || !elementId) return 1;
    const wanted = elementId.trim().toLowerCase();
    let modulation = 1;

    for (const effect of unit.effects) {
        if (!effect.elementModulation) continue;
        const factor = effect.elementModulation[wanted];
        if (typeof factor === 'number' && Number.isFinite(factor)) modulation *= factor;
    }

    return modulation;
}

/** Action kinds every live status currently forbids (`silenced` blocks attacks). */
export function preventedActionKinds(unit: CombatUnit): string[] {
    const kinds: string[] = [];
    for (const effect of unit.effects) {
        if (effect.preventActions) kinds.push(...effect.preventActions);
    }
    return kinds;
}

/** Damage channels every live status forbids the holder to use. */
export function preventedDamageChannels(unit: CombatUnit): DamageType[] {
    const channels: DamageType[] = [];
    for (const effect of unit.effects) {
        if (effect.preventDamageChannels) channels.push(...effect.preventDamageChannels);
    }
    return channels;
}

/**
 * Whether a prevented-kinds list forbids an action.
 *
 * The reference schema names the kinds it forbids and uses `attack` as the
 * umbrella for offensive actions, so a `silenced` status stops both skills and
 * weapons while an explicit kind (`rest`, `defend`) stops only itself.
 */
export function isActionPrevented(action: CombatAction, prevented: readonly string[]): boolean {
    if (prevented.length === 0) return false;
    if (prevented.includes(action.kind)) return true;

    const offensive = action.kind === 'skill' || action.kind === 'weapon';
    return offensive && prevented.includes('attack');
}

/** A unit's stats with its live buffs and debuffs folded in. */
export function effectiveStats(unit: CombatUnit): CombatStats {
    const stats: CombatStats = { ...unit.stats };
    // A `block_stat_buffs` status (permafrost) makes the holder immune to
    // gaining the named stats while it lives.
    const bannedBuffFields = new Set<keyof CombatStats>();
    for (const effect of unit.effects) {
        if (!effect.blockStatBuffs) continue;
        for (const name of effect.blockStatBuffs) {
            for (const field of STAT_FIELDS[name] ?? []) bannedBuffFields.add(field);
        }
    }

    for (const effect of unit.effects) {
        // Charge-stacked statuses scale their stat deltas by the charge count,
        // so three Freeze charges bite three times as deep. The sign is baked
        // into the delta: buffs add, debuffs subtract, both scaled × charges.
        const scale = Math.max(1, effect.stacks);
        for (const [key, amount] of signedStatEntries(effect.buff, 1)) {
            for (const field of STAT_FIELDS[key] ?? []) {
                if (bannedBuffFields.has(field)) continue;
                stats[field] = Math.max(0, stats[field] + amount * scale);
            }
        }
        for (const [key, amount] of signedStatEntries(effect.debuff, -1)) {
            for (const field of STAT_FIELDS[key] ?? []) {
                stats[field] = Math.max(0, stats[field] + amount * scale);
            }
        }
        applyStatMultipliers(stats, effect.statMultipliers);
    }
    // Bracing is a stance, not a status: fold its evasion here so previews and
    // real hits both see the same number.
    if (unit.defending) stats.evasion += DEFEND_EVASION_BONUS;
    return stats;
}

/** Iterates a stat delta as `[name, amount]` pairs with the sign pre-applied. */
function signedStatEntries(
    delta: CombatStatDelta | null,
    sign: number,
): Array<[string, number]> {
    if (!delta) return [];
    const entries: Array<[string, number]> = [];
    for (const [key, amount] of Object.entries(delta as Record<string, number>)) {
        if (typeof amount === 'number' && Number.isFinite(amount) && amount !== 0) {
            entries.push([key, sign * amount]);
        }
    }
    return entries;
}

/** Resolves an authored turn count; a `[min, max]` pair takes the longer side. */
function resolveTurns(raw: AttackEffect['turns']): number | null {
    if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(1, Math.round(raw));
    if (Array.isArray(raw) && raw.length >= 2) {
        const a = readNumber(raw[0], Number.NaN);
        const b = readNumber(raw[1], Number.NaN);
        if (Number.isFinite(a) && Number.isFinite(b)) return Math.max(1, Math.round(Math.max(a, b)));
    }
    return null;
}

/** Chance the effect lands; defaults to certain. */
function effectChance(effect: AttackEffect): number {
    const record = asRecord(effect) ?? {};
    const raw = readNumber(record.effect_hit_chance, Number.NaN);
    const fallback = readNumber(record.apply_chance, Number.NaN);
    const value = Number.isFinite(raw) ? raw : Number.isFinite(fallback) ? fallback : 1;
    if (value <= 0) return 0;
    return clamp(value <= 1 ? value : value / 100, 0, 1);
}

/** Action kinds an authored effect forbids (`prevent_actions`), or `null`.
 *
 * Effects authored on skills and weapons use the same field as abilities, so a
 * `Stun` written on a weapon blocks attacks exactly like one written in an
 * ability (`silenced`-style gating in `combatService.actionAvailability`).
 */
function readPreventActions(effect: AttackEffect): string[] | null {
    const raw = asRecord(effect)?.prevent_actions;
    if (!Array.isArray(raw)) return null;
    const kinds = raw
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
    return kinds.length > 0 ? kinds : null;
}

/** Scales every flat value of a stat delta (a weapon's output boost). */
export function scaleStatDelta(
    delta: CombatStatDelta | null,
    factor: number,
): CombatStatDelta | null {
    if (!delta || factor === 1) return delta;
    const scaled: Record<string, number> = {};
    for (const [key, value] of Object.entries(delta as Record<string, number>)) {
        scaled[key] = Math.round(value * factor * 10) / 10;
    }
    return scaled as CombatStatDelta;
}

/**
 * Reads a `move` effect's instruction.
 *
 * `who` says whether the caster or the target steps across, and `to_line`
 * where they land (`other` means "the line they are not in").
 */
export function readMoveSpec(effect: AttackEffect): CombatMoveSpec | null {
    const spec = asRecord(asRecord(effect)?.move);
    if (!spec) return null;

    const who = readString(spec.who, 'target');
    const toLine = readString(spec.to_line, 'other');

    return {
        who: who === 'self' ? 'self' : 'target',
        toLine: toLine === 'front' || toLine === 'rear' ? toLine : 'other',
        swapWithCaster: readBoolean(spec.swap_with_caster, false),
    };
}

/**
 * Reads a `rewind` effect's instruction.
 *
 * `turns` says how far back to go; left out, the rewind goes all the way to
 * the start of the fight. `resources` says which pools go back; left out,
 * every pool does.
 */
export function readRewindSpec(effect: AttackEffect): CombatRewindSpec | null {
    const spec = asRecord(asRecord(effect)?.rewind);
    if (!spec) return null;

    const turns = readNumber(spec.turns, Number.NaN);
    const resources = Array.isArray(spec.resources)
        ? spec.resources.filter((entry): entry is 'hp' | 'mana' | 'stamina' =>
            entry === 'hp' || entry === 'mana' || entry === 'stamina')
        : [];

    return {
        // `0` — like an absent field — means "all the way back".
        turns: Number.isFinite(turns) ? (turns <= 0 ? null : Math.round(turns)) : null,
        resources,
        cleanse: readBoolean(spec.cleanse, true),
    };
}

/**
 * Reads an effect's `on_miss_move` clause: a move the holder fires by itself
 * when an attack misses them (`Zephyr Veil`). `break_after` drops the status
 * after the move fires, and defaults to `true`.
 */
export function readOnMissMove(
    effect: AttackEffect,
): (CombatMoveSpec & { breakAfter?: boolean }) | null {
    const spec = asRecord(asRecord(effect)?.on_miss_move);
    if (!spec) return null;

    const who = readString(spec.who, 'self');
    const toLine = readString(spec.to_line, 'other');

    return {
        who: who === 'target' ? 'target' : 'self',
        toLine: toLine === 'front' || toLine === 'rear' ? toLine : 'other',
        swapWithCaster: readBoolean(spec.swap_with_caster, false),
        breakAfter: readBoolean(spec.break_after, true),
    };
}

/** Reads the authored `expires` boundary; absent or unknown counts `turns` normally. */
export function readExpiresMode(effect: AttackEffect): 'turn_start' | 'turn_end' | 'round_end' | null {
    const mode = readString(asRecord(effect)?.expires, '');
    return mode === 'turn_start' || mode === 'turn_end' || mode === 'round_end' ? mode : null;
}

/**
 * How an effect reads to a cleanse or a dispel.
 *
 * The authored `polarity` wins; otherwise a debuff or a damage-over-time is a
 * curse, a buff is a gift, and a pure control status is neither.
 */
export function readPolarity(effect: AttackEffect, instance: {
    buff: CombatStatDelta | null;
    debuff: CombatStatDelta | null;
    damagePerTurn: number;
}): CombatEffectPolarity {
    const authored = readString(asRecord(effect)?.polarity, '');
    if (authored === 'positive' || authored === 'negative' || authored === 'neutral') {
        return authored;
    }

    if (instance.debuff || instance.damagePerTurn > 0) return 'negative';
    if (instance.buff) return 'positive';
    return 'neutral';
}

/** Stats a `random_debuff`/`random_buff` may pick; resource pools would read as unplayable. */
const RANDOM_DEBUFF_STATS = [
    'physical_attack', 'magical_attack', 'physical_defense', 'magical_defense',
    'speed', 'accuracy', 'evasion', 'crit_chance',
] as const;

/** Picks `count` distinct stats and turns them into a stat delta. */
function readRandomStats(
    source: Record<string, unknown>,
    field: 'random_debuff' | 'random_buff',
    magnitude: number,
    random: CombatRandom,
): CombatStatDelta | null {
    const spec = asRecord(source[field]);
    if (!spec) return null;

    const amount = readNumber(spec.amount, 0);
    if (amount === 0) return null;

    const authored = Array.isArray(spec.stats)
        ? spec.stats.filter((entry): entry is string => typeof entry === 'string')
        : [];
    const pool = authored.length > 0 ? [...authored] : [...RANDOM_DEBUFF_STATS];

    // Fisher–Yates: every stat is equally likely and none is rolled twice.
    for (let index = pool.length - 1; index > 0; index -= 1) {
        const swap = Math.min(index, Math.floor(random() * (index + 1)));
        const held = pool[index];
        pool[index] = pool[swap];
        pool[swap] = held;
    }

    const count = Math.min(pool.length, Math.max(1, Math.round(readNumber(spec.count, 1))));
    const delta: Record<string, number> = {};
    for (const stat of pool.slice(0, count)) delta[stat] = amount;

    return scaleStatDelta(delta as CombatStatDelta, magnitude);
}

/** Picks `count` distinct stats and turns them into a negative delta. */


/** Adds two stat deltas, keeping both contributions. */
function mergeDeltas(
    first: CombatStatDelta | null,
    second: CombatStatDelta | null,
): CombatStatDelta | null {
    if (!first) return second;
    if (!second) return first;

    const merged: Record<string, number> = { ...first as Record<string, number> };
    for (const [key, value] of Object.entries(second as Record<string, number>)) {
        merged[key] = (merged[key] ?? 0) + value;
    }
    return merged as CombatStatDelta;
}

/** Reads an effect's `bonus_vs_hp_below` spec. */
function readBonusVsHpBelow(source: unknown): { threshold: number; multiplier: number } | null {
    const record = asRecord(source);
    if (!record) return null;

    const threshold = readNumber(record.threshold, Number.NaN);
    const multiplier = readNumber(record.multiplier, Number.NaN);
    if (!Number.isFinite(threshold) || !Number.isFinite(multiplier)) return null;

    return { threshold, multiplier };
}

/** Reads the on-kill healing a status grants its holder. */
function readHealOnKill(source: Record<string, unknown>): { flat: number; percent: number } | null {
    const flat = Math.max(0, readNumber(source.heal_on_kill, 0));
    const percent = clamp(readNumber(source.heal_on_kill_percent, 0), 0, 1);
    return flat > 0 || percent > 0 ? { flat, percent } : null;
}

/** Reads the damage channels a status shields its holder from. */
function readDamageImmunities(source: Record<string, unknown>): DamageType[] | null {
    const raw = Array.isArray(source.damage_immunities) ? source.damage_immunities : [];
    const channels = raw.filter((entry): entry is DamageType => entry === 'physical' || entry === 'magical');
    return channels.length > 0 ? channels : null;
}

/** Reads the damage channels a status forbids its holder to use. */
function readDamageChannels(source: unknown): DamageType[] | null {
    if (!Array.isArray(source)) return null;
    const channels = source.filter((entry): entry is DamageType => entry === 'physical' || entry === 'magical');
    return channels.length > 0 ? channels : null;
}

/** Reads a flat `element_id → multiplier` record (`element_modulation`). */
export function readNumberRecord(source: unknown): Record<string, number> | null {
    const record = asRecord(source);
    if (!record) return null;

    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(record)) {
        const amount = readNumber(value, Number.NaN);
        if (Number.isFinite(amount) && amount !== 0) result[key.trim()] = amount;
    }
    return Object.keys(result).length > 0 ? result : null;
}

/** Reads a trimmed string list; empty lists collapse to `null`. */
function readTrimmedStringList(source: unknown): string[] | null {
    if (!Array.isArray(source)) return null;
    const values = source
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
    return values.length > 0 ? values : null;
}

/** Reads a status landing `shield` spec (`condensation` pools, `ice_shield` guards). */
function readShieldSpec(source: unknown): {
    percentOfMaxHp: number;
    hitChance: number;
    maxHits: number;
    guarded: boolean;
} {
    const record = asRecord(source);
    if (!record) return { percentOfMaxHp: 0, hitChance: 1, maxHits: 1, guarded: false };

    const guarded = record.hit_chance !== undefined || record.max_hits !== undefined;

    return {
        percentOfMaxHp: Math.min(100, Math.max(0, readNumber(record.percent_of_max_hp, 0))),
        // Omitted or 0-authored both read as an always-soaking barrier.
        hitChance: clamp(readNumber(record.hit_chance, 1), 0, 1),
        maxHits: Math.max(1, Math.round(readNumber(record.max_hits, 1))),
        guarded,
    };
}

/**
 * Reads a `resource_transfer` clause (the Vis recall family): a fixed amount
 * the caster pays out of their own pool for the holder to receive.
 */
export function readResourceTransferSpec(source: unknown): {
    resource: CombatResourceId;
    amount: number;
} | null {
    const record = asRecord(source);
    if (!record) return null;

    const resource = readString(record.resource, '');
    if (resource !== 'hp' && resource !== 'mana' && resource !== 'stamina') return null;

    const amount = Math.round(readNumber(record.amount, 0));
    return amount > 0 ? { resource, amount } : null;
}

/** Reads a `charges` spec: the stacking threshold and what a full stack releases. */
function readChargesSpec(source: unknown): {
    max: number;
    initial: number;
    release: CombatEffectInstance['chargeRelease'];
} | null {
    const record = asRecord(source);
    if (!record) return null;

    const max = Math.max(1, Math.round(readNumber(record.max, 3)));
    const releaseRecord = asRecord(record.release);
    const release = releaseRecord ? {
        statusEffect: readString(releaseRecord.status_effect, 'Frozen'),
        turns: Math.max(1, Math.round(readNumber(releaseRecord.turns, 1))),
        effectId: `${readString(releaseRecord.status_effect, 'frozen').trim().toLowerCase()}_frozen_release`,
        preventActions: readTrimmedStringList(releaseRecord.prevent_actions),
        debuff: (readStatDelta(releaseRecord.debuff) ?? null) as CombatStatDelta | null,
    } : null;

    return {
        max,
        initial: clamp(readNumber(record.initial, 1), 1, max),
        release,
    };
}

/** Reads a `trip_on_action` field-trap spec (`thin_ice`). */
function readTripOnAction(
    source: unknown,
): CombatEffectInstance['tripOnAction'] {
    const record = asRecord(source);
    if (!record) return null;

    const actions = readTrimmedStringList(record.actions);
    if (!actions) return null;

    const spawnRecord = asRecord(record.spawn);
    const spawn = spawnRecord ? {
        statusEffect: readString(spawnRecord.status_effect, 'Slipped'),
        effectId: `${readString(spawnRecord.status_effect, 'slipped').trim().toLowerCase()}_slip`,
        turns: Math.max(1, Math.round(readNumber(spawnRecord.turns, 1))),
        debuff: (readStatDelta(spawnRecord.debuff) ?? null) as CombatStatDelta | null,
        preventActions: readTrimmedStringList(spawnRecord.prevent_actions),
        stacking: readBoolean(spawnRecord.stacking, false)
            ? { initial: 1, extendTurns: 1 }
            : null,
        canStack: readBoolean(spawnRecord.can_stack, false),
    } : null;

    return {
        actions,
        damageTypes: readTrimmedStringList(record.damage_types),
        chance: clamp(readNumber(record.chance, 0.5), 0, 1),
        damage: Math.max(0, readNumber(record.damage, 0)),
        spawn,
        maxTriggers: readOptionalPositive(record.max_triggers),
        triggers: 0,
        expireDamage: Math.max(0, readNumber(record.expire_damage, 0)),
    };
}

/** Reads an optional positive integer, returning `null` when absent or zero. */
function readOptionalPositive(source: unknown): number | null {
    const value = Math.round(readNumber(source, 0));
    return value > 0 ? value : null;
}

/** Reads a `detonate_on_turn` mark (`flicker_mark`, `time_bomb`). */
function readDetonateOnTurn(
    source: unknown,
): CombatEffectInstance['detonateOnTurn'] {
    const record = asRecord(source);
    if (!record) return null;

    const power = Math.max(0, readNumber(record.power, 0));
    if (power <= 0) return null;

    const maxPower = readNumber(record.max_power, 0);
    const includeLine = readBoolean(record.include_line, false);
    return {
        power,
        scalePerTurn: Math.max(0, readNumber(record.scale_per_turn, 0)),
        // No authored cap means the mark can keep growing with time.
        maxPower: maxPower > 0 ? Math.max(power, maxPower) : Number.POSITIVE_INFINITY,
        includeLine,
        splashChance: clamp(readNumber(record.splash_chance, includeLine ? 1 : 0), 0, 1),
        turnSkipChance: clamp(readNumber(record.turn_skip_chance, 0), 0, 1),
    };
}

/** Reads a `chain_detonation` mark (`detonate`). */
function readChainDetonation(
    source: unknown,
): CombatEffectInstance['chainDetonation'] {
    const record = asRecord(source);
    if (!record) return null;

    const power = Math.max(0, readNumber(record.power, 0));
    if (power <= 0) return null;

    return {
        power,
        recoilPerTarget: Math.max(0, readNumber(record.recoil_per_target, 0)),
    };
}

/** Reads a `conductor` status (`static_field`, `conductive_skin`). */
function readConductor(source: unknown): CombatEffectInstance['conductor'] {
    const record = asRecord(source);
    if (!record) return null;

    const jumpPower = Math.max(0, readNumber(record.jump_power, 0));
    if (jumpPower <= 0) return null;

    return {
        jumpPower,
        groundedByElements: readTrimmedStringList(record.grounded_by_elements),
        groundShieldPercent: Math.max(0, readNumber(record.ground_shield_percent, 0)),
    };
}

/** Reads an `interrupt` status (`shock`). */
function readInterrupt(source: unknown): CombatEffectInstance['interrupt'] {
    const record = asRecord(source);
    if (!record) return null;

    const chance = clamp(readNumber(record.chance, 0), 0, 1);
    if (chance <= 0) return null;

    return {
        chance,
        actions: readTrimmedStringList(record.actions),
    };
}

/** Reads a flat `reflect` status (`recoil_guard`, `static_field`). */
function readReflect(source: unknown): CombatEffectInstance['reflect'] {
    const record = asRecord(source);
    if (!record) return null;

    const power = Math.max(0, readNumber(record.power, 0));
    const percentOfDamage = clamp(readNumber(record.percent_of_damage, 0), 0, 1);
    if (power <= 0 && percentOfDamage <= 0) return null;

    return {
        power,
        chance: clamp(readNumber(record.chance, 1), 0, 1),
        consume: readBoolean(record.consume, true),
        charges: readOptionalPositive(record.charges) ?? undefined,
        damageTypes: (readTrimmedStringList(record.damage_types) as DamageType[] | null) ?? null,
        percentOfDamage,
        exceptElements: readTrimmedStringList(record.except_elements),
        exceptionMultiplier: Math.max(1, readNumber(record.exception_multiplier, 1)),
        exceptionBreaks: readBoolean(record.exception_breaks, false),
    };
}

/** Reads a `spend_steal` status (`numbing_current`, `capacitor`). */
function readSpendSteal(source: unknown): CombatEffectInstance['spendSteal'] {
    const record = asRecord(source);
    if (!record) return null;

    const resource = readString(record.resource, 'mana') === 'stamina' ? 'stamina' : 'mana';
    const percent = clamp(readNumber(record.percent, 0), 0, 1);
    const amount = Math.max(0, readNumber(record.amount, 0));
    const max = Math.max(0, readNumber(record.max, 0));
    if (percent <= 0 && amount <= 0) return null;

    return { resource, percent, amount, max };
}

/** Reads a one-shot dodge-and-riposte status (`counter_stance`). */
function readEvadeNext(source: unknown): CombatEffectInstance['evadeNext'] {
    const record = asRecord(source);
    if (!record) return null;
    const power = Math.max(0, readNumber(record.power, 0));
    const chance = clamp(readNumber(record.chance, 1), 0, 1);
    if (power <= 0 && chance <= 0) return null;
    return {
        damageTypes: (readTrimmedStringList(record.damage_types) as DamageType[] | null) ?? null,
        power,
        chance,
        directOnly: readBoolean(record.direct_only, false),
        returnToFreeLane: readBoolean(record.return_to_free_lane, false),
    };
}

/** Reads a damage-redirection status (`bulwark`). */
function readDamageRedirect(source: unknown): CombatEffectInstance['damageRedirect'] {
    const record = asRecord(source);
    if (!record) return null;
    const scope = readString(record.scope, 'allies_all') === 'allies_lane' ? 'allies_lane' : 'allies_all';
    return { scope };
}

/** Reads a status that discounts its bearer's own action costs (`adrenaline`). */
function readCostMultiplier(source: unknown): CombatEffectInstance['costMultiplier'] {
    const record = asRecord(source);
    if (!record) return null;
    const mana = readNumber(record.mana, 1);
    const stamina = readNumber(record.stamina, 1);
    if (mana === 1 && stamina === 1) return null;
    return {
        mana: clamp(mana, 0, 1),
        stamina: clamp(stamina, 0, 1),
    };
}

/** Reads a price paid when the status ends (`adrenaline`). */
function readEndCost(source: unknown): CombatEffectInstance['endCost'] {
    const record = asRecord(source);
    if (!record) return null;
    const percentOfMax = Math.max(0, readNumber(record.percent_of_max, 0));
    if (percentOfMax <= 0) return null;
    return {
        resource: readString(record.resource, 'stamina') === 'mana' ? 'mana' : 'stamina',
        percentOfMax,
        shortfall: 'hp',
    };
}

/** Reads a direct-damage retaliation fired when the bearer falls (`last_stand`). */
function readOnDeathBlast(source: unknown): CombatEffectInstance['onDeathBlast'] {
    const record = asRecord(source);
    if (!record) return null;
    const power = Math.max(0, readNumber(record.power, 0));
    return power > 0 ? { power } : null;
}

/** Reads a rescue-rune payload (`rune_of_survival`, `rune_of_endurance`). */
function readRescueRune(source: unknown): CombatEffectInstance['rescueRune'] {
    const record = asRecord(source);
    if (!record) return null;
    return {
        hpPercent: 1,
        manaPercent: clamp(readNumber(record.mana_percent, 8), 0, 100),
        staminaPercent: clamp(readNumber(record.stamina_percent, 8), 0, 100),
    };
}

/** Reads a rune-store payload (`rune_of_memory`, restoration, strength, fate burst). */
function readRuneStore(source: unknown): CombatEffectInstance['runeStore'] {
    const record = asRecord(source);
    if (!record) return null;
    const mode = readString(record.mode, 'memory') === 'convert' ? 'convert' : 'memory';
    return {
        mode,
        capPercent: clamp(readNumber(record.cap_percent, 10), 0, 100),
        conversionPercent: Math.max(0, readNumber(record.conversion_percent, mode === 'convert' ? 100 : 0)),
        outputCapPercent: readBoolean(record.heal_or_damage, true) && record.output_cap_percent !== undefined
            ? clamp(readNumber(record.output_cap_percent, 20), 0, 100)
            : null,
        healOrDamage: readBoolean(record.heal_or_damage, true),
        stored: 0,
    };
}

/** Reads a rune-return payload (`rune_of_return`, retribution, fate reversal). */
function readRuneReturn(source: unknown): CombatEffectInstance['runeReturn'] {
    const record = asRecord(source);
    if (!record) return null;
    return {
        percent: Math.max(1, readNumber(record.percent, 100)),
        payment: {
            mana: Math.max(0, readNumber(record.mana_payment, 0)),
            stamina: Math.max(0, readNumber(record.stamina_payment, 0)),
        },
        stored: 0,
        storedKind: null,
        storedSourceId: null,
        storedElement: null,
        storedEffect: null,
    };
}

/** Reads a chant payload (`chant_of_echoes` and its branch). */
function readChant(source: unknown, random: CombatRandom): CombatEffectInstance['chant'] {
    const record = asRecord(source);
    if (!record) return null;
    const elementMode = readString(record.element_mode, 'fixed') === 'random' ? 'random' : 'fixed';
    const randomElements = readTrimmedStringList(record.random_elements) ?? ['aqua', 'ignis', 'florere'];
    const chosen = elementMode === 'random' && randomElements.length > 0
        ? randomElements[Math.min(randomElements.length - 1, Math.floor(random() * randomElements.length))]
        : null;
    return {
        maxCharges: Math.max(1, Math.round(readNumber(record.max_charges, 1))),
        damagePerCharge: Math.max(0, readNumber(record.damage_per_charge, 6)),
        elementMode,
        randomElements,
        interruptChance: clamp(readNumber(record.interrupt_chance, 0), 0, 1),
        payHp: Math.max(0, readNumber(record.pay_hp, 0)),
        payMana: Math.max(0, readNumber(record.pay_mana, 0)),
        scope: readString(record.scope, 'one') === 'lane'
            ? 'lane'
            : readString(record.scope, 'one') === 'all' ? 'all' : 'one',
        charges: 1,
        targetId: null,
        element: chosen,
    };
}

/** Reads a fate link; a bare `true` links to whoever applied it. */
function readFateLink(source: unknown, sourceId: string): CombatEffectInstance['fateLink'] {
    if (!source) return null;
    const record = asRecord(source);
    return { casterId: readString(record?.caster_id, sourceId) };
}

/** Reads the chance a mud seal refuses any new status. */
function readStatusResistChance(source: unknown): number | undefined {
    const value = clamp(readNumber(source, 0), 0, 1);
    return value > 0 ? value : undefined;
}

/** Reads an incoming buff/debuff magnitude multiplier (`erosion`). */
function readEffectMagnitudeMultiplier(source: unknown): number | undefined {
    const value = readNumber(source, 1);
    return Number.isFinite(value) && value >= 0 && value !== 1 ? value : undefined;
}

/** Reads a reach-band prevention list. */
function readRangeList(source: unknown): Array<'short' | 'medium' | 'long'> | undefined {
    if (!Array.isArray(source)) return undefined;
    const ranges = source.filter((entry): entry is 'short' | 'medium' | 'long' =>
        entry === 'short' || entry === 'medium' || entry === 'long');
    return ranges.length > 0 ? ranges : undefined;
}

/** Reads a wall break clause (`stone_wall`, `crystal_aegis`). */
function readBarrier(source: unknown): CombatEffectInstance['barrier'] {
    const record = asRecord(source);
    if (!record) return null;
    const breakOnCrit = readBoolean(record.break_on_crit, false);
    const breakOnSuperEffective = readBoolean(record.break_on_super_effective, false);
    return breakOnCrit || breakOnSuperEffective
        ? { breakOnCrit, breakOnSuperEffective }
        : null;
}

/** Reads an intercept shield (`clay_doll`, `clay_sentinel`). */
function readIntercept(source: unknown): CombatEffectInstance['intercept'] {
    const record = asRecord(source);
    if (!record) return null;
    return {
        hits: Math.max(1, Math.round(readNumber(record.hits, 1))),
        breakChance: clamp(readNumber(record.break_chance, 0), 0, 1),
    };
}

/** Reads a shatter-into-bleed clause (`crystalize`). */
function readShatterOnDamageType(
    source: unknown,
): CombatEffectInstance['shatterOnDamageType'] {
    const record = asRecord(source);
    if (!record) return null;
    const damageType = readString(record.damage_type, '') === 'magical' ? 'magical' : 'physical';
    const statusEffect = readString(record.status_effect, 'Bleeding') || 'Bleeding';
    return {
        damageType,
        statusEffect,
        turns: Math.max(1, Math.round(readNumber(record.turns, 3))),
        damagePerTurn: Math.max(0, readNumber(record.damage_per_turn, 7)),
    };
}

/** Reads the fossilization payload of a petrify-class status (`fossil`). */
function readFossilizeOnExpiry(
    source: unknown,
): CombatEffectInstance['fossilizeOnExpiry'] {
    const record = asRecord(source);
    if (!record) return null;
    return {
        statusEffect: readString(record.status_effect, 'Fossil') || 'Fossil',
        turns: Math.max(1, Math.round(readNumber(record.turns, 3))),
        debuff: (readStatDelta(record.debuff) ?? null) as CombatStatDelta | null,
        critDamageTaken: Math.max(0, readNumber(record.crit_damage_taken, 0)),
        preventActions: readTrimmedStringList(record.prevent_actions),
        preventRanges: readRangeList(record.prevent_ranges) ?? null,
        preventElements: readTrimmedStringList(record.prevent_elements),
        breakPower: Math.max(0, readNumber(record.break_power, 0)),
    };
}

/** Reads flat damage paid when a status expires (`fossil`). */
function readOnExpiryDamage(source: unknown): CombatEffectInstance['onExpiryDamage'] {
    const record = asRecord(source);
    if (!record) return null;
    const power = Math.max(0, readNumber(record.power, 0));
    if (power <= 0) return null;
    return { power, scope: readString(record.scope, 'self') === 'all' ? 'all' : 'self' };
}

/** Reads the merge behaviour of a stack status (`burn`, `overheat`, `fuel`). */
function readStacking(source: unknown): { merge: boolean; extend: number; initial: number } {
    const record = asRecord(source);
    if (!record) return { merge: false, extend: 0, initial: 1 };
    return {
        merge: true,
        extend: Math.max(0, Math.round(readNumber(record.extend_turns, 1))),
        initial: Math.max(1, Math.round(readNumber(record.initial, 1))),
    };
}

/** Reads a burst threshold/payload (`overheat`). */
function readBurst(source: unknown): CombatEffectInstance['burst'] {
    const record = asRecord(source);
    if (!record) return null;
    return {
        damage: Math.max(0, readNumber(record.damage, 0)),
        burnStacks: Math.max(0, Math.round(readNumber(record.burn_stacks, 0))),
        burnTurns: Math.max(0, Math.round(readNumber(record.burn_turns, 0))),
        pdefPercent: Math.max(0, readNumber(record.pdef_percent, 0)),
        turns: Math.max(0, Math.round(readNumber(record.turns, 0))),
    };
}

/** Reads a fire-wall protection spec. */
function readFireWall(source: unknown): CombatEffectInstance['fireWall'] {
    const record = asRecord(source);
    if (!record) return null;
    return {
        rangedWeapon: clamp(readNumber(record.ranged_weapon, 1), 0, 1),
        projectile: clamp(readNumber(record.projectile, 1), 0, 1),
        physical: clamp(readNumber(record.physical, 1), 0, 1),
        erodeElements: readTrimmedStringList(record.erode_elements),
        noErode: readBoolean(record.no_erode, false),
    };
}

/** Reads an on-hit ignition rider (`fuel`). */
function readIgniteOnHit(source: unknown): CombatEffectInstance['igniteOnHit'] {
    const record = asRecord(source);
    if (!record) return null;
    const elements = readTrimmedStringList(record.elements);
    if (!elements?.length) return null;
    return {
        elements,
        burnStacks: Math.max(0, Math.round(readNumber(record.burn_stacks, 1))),
        burnTurns: Math.max(0, Math.round(readNumber(record.burn_turns, 3))),
    };
}

/** Reads a reactive melee ignition (`furnace_ward`). */
function readIgniteAttackerOnHit(source: unknown): CombatEffectInstance['igniteAttackerOnHit'] {
    const record = asRecord(source);
    if (!record) return null;
    return {
        damageTypes: readTrimmedStringList(record.damage_types),
        chance: clamp(readNumber(record.chance, 0.4), 0, 1),
        burnStacks: Math.max(0, Math.round(readNumber(record.burn_stacks, 1))),
        burnTurns: Math.max(0, Math.round(readNumber(record.burn_turns, 2))),
    };
}

/** Reads the plant-side regen modifiers (`mending_bloom`, `deep_rooted_remedy`). */
function readRegenBonuses(record: Record<string, unknown>): {
    perNegative: number;
    perDotPercent: number;
} {
    return {
        perNegative: Math.max(0, readNumber(record.regen_bonus_per_negative, 0)),
        perDotPercent: Math.max(0, readNumber(record.regen_bonus_per_dot_percent, 0)),
    };
}

/** Reads a refund of resources spent while the status lives (`greenfire`). */
function readRefundSpent(source: unknown): CombatEffectInstance['refundSpent'] {
    const record = asRecord(source);
    if (!record) return null;
    const percent = clamp(readNumber(record.percent, 0), 0, 1);
    if (percent <= 0) return null;
    const resources = readTrimmedStringList(record.resources)
        ?.filter((entry) => entry === 'mana' || entry === 'stamina') ?? ['mana', 'stamina'];
    return {
        percent,
        resources,
        // The baseline is stamped from the unit when the status lands.
        baseline: { mana: 0, stamina: 0 },
    };
}

/** Reads a cleanse triggered by receiving a heal of an element (`flore`). */
function readCleanseOnHeal(source: unknown): CombatEffectInstance['cleanseOnHeal'] {
    const record = asRecord(source);
    if (!record) return null;
    const element = readString(record.element, 'florere').trim() || 'florere';
    return {
        count: Math.max(1, Math.round(readNumber(record.count, 1))),
        element,
        maxTriggers: Math.max(1, Math.round(readNumber(record.max_triggers, 3))),
        triggers: 0,
    };
}

/** Reads a charged damage reduction (`pollen_ward`). */
function readDamageReduction(source: unknown): CombatEffectInstance['damageReduction'] {
    const record = asRecord(source);
    if (!record) return null;
    const percent = clamp(readNumber(record.percent, 0), 0, 1);
    if (percent <= 0) return null;
    return {
        percent,
        charges: Math.max(1, Math.round(readNumber(record.charges, 1))),
        healAdjacentPercent: Math.max(0, readNumber(record.heal_adjacent_percent, 0)),
    };
}

/** Reads a percent-of-max drain (`life_drain`, `mana_drain`). */
function readDrainPercentOfMaxHp(source: unknown): CombatEffectInstance['drainPercentOfMaxHp'] {
    const record = asRecord(source);
    if (!record) return null;
    const percent = Math.max(0, readNumber(record.percent, 0));
    if (percent <= 0) return null;
    return {
        percent,
        resource: readString(record.resource, 'hp') === 'mana' ? 'mana' : 'hp',
        to: 'caster',
    };
}

/** Reads a per-turn percent drain (`blood_seed`, `mana_seed`). */
function readDrainPerTurn(source: unknown): CombatEffectInstance['drainPerTurn'] {
    const record = asRecord(source);
    if (!record) return null;
    const percentOfMax = Math.max(0, readNumber(record.percent_of_max, 0));
    if (percentOfMax <= 0) return null;
    return {
        resource: readString(record.resource, 'hp') === 'mana' ? 'mana' : 'hp',
        percentOfMax,
        chance: clamp(readNumber(record.chance, 1), 0, 1),
        healToSource: readBoolean(record.heal_to_source, false),
    };
}

/** Reads a `cleanse_per_turn` spec (`rain`); `polarity` defaults to negatives. */
function readCleansePerTurn(
    source: unknown,
): { count: number; polarity: CombatEffectPolarity | 'any' } | null {
    const record = asRecord(source);
    if (!record) return null;

    const count = Math.max(1, Math.round(readNumber(record.count, 1)));
    const polarity = readString(record.polarity, 'negative');
    const normalized = polarity === 'positive' || polarity === 'any' ? polarity : 'negative';
    return { count, polarity: normalized as CombatEffectPolarity | 'any' };
}

/** Reads a `spend_trigger` spec (`hangover` pays the spender, feeds the caster). */
function readSpendTrigger(source: unknown): CombatEffectInstance['spendTrigger'] {
    const record = asRecord(source);
    if (!record) return null;

    const damage = Math.max(0, Math.round(readNumber(record.damage, 0)));
    const healToSource = Math.max(0, Math.round(readNumber(record.heal_to_source, 0)));
    return damage > 0 || healToSource > 0 ? { damage, healToSource } : null;
}

/**
 * Reads a `upgrade_vs_status` landing upgrade: numbers that only apply when the
 * target already carries a matching status (`condensation` under `mist`).
 */
function readUpgradeVsStatus(
    source: unknown,
): {
    status: string;
    extraTurns: number;
    extraTurnsChance: number;
    extraHealPercentOfMax: number;
    extraRegenPercent: AttackResourceAmounts | null;
} | null {
    const record = asRecord(source);
    const status = readString(record?.status, '').trim();
    if (!status) return null;

    const extraRegenPercent = asRecord(record?.extra_regen_per_turn_percent)
        ? readNumberRecord(record?.extra_regen_per_turn_percent)
        : null;

    return {
        status,
        extraTurns: Math.max(0, Math.round(readNumber(record?.extra_turns, 0))),
        extraTurnsChance: clamp(readNumber(record?.extra_turns_chance, 1), 0, 1),
        extraHealPercentOfMax: Math.max(0, readNumber(record?.extra_heal_percent_of_max, 0)),
        extraRegenPercent,
    };
}

/** Reads a per-turn rewind clause (`rewind_each_turn`). */
function readRewindEachTurn(source: unknown): CombatEffectInstance['rewindEachTurn'] {
    const record = asRecord(source);
    if (!record) return null;
    const turns = readNumber(record.turns, Number.NaN);
    const resources = Array.isArray(record.resources)
        ? record.resources.filter((entry): entry is 'hp' | 'mana' | 'stamina' =>
            entry === 'hp' || entry === 'mana' || entry === 'stamina')
        : [];
    return {
        turns: Number.isFinite(turns) ? (turns <= 0 ? null : Math.round(turns)) : null,
        resources,
        cleanse: readBoolean(record.cleanse, true),
    };
}

/** Reads the duration shift a landing imposes on other statuses. */
function readShiftOtherEffects(source: unknown): CombatEffectInstance['shiftOtherEffects'] {
    const record = asRecord(source);
    if (!record) return null;
    const turns = Math.max(0, Math.round(readNumber(record.turns, 0)));
    if (turns <= 0) return null;
    const direction = readString(record.direction, 'shorten') === 'extend' ? 'extend' : 'shorten';
    const polarityRaw = readString(record.polarity, 'any');
    const polarity = polarityRaw === 'positive' || polarityRaw === 'negative' ? polarityRaw : 'any';
    return { turns, direction, polarity };
}

/** Reads a time-suspension clause (`stasis`, `time_lock`). */
function readSuspend(source: unknown): CombatEffectInstance['suspend'] {
    const record = asRecord(source);
    if (!record) return null;
    return {
        invulnerable: readBoolean(record.invulnerable, false),
        deferDamage: readBoolean(record.defer_damage, false),
        deferStatuses: readBoolean(record.defer_statuses, false),
        freezeCooldowns: readBoolean(record.freeze_cooldowns, true),
        freezeEffects: readBoolean(record.freeze_effects, true),
        deferredDamage: 0,
        deferredStatuses: [],
    };
}

/** Reads a delayed echo clause. */
function readEchoMark(source: unknown): CombatEffectInstance['echoMark'] {
    const record = asRecord(source);
    if (!record) return null;
    const percent = Math.max(0, readNumber(record.percent, 0));
    if (percent <= 0) return null;
    const resolveRaw = readString(record.resolve, 'turn_end');
    const resolve = resolveRaw === 'caster_next_turn' || resolveRaw === 'deferred'
        ? resolveRaw
        : 'turn_end';
    const maxPercent = readNumber(record.max_percent, Number.NaN);
    const cap = readNumber(record.cap, Number.NaN);
    return {
        percent,
        maxPercent: Number.isFinite(maxPercent) ? maxPercent : null,
        addPercentPerHit: Math.max(0, readNumber(record.add_percent_per_hit, 0)),
        resolve,
        delayTurns: Math.max(0, Math.round(readNumber(record.delay_turns, 0))),
        deferStatuses: readBoolean(record.defer_statuses, false),
        canCrit: readBoolean(record.can_crit, false),
        cap: Number.isFinite(cap) ? cap : null,
        pending: 0,
        currentPercent: percent,
        recorded: 0,
        readyTurn: null,
    };
}

/** Reads a next-action bonus. */
function readNextActionBonus(source: unknown): CombatEffectInstance['nextActionBonus'] {
    const record = asRecord(source);
    if (!record) return null;
    return {
        element: readString(record.element, '') || null,
        accuracy: Math.max(0, readNumber(record.accuracy, 0)),
        cooldown: Math.max(0, Math.round(readNumber(record.cooldown, 0))),
        charges: Math.max(1, Math.round(readNumber(record.charges, 1))),
    };
}

/** Reads a gravity-zone status. */
function readGravityZone(source: unknown): CombatEffectInstance['gravityZone'] {
    const record = asRecord(source);
    if (!record) return null;
    return {
        speedPerTurn: Math.max(0, readNumber(record.speed_per_turn, 0)),
        pull: readBoolean(record.pull, false),
        preventExit: readBoolean(record.prevent_exit, false),
        epicenterHits: readBoolean(record.epicenter_hits, false),
        ignoreEvasion: readBoolean(record.ignore_evasion, false),
        endsOnCasterInterrupt: readBoolean(record.ends_on_caster_interrupt, false),
    };
}

/** Reads a delayed lane strike mark. */
function readRiftMark(source: unknown): CombatEffectInstance['riftMark'] {
    const record = asRecord(source);
    if (!record) return null;
    const power = Math.max(0, readNumber(record.power, 0));
    if (power <= 0) return null;
    return {
        power,
        cascade: clamp(readNumber(record.cascade, 0.6), 0, 1),
    };
}

/**
 * Builds the runtime instance of an authored effect.
 *
 * `outputMultiplier` scales the holder's own output (a weapon's effect power);
 * `phaseMultiplier` is the hour-of-the-day value of the action that cast it.
 * Both scale `buff`/`debuff` magnitudes, while the hour alone scales the
 * effect's own damage and regeneration. Duration, costs, chances and control
 * flags are never scaled.
 *
 * `random` is only consumed by `random_debuff`, which rolls the stats it lowers.
 */
export function createEffectInstance(
    effect: AttackEffect,
    sourceId: string,
    elementId: string | null,
    outputMultiplier = 1,
    phaseMultiplier = 1,
    random: CombatRandom = Math.random,
): CombatEffectInstance {
    const record = asRecord(effect) ?? {};
    const magnitude = outputMultiplier * phaseMultiplier;
    const buff = mergeDeltas(
        scaleStatDelta(readStatDelta(effect.buff), magnitude),
        readRandomStats(record, 'random_buff', magnitude, random),
    );
    const debuff = mergeDeltas(
        scaleStatDelta(readStatDelta(effect.debuff), magnitude),
        readRandomStats(record, 'random_debuff', magnitude, random),
    );
    const damagePerTurn = Math.max(
        0,
        Math.round(readNumber(record.damage_per_turn, 0) * phaseMultiplier),
    );

    // `lower_accuracy` is the older spelling of a debuff on the attacker's own
    // aim; it is folded into the same stat so there is one place a modifier
    // lives.
    const lowerAccuracy = readNumber(record.lower_accuracy, 0) * phaseMultiplier;
    const mergedDebuff = lowerAccuracy > 0
        ? { ...(debuff ?? {}), accuracy: (debuff?.accuracy ?? 0) + lowerAccuracy }
        : debuff;

    const immunities = Array.isArray(record.status_immunities)
        ? record.status_immunities
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '')
        : [];

    const instance: CombatEffectInstance = {
        effectId: readString(effect.effect_id, `${sourceId}_effect`),        sourceId,
        statusEffect: readString(effect.status_effect, '') || null,
        elementId: readString(effect.element_id, '') || elementId,
        turns: resolveTurns(effect.turns),
        applyTo: readString(effect.apply_to, '') || null,
        buff,
        debuff: mergedDebuff,
        statMultipliers: readNumberRecord(record.stat_multipliers),
        polarity: 'neutral',
        regenPerTurn: scaleStatDelta(
            readStatDelta(record.regen_per_turn),
            phaseMultiplier,
        ) as CombatStatDelta | null,
        selfUpkeep: readStatDelta(record.self_upkeep) as CombatStatDelta | null,
        deferredCost: readStatDelta(record.deferred_cost) as CombatStatDelta | null,
        immunities: immunities.length > 0 ? immunities : null,
        preventActions: readPreventActions(effect),
        preventSkills: readBoolean(record.prevent_skills, false),
        untargetable: readBoolean(record.untargetable, false),
        healBlock: readBoolean(record.heal_block, false),
        counter: readBoolean(record.counter, false),
        locksTarget: readBoolean(record.locks_target, false),
        turnOffset: Math.round(readNumber(record.turn_offset, 0)),
        cooldownTick: Math.max(0, Math.round(readNumber(record.cooldown_tick, 0))),
        move: readMoveSpec(effect),
        rewind: readRewindSpec(effect),
        rewindEachTurn: readRewindEachTurn(record.rewind_each_turn),
        shiftOtherEffects: readShiftOtherEffects(record.shift_other_effects),
        fatigueRecoveryDelay: Math.max(0, Math.round(readNumber(record.fatigue_recovery_delay, 0))),
        suspend: readSuspend(record.suspend),
        anchor: asRecord(record.anchor)
            ? { cancelActions: readBoolean(asRecord(record.anchor)?.cancel_actions, true) }
            : null,
        echoMark: readEchoMark(record.echo_mark),
        nextActionBonus: readNextActionBonus(record.next_action_bonus),
        gravityZone: readGravityZone(record.gravity_zone),
        riftMark: readRiftMark(record.rift_mark),
        damagePerTurn,
        damagePerTurnVariance: readVariance(record.damage_variance),
        healOnKill: readHealOnKill(record),
        confuse: readBoolean(record.confuse, false),
        confusionChance: clamp(readNumber(record.confusion_chance, 0.5), 0, 1),
        bonusVsHpBelow: readBonusVsHpBelow(record.bonus_vs_hp_below),
        removableByLux: readBoolean(record.removable_by_lux, false),
        damageImmunities: readDamageImmunities(record),
        elementModulation: readNumberRecord(record.element_modulation),
        expireOnElements: readTrimmedStringList(record.expire_on_elements),
        shieldPercentOfMaxHp: readShieldSpec(record.shield).percentOfMaxHp,
        shieldHitChance: readShieldSpec(record.shield).hitChance,
        shieldMaxHits: readShieldSpec(record.shield).maxHits,
        shieldHitsRemaining: readShieldSpec(record.shield).guarded
            ? readShieldSpec(record.shield).maxHits
            : undefined,
        counterChance: readBoolean(record.counter, false)
            ? 1
            : clamp(readNumber(record.counter_chance, 0), 0, 1),
        counterExceptElements: readTrimmedStringList(record.counter_except_elements),
        damageChannelModulation: readNumberRecord(record.damage_channel_modulation),
        blockStatBuffs: readTrimmedStringList(record.block_stat_buffs),
        preventDamageChannels: readDamageChannels(record.prevent_damage_channels),
        tripOnAction: readTripOnAction(record.trip_on_action),
        chargeMax: readChargesSpec(record.charges)?.max,
        chargeRelease: readChargesSpec(record.charges)?.release ?? null,
        cleansePerTurn: readCleansePerTurn(record.cleanse_per_turn),
        regenPerTurnPercent: readStatDelta(record.regen_per_turn_percent) as CombatStatDelta | null,
        randomRegenPerTurnPercent: Math.max(0, ((): number => {
            const spec = asRecord(record.random_resource_regen_per_turn);
            return spec ? readNumber(spec.percent, 0) : 0;
        })()),
        healPercentOfMax: Math.max(0, readNumber(record.heal_percent_of_max, 0)),
        spendTrigger: readSpendTrigger(record.spend_trigger),
        stacks: readStacking(record.stacking).initial,
        canStack: readBoolean(effect.can_stack, false),
        expiresMode: readExpiresMode(effect),
        laneChangeFree: readBoolean(record.lane_change_free, false) || undefined,
        onMissMove: readOnMissMove(effect),
        elementPower: readNumberRecord(record.element_power),
        projectileAccuracy: ((): CombatEffectInstance['projectileAccuracy'] => {
            const spec = asRecord(record.projectile_accuracy);
            const amount = spec ? readNumber(spec.amount, 0) : 0;
            if (amount <= 0) return null;
            const vsLane = spec ? readString(spec.vs_lane, '') : '';
            return { amount, vsLine: vsLane === 'front' || vsLane === 'rear' ? vsLane : null };
        })(),
        projectileMark: ((): CombatEffectInstance['projectileMark'] => {
            const spec = asRecord(record.projectile_mark);
            const accuracy = spec ? readNumber(spec.accuracy, 0) : 0;
            return accuracy > 0 ? { accuracy } : null;
        })(),
        rangedEvasion: Math.max(0, readNumber(record.ranged_evasion, 0)) || undefined,
        projectileReroll: ((): CombatEffectInstance['projectileReroll'] => {
            const spec = asRecord(record.projectile_reroll);
            if (!spec) return null;
            const perTurn = Math.round(readNumber(spec.per_turn, 0));
            return perTurn > 0 ? { perTurn: Math.min(3, perTurn), used: 0 } : null;
        })(),
        detonateOnTurn: readDetonateOnTurn(record.detonate_on_turn),
        chainDetonation: readChainDetonation(record.chain_detonation),
        conductor: readConductor(record.conductor),
        interrupt: readInterrupt(record.interrupt),
        reflect: readReflect(record.reflect),
        spendSteal: readSpendSteal(record.spend_steal),
        evadeNext: readEvadeNext(record.evade_next),
        damageRedirect: readDamageRedirect(record.damage_redirect),
        costMultiplier: readCostMultiplier(record.cost_multiplier),
        endCost: readEndCost(record.end_cost),
        onDeathBlast: readOnDeathBlast(record.on_death_blast),
        rescueRune: readRescueRune(record.rescue_rune),
        runeStore: readRuneStore(record.rune_store),
        runeReturn: readRuneReturn(record.rune_return),
        chant: readChant(record.chant, random),
        fateLink: readFateLink(record.fate_link, sourceId),
        statusResistChance: readStatusResistChance(record.status_resist_chance),
        effectMagnitudeMultiplier: readEffectMagnitudeMultiplier(record.effect_magnitude_multiplier),
        preventRanges: readRangeList(record.prevent_ranges),
        preventElements: readTrimmedStringList(record.prevent_elements) ?? undefined,
        untargetableRanges: readRangeList(record.untargetable_ranges),
        untargetableElements: readTrimmedStringList(record.untargetable_elements) ?? undefined,
        barrier: readBarrier(record.barrier),
        taunt: readBoolean(record.taunt, false) || undefined,
        critDamageTaken: Math.max(0, readNumber(record.crit_damage_taken, 0)) || undefined,
        intercept: readIntercept(record.intercept),
        shatterOnDamageType: readShatterOnDamageType(record.shatter_on_damage_type),
        petrifyClass: readBoolean(record.petrify_class, false) || undefined,
        fossilizeOnExpiry: readFossilizeOnExpiry(record.fossilize_on_expiry),
        onExpiryDamage: readOnExpiryDamage(record.on_expiry_damage),
        mergeOnApply: readStacking(record.stacking).merge,
        extendOnApply: readStacking(record.stacking).extend,
        damageTiming: readString(record.damage_timing, 'turn_start') === 'turn_end' ? 'turn_end' : 'turn_start',
        decayPerTurn: Math.max(0, Math.round(readNumber(record.decay_per_turn, 0))),
        turnEndStacks: Math.max(0, Math.round(readNumber(record.turn_end_stacks, 0))),
        turnEndBurn: ((): CombatEffectInstance['turnEndBurn'] => {
            const spec = asRecord(record.turn_end_burn);
            if (!spec) return null;
            const chance = clamp(readNumber(spec.chance, 0), 0, 1);
            if (chance <= 0) return null;
            return {
                chance,
                burnStacks: Math.max(0, Math.round(readNumber(spec.burn_stacks, 1))),
                burnTurns: Math.max(0, Math.round(readNumber(spec.burn_turns, 2))),
            };
        })(),
        burstThresholdDown: Math.max(0, Math.round(readNumber(record.burst_threshold_down, 0))),
        perStackCost: Math.max(0, readNumber(record.per_stack_cost, 0)),
        perStackRegenReduction: Math.max(0, readNumber(record.per_stack_regen_reduction, 0)),
        burstAt: Math.max(0, Math.round(readNumber(record.burst_at, 0))),
        burst: readBurst(record.burst),
        washOnElements: readNumberRecord(record.wash_on_elements),
        igniteOnHit: readIgniteOnHit(record.ignite_on_hit),
        igniteAttackerOnHit: readIgniteAttackerOnHit(record.ignite_attacker_on_hit),
        fireWall: readFireWall(record.fire_wall),
        elementDamage: readNumberRecord(record.element_damage),
        projectileElement: readString(record.projectile_element, '') || null,
        cleanseDot: Math.max(0, Math.round(readNumber(record.cleanse_dot, 0))),
        regenBonusPerNegative: readRegenBonuses(record).perNegative,
        regenBonusPerDotPercent: readRegenBonuses(record).perDotPercent,
        regenLowestPercent: Math.max(0, readNumber(record.regen_lowest_percent, 0)),
        refundSpent: readRefundSpent(record.refund_spent),
        cleanseOnHeal: readCleanseOnHeal(record.cleanse_on_heal),
        damageReduction: readDamageReduction(record.damage_reduction),
        drainPercentOfMaxHp: readDrainPercentOfMaxHp(record.drain_percent_of_max_hp),
        drainPerTurn: readDrainPerTurn(record.drain_per_turn),
        movementImmunity: readBoolean(record.movement_immunity, false),
        appliedTurnCount: 0,
    };

    instance.polarity = readPolarity(effect, instance);
    return instance;
}

/**
 * Builds the release status of a full charge gauge (`Frozen` when the
 * `Freezing` charges fill), as one fresh effect instance.
 */
function buildReleaseInstance(charging: CombatEffectInstance): CombatEffectInstance | null {
    const release = charging.chargeRelease;
    if (!release) return null;

    const synthetic: AttackEffect = {
        effect_id: release.effectId,
        status_effect: release.statusEffect ?? '',
        turns: release.turns,
        polarity: 'negative',
        ...(release.preventActions ? { prevent_actions: release.preventActions } : {}),
        ...(release.debuff ? { debuff: release.debuff as unknown as Record<string, number> } : {}),
    };

    return createEffectInstance(
        synthetic,
        charging.sourceId,
        charging.elementId,
        1,
        1,
        // The release carries no randomness; its numbers are the authored ones.
        Math.random,
    );
}

/**
 * Resolves which units an effect's `apply_to` scope addresses.
 *
 * `target` binds to the action's chosen target; the team scopes read the actor's
 * side. The actor is included in its own `allies_all`/`both_teams` scope.
 */
export function resolveEffectTargets(
    applyTo: string | null,
    actor: CombatUnit,
    primaryTarget: CombatUnit | null,
    units: readonly CombatUnit[],
): CombatUnit[] {
    const alive = units.filter((unit) => unit.status === 'alive');

    switch (applyTo ?? 'target') {
        case 'self':
            return alive.filter((unit) => unit.id === actor.id);
        case 'allies_all':
            return alive.filter((unit) => unit.side === actor.side);
        case 'allies_lane':
            // The chosen row: the actor's allies standing in the aimed
            // target's line (`Ranged Veil` veils one lane, not the side).
            return alive.filter((unit) => unit.side === actor.side
                && unit.line === (primaryTarget?.line ?? actor.line));
        case 'enemies_all':
            return alive.filter((unit) => unit.side !== actor.side);
        case 'both_teams':
            return alive;
        case 'target':
        default:
            return primaryTarget ? [primaryTarget] : [];
    }
}

/** Whether a unit is immune to a status, by id or by label. */
export function isImmuneToStatus(unit: CombatUnit, statusId: string): boolean {
    const wanted = statusId.trim().toLowerCase();
    if (wanted === '') return false;

    return unit.effects.some((effect) => (
        effect.immunities?.some((immune) => {
            const entry = immune.trim().toLowerCase();
            return entry === wanted || entry === '*';
        }) ?? false
    ));
}

/** Highest chance a mud-like seal refuses any new status. */
export function statusResistChanceFor(unit: CombatUnit): number {
    return unit.effects.reduce((best, effect) => Math.max(best, effect.statusResistChance ?? 0), 0);
}

/** Compound multiplier a unit applies to incoming buff/debuff magnitudes. */
export function effectMagnitudeMultiplierFor(unit: CombatUnit): number {
    return unit.effects.reduce(
        (product, effect) => product * (effect.effectMagnitudeMultiplier ?? 1),
        1,
    );
}

/** Reach bands the unit cannot use (`earth_hole` and buried variants). */
export function preventedActionRanges(unit: CombatUnit): Array<'short' | 'medium' | 'long'> {
    return unit.effects.flatMap((effect) => effect.preventRanges ?? []);
}

/** Action elements the unit cannot use (`earth_hole` blocks corporis). */
export function preventedActionElements(unit: CombatUnit): string[] {
    return unit.effects.flatMap((effect) => effect.preventElements ?? []);
}

/** Reach bands that cannot target the unit (`burrow`). */
export function untargetableRangesFor(unit: CombatUnit): Array<'short' | 'medium' | 'long'> {
    return unit.effects.flatMap((effect) => effect.untargetableRanges ?? []);
}

/** Action elements that cannot target the unit (`burrow`). */
export function untargetableElementsFor(unit: CombatUnit): string[] {
    return unit.effects.flatMap((effect) => effect.untargetableElements ?? []);
}

/** Extra critical damage the unit takes, additive across statuses. */
export function critDamageTakenFor(unit: CombatUnit | null | undefined): number {
    if (!unit) return 0;
    return unit.effects.reduce((total, effect) => total + (effect.critDamageTaken ?? 0), 0);
}

/** The first live taunting unit on a side (`challenger_stance`). */
export function liveTaunter(units: readonly CombatUnit[], side: CombatSide): CombatUnit | null {
    return units.find((unit) => unit.status === 'alive' && unit.side === side && unit.effects.some((effect) => effect.taunt)) ?? null;
}

/**
 * Whether an effect instance houses any persistent state a status can keep.
 *
 * Application-time clauses (`move`, `rewind`) and one-shot specs live outside
 * the status list, so an effect that carries nothing but them attaches no
 * status at all.
 */
function carriesStatusPayload(instance: CombatEffectInstance): boolean {
    return Boolean(
        instance.statusEffect
        || instance.buff
        || instance.debuff
        || instance.statMultipliers
        || instance.preventActions
        || instance.preventSkills
        || instance.untargetable
        || instance.healBlock
        || instance.immunities
        || instance.counter
        || instance.turnOffset
        || instance.cooldownTick
        || instance.damagePerTurn > 0
        || instance.regenPerTurn
        || instance.regenPerTurnPercent
        || (instance.randomRegenPerTurnPercent ?? 0) > 0
        || instance.selfUpkeep
        || instance.deferredCost
        || instance.locksTarget
        || instance.confuse
        || instance.healOnKill
        || instance.bonusVsHpBelow
        || instance.removableByLux
        || instance.damageImmunities
        || instance.elementModulation
        || instance.shieldPercentOfMaxHp
        || instance.cleansePerTurn
        || (instance.healPercentOfMax ?? 0) > 0
        || instance.spendTrigger
        || instance.chargeMax
        || instance.counterExceptElements
        || instance.damageChannelModulation
        || instance.blockStatBuffs
        || instance.preventDamageChannels
        || instance.tripOnAction
        || instance.laneChangeFree
        || instance.onMissMove
        || instance.elementPower
        || instance.projectileAccuracy
        || instance.projectileMark
        || (instance.rangedEvasion ?? 0) > 0
        || instance.projectileReroll
        || instance.detonateOnTurn
        || instance.chainDetonation
        || instance.conductor
        || instance.interrupt
        || instance.reflect
        || instance.spendSteal
        || instance.evadeNext
        || instance.damageRedirect
        || instance.costMultiplier
        || instance.endCost
        || instance.onDeathBlast
        || instance.rescueRune
        || instance.runeStore
        || instance.runeReturn
        || instance.chant
        || instance.fateLink
        || instance.mergeOnApply
        || instance.damageTiming === 'turn_end'
        || (instance.turnEndStacks ?? 0) > 0
        || instance.turnEndBurn
        || (instance.burstThresholdDown ?? 0) > 0
        || (instance.burstAt ?? 0) > 0
        || instance.burst
        || instance.washOnElements
        || instance.igniteOnHit
        || instance.igniteAttackerOnHit
        || instance.fireWall
        || instance.elementDamage
        || instance.projectileElement
        || instance.cleanseDot
        || (instance.regenBonusPerNegative ?? 0) > 0
        || (instance.regenBonusPerDotPercent ?? 0) > 0
        || (instance.regenLowestPercent ?? 0) > 0
        || instance.refundSpent
        || instance.cleanseOnHeal
        || instance.damageReduction
        || instance.drainPercentOfMaxHp
        || instance.drainPerTurn
        || instance.movementImmunity
        || instance.statusResistChance !== undefined
        || instance.effectMagnitudeMultiplier !== undefined
        || instance.preventRanges
        || instance.preventElements
        || instance.untargetableRanges
        || instance.untargetableElements
        || instance.barrier
        || instance.taunt
        || (instance.critDamageTaken ?? 0) > 0
        || instance.intercept
        || instance.shatterOnDamageType
        || instance.petrifyClass
        || instance.fossilizeOnExpiry
        || instance.onExpiryDamage
        || instance.rewindEachTurn
        || instance.shiftOtherEffects
        || (instance.fatigueRecoveryDelay ?? 0) > 0
        || instance.suspend
        || instance.anchor
        || instance.echoMark
        || instance.nextActionBonus
        || instance.gravityZone
        || instance.riftMark,
    );
}

/**
 * Applies one effect instance to a unit, returning the feedback event.
 *
 * A unit that is immune to the status does not take it: the effect is skipped
 * and the refusal is reported, so the log can say "resisted".
 *
 * `outputMultiplier` is the caster's own output boost; `phaseMultiplier` is the
 * action's hour-of-the-day value (see {@link createEffectInstance}).
 */
export function applyEffectToUnit(
    unit: CombatUnit,
    effect: AttackEffect,
    sourceId: string,
    elementId: string | null,
    random: CombatRandom,
    outputMultiplier = 1,
    phaseMultiplier = 1,
): EffectOutcomeEvent | null {
    const chance = effectChance(effect);
    if (chance < 1 && random() >= chance) return null;

    // A return rune swallows the first incoming status as well as damage/healing.
    const statusPayload = Boolean(effect.status_effect || effect.buff || effect.debuff);
    if (statusPayload && captureRuneStatus(unit, effect, sourceId, elementId)) {
        return {
            type: 'effect_resisted',
            unitId: unit.id,
            effectId: readString(effect.effect_id, `${sourceId}_effect`),
            statusEffect: readString(effect.status_effect, '') || null,
            captured: true,
        };
    }

    // A modulation the target already carries (Wet vs ignis) scales the whole
    // landing — buffs, debuffs, heals and the like lose or gain strength here.
    const modulation = elementModulationFor(unit, elementId);
    const instance = createEffectInstance(
        effect, sourceId, elementId, outputMultiplier * modulation, phaseMultiplier, random,
    );
    // Detonations scale from the bearer's own turn count, so stamp the landing
    // turn while the target is still in hand.
    instance.appliedTurnCount = unit.turnCount;

    // A conversion rune reads and consumes the charge already banked by a memory rune.
    if (instance.runeStore?.mode === 'convert') {
        const memory = unit.effects.find((active) => active.runeStore?.mode === 'memory'
            && (active.runeStore.stored ?? 0) > 0);
        if (memory?.runeStore) {
            instance.runeStore.stored = memory.runeStore.stored;
            unit.effects = unit.effects.filter((active) => active !== memory);
        }
    }

    // Time suspension either refuses the status outright (`stasis`) or banks it
    // until the suspension ends (`time_lock`).
    const suspension = unit.effects.find((active) => active.suspend)?.suspend ?? null;
    if (suspension && instance.statusEffect) {
        if (suspension.invulnerable) {
            return {
                type: 'effect_resisted',
                unitId: unit.id,
                effectId: instance.effectId,
                statusEffect: instance.statusEffect,
            };
        }
        if (suspension.deferStatuses) {
            suspension.deferredStatuses.push({
                effect,
                sourceId,
                elementId,
                outputMultiplier,
                phaseMultiplier,
            });
            return null;
        }
    }

    // Mud seals refuse a share of incoming statuses, and erosion makes every
    // buff/debuff that does land weaker. Both read live statuses on the target.
    const resistChance = statusResistChanceFor(unit);
    if (instance.statusEffect && resistChance > 0 && random() < resistChance) {
        return {
            type: 'effect_resisted',
            unitId: unit.id,
            effectId: instance.effectId,
            statusEffect: instance.statusEffect,
        };
    }
    const magnitudeMultiplier = effectMagnitudeMultiplierFor(unit);
    if (magnitudeMultiplier !== 1) {
        instance.buff = scaleStatDelta(instance.buff, magnitudeMultiplier);
        instance.debuff = scaleStatDelta(instance.debuff, magnitudeMultiplier);
    }

    if (instance.refundSpent) {
        instance.refundSpent.baseline = {
            mana: unit.eventCounts.mana_spent_total ?? 0,
            stamina: unit.eventCounts.stamina_spent_total ?? 0,
        };
    }

    // A landing that houses nothing a status can keep (a bare `move`, a
    // one-shot `turn_postpone` clause) resolves in the field and leaves no
    // status behind to wear off.
    if (!carriesStatusPayload(instance)) return null;

    // A landing upgrade (`condensation` under `mist`) applies when the target
    // already carries a matching status; it folds its numbers into the instance.
    const upgrade = readUpgradeVsStatus((asRecord(effect) ?? {}).upgrade_vs_status);
    if (upgrade && carriesStatusNamed(unit, upgrade.status)) {
        if (upgrade.extraTurns > 0
            && upgrade.extraTurnsChance > 0
            && random() < upgrade.extraTurnsChance) {
            instance.turns = instance.turns === null
                ? null
                : instance.turns + upgrade.extraTurns;
        }
        if (upgrade.extraHealPercentOfMax > 0) {
            instance.healPercentOfMax = (instance.healPercentOfMax ?? 0) + upgrade.extraHealPercentOfMax;
        }
        if (upgrade.extraRegenPercent) {
            const merged: Record<string, number> = {
                ...(instance.regenPerTurnPercent as Record<string, number> ?? {}),
            };
            for (const [resource, percent] of Object.entries(upgrade.extraRegenPercent)) {
                merged[resource] = (merged[resource] ?? 0) + readNumber(percent, 0);
            }
            instance.regenPerTurnPercent = merged as CombatStatDelta;
        }
    }

    // A landing that strips statuses first (Freezing washes Wet off a soaked
    // target) removes every match by label or effect id before applying.
    const strip = readTrimmedStringList((asRecord(effect) ?? {}).also_remove_status);
    if (strip) {
        const wanted = strip.map((entry) => normalizeStatusKey(entry));
        unit.effects = unit.effects.filter((active) => (
            !wanted.includes(normalizeStatusKey(active.statusEffect ?? ''))
            && !wanted.includes(normalizeStatusKey(active.effectId))
        ));
    }


    // The immunity bites on the status the effect carries, by id or by label.
    const statusKey = instance.statusEffect ?? instance.effectId;
    if (statusKey && isImmuneToStatus(unit, statusKey)) {
        return {
            type: 'effect_resisted',
            unitId: unit.id,
            effectId: instance.effectId,
            statusEffect: instance.statusEffect,
        };
    }

    // The id counts too: an immunity may name the effect rather than its label.
    if (isImmuneToStatus(unit, instance.effectId)) {
        return {
            type: 'effect_resisted',
            unitId: unit.id,
            effectId: instance.effectId,
            statusEffect: instance.statusEffect,
        };
    }

    // A stack status (`Burn`, `Overheat`, `Fuel`) merges into the existing
    // bearer instead of replacing it: stacks rise and the remaining duration is
    // extended, exactly as the fire catalogue describes.
    if (instance.mergeOnApply && instance.statusEffect) {
        const label = normalizeStatusKey(instance.statusEffect);
        const holder = unit.effects.find((active) => (
            active.mergeOnApply
            && active.statusEffect
            && normalizeStatusKey(active.statusEffect) === label
        ));
        if (holder) {
            holder.stacks = Math.max(1, holder.stacks) + Math.max(1, instance.stacks);
            if (instance.turns === null) {
                // Pyre removes the turn limit even when it lands on an older Burn.
                holder.turns = null;
            } else if (holder.turns !== null) {
                holder.turns += Math.max(0, instance.extendOnApply ?? 0);
            }
            return {
                type: 'effect_applied',
                unitId: unit.id,
                effectId: holder.effectId,
                statusEffect: holder.statusEffect,
                turns: holder.turns,
            };
        }
    }

    // A charge-bearing landing builds onto the shared status instead of
    // stacking alongside it: each charge raises the count, refreshes the
    // duration and deepens the carried debuff. A full gauge spends itself on
    // the release status (`Freeze` charges end in a `Frozen` miss).
    const charges = readChargesSpec((asRecord(effect) ?? {}).charges);
    if (charges) {
        const granted = Math.max(1, Math.round(charges.initial));
        const holder = unit.effects.find((active) => (
            active.chargeMax
            && (active.statusEffect && active.statusEffect.toLowerCase() === (instance.statusEffect ?? '').toLowerCase())
        ));

        if (holder) {
            holder.stacks = Math.max(1, holder.stacks) + granted;
            if (instance.turns !== null && (holder.turns === null || instance.turns > holder.turns)) {
                holder.turns = instance.turns;
            }

            if (holder.stacks >= (holder.chargeMax ?? Number.POSITIVE_INFINITY) && holder.chargeRelease) {
                const release = buildReleaseInstance(holder);
                if (release && !isImmuneToStatus(unit, release.statusEffect ?? release.effectId)) {
                    unit.effects = unit.effects.filter((active) => active !== holder);
                    unit.effects.push(release);
                    return {
                        type: 'effect_applied',
                        unitId: unit.id,
                        effectId: release.effectId,
                        statusEffect: release.statusEffect,
                        turns: release.turns,
                    };
                }
                // A full gauge with no release simply loses its charge status.
                unit.effects = unit.effects.filter((active) => active !== holder);
            }

            return {
                type: 'effect_applied',
                unitId: unit.id,
                effectId: holder.effectId,
                statusEffect: holder.statusEffect,
                turns: holder.turns,
            };
        }

        instance.chargeMax = charges.max;
        instance.stacks = granted;
    }

    // A `refresh_status` landing replaces any other status carrying the same
    // label, so a new Wet refreshes an older Wet from a different skill.
    if (readBoolean((asRecord(effect) ?? {}).refresh_status, false) && instance.statusEffect) {
        const label = normalizeStatusKey(instance.statusEffect);
        unit.effects = unit.effects.filter((active) => (
            !active.statusEffect || normalizeStatusKey(active.statusEffect) !== label
        ));
    }
    // A shielded landing tops up to its own value: shields are not additive,
    // the newest shield is the whole barrier while it stands.
    if ((instance.shieldPercentOfMaxHp ?? 0) > 0) {
        const maxHp = effectiveStats(unit).maxHp;
        instance.shieldRemaining = Math.round(maxHp * (instance.shieldPercentOfMaxHp ?? 0) / 100);
    }

    // A temporal landing stretches or shortens the other statuses its bearer
    // already carries (`quickened_pulse`, `dragging_moment`).
    const shift = instance.shiftOtherEffects;
    if (shift) {
        const delta = shift.direction === 'extend' ? shift.turns : -shift.turns;
        unit.effects = unit.effects.filter((active) => {
            if (shift.polarity !== 'any' && active.polarity !== shift.polarity) return true;
            if (active.turns === null) return true;
            active.turns = Math.max(0, active.turns + delta);
            return active.turns > 0;
        });
    }

    const existingIndex = unit.effects.findIndex((active) => active.effectId === instance.effectId);

    if (existingIndex >= 0 && !instance.canStack) {
        unit.effects[existingIndex] = instance;
    } else {
        unit.effects.push(instance);
    }

    return {
        type: 'effect_applied',
        unitId: unit.id,
        effectId: instance.effectId,
        statusEffect: instance.statusEffect,
        turns: instance.turns,
    };
}

/**
 * Applies a status's final damage when it expires (`fossil` can end in a
 * shattering blow). Without a state the blast only reaches its bearer.
 */
function applyOnExpiryDamage(
    unit: CombatUnit,
    effect: CombatEffectInstance,
    events: CombatEvent[],
    state?: Pick<CombatState, 'units'>,
): void {
    const spec = effect.onExpiryDamage;
    if (!spec || spec.power <= 0) return;

    const targets = spec.scope === 'all' && state
        ? state.units.filter((target) => target.status === 'alive')
        : [unit];

    for (const target of targets) {
        events.push(...changeResource(target, 'hp', -spec.power));
    }
}

/**
 * Hardens a petrify-class effect into its fossil when it expires.
 *
 * The fossil inherits the authored lockout and crit vulnerability, and may
 * carry a `break_power` blast for when the fossil itself ends.
 */
function applyFossilizeOnExpiry(
    unit: CombatUnit,
    effect: CombatEffectInstance,
    random: CombatRandom,
    events: CombatEvent[],
): void {
    const spec = effect.fossilizeOnExpiry;
    if (!spec) return;

    const synthetic: AttackEffect = {
        effect_id: 'fossil',
        status_effect: spec.statusEffect,
        turns: spec.turns,
        polarity: 'negative',
        ...(spec.debuff ? { debuff: spec.debuff as unknown as Record<string, number> } : {}),
        ...(spec.critDamageTaken ? { crit_damage_taken: spec.critDamageTaken } : {}),
        ...(spec.preventActions ? { prevent_actions: spec.preventActions } : {}),
        ...(spec.preventRanges ? { prevent_ranges: spec.preventRanges } : {}),
        ...(spec.preventElements ? { prevent_elements: spec.preventElements } : {}),
        ...(spec.breakPower > 0
            ? { on_expiry_damage: { power: spec.breakPower, scope: 'self' as const } }
            : {}),
    };

    const applied = applyEffectToUnit(unit, synthetic, effect.sourceId, effect.elementId, random);
    if (applied) events.push(applied);
}

/** Records health damage into a live rune-store (`rune_of_memory` family). */
export function recordRuneDamage(unit: CombatUnit, amount: number): void {
    if (amount <= 0) return;
    const holder = unit.effects.find((effect) => effect.runeStore?.mode === 'convert')
        ?? unit.effects.find((effect) => effect.runeStore);
    if (!holder?.runeStore) return;
    const cap = effectiveStats(unit).maxHp * holder.runeStore.capPercent / 100;
    holder.runeStore.stored = Math.min(cap, holder.runeStore.stored + amount);
}

/**
 * Banks the first incoming swing in a return rune (`rune_of_return`).
 *
 * Returns `true` when the swing was swallowed and must not resolve on the
 * bearer; the stored value is paid back when the rune expires.
 */
export function captureRuneReturn(
    unit: CombatUnit,
    amount: number,
    kind: 'damage' | 'heal',
    sourceId: string,
    element: string | null,
): boolean {
    if (amount <= 0) return false;
    const holder = unit.effects.find((effect) => effect.runeReturn && effect.runeReturn.stored <= 0);
    if (!holder?.runeReturn) return false;

    holder.runeReturn.stored = amount;
    holder.runeReturn.storedKind = kind;
    holder.runeReturn.storedSourceId = sourceId;
    holder.runeReturn.storedElement = element;
    holder.runeReturn.storedEffect = null;
    return true;
}

/** Banks an incoming status payload in a return rune. */
function captureRuneStatus(
    unit: CombatUnit,
    effect: AttackEffect,
    sourceId: string,
    element: string | null,
): boolean {
    const holder = unit.effects.find((entry) => entry.runeReturn && entry.runeReturn.stored <= 0);
    if (!holder?.runeReturn) return false;

    holder.runeReturn.stored = 1;
    holder.runeReturn.storedKind = 'status';
    holder.runeReturn.storedSourceId = sourceId;
    holder.runeReturn.storedElement = element;
    holder.runeReturn.storedEffect = { ...effect };
    return true;
}

/** Rolls a chant's interruption chance after one damage instance. */
export function interruptChantOnDamage(unit: CombatUnit, random: CombatRandom): CombatEvent[] {
    const events: CombatEvent[] = [];
    for (const effect of [...unit.effects]) {
        if (!effect.chant || effect.chant.charges <= 0) continue;
        if (random() >= effect.chant.interruptChance) continue;

        unit.effects = unit.effects.filter((entry) => entry !== effect);
        events.push({ type: 'effect_expired', unitId: unit.id, effectId: effect.effectId });
        events.push({
            type: 'action_interrupted',
            unitId: unit.id,
            actionId: 'chant',
            effectId: effect.effectId,
            statusEffect: effect.statusEffect,
        });
    }
    return events;
}

/** Builds the target list a chant releases into. */
function chantTargets(unit: CombatUnit, effect: CombatEffectInstance, state?: Pick<CombatState, 'units'>): CombatUnit[] {
    const chant = effect.chant;
    if (!chant || !state) return [];

    const enemySide = unit.side === 'allies' ? 'enemies' : 'allies';
    const stored = chant.targetId
        ? state.units.find((candidate) => candidate.id === chant.targetId && candidate.status === 'alive')
        : null;

    if (chant.scope === 'all') {
        return state.units.filter((candidate) => candidate.status === 'alive' && candidate.side === enemySide);
    }
    if (chant.scope === 'lane') {
        const line = stored?.line ?? unit.line;
        return state.units.filter((candidate) => candidate.status === 'alive'
            && candidate.side === enemySide
            && candidate.line === line);
    }
    if (stored) return [stored];

    return state.units
        .filter((candidate) => candidate.status === 'alive' && candidate.side === enemySide)
        .sort((a, b) => a.currentHp - b.currentHp)
        .slice(0, 1);
}

/** Pays a chant's per-turn price and adds one charge. */
function tickChant(
    unit: CombatUnit,
    effect: CombatEffectInstance,
    events: CombatEvent[],
    random: CombatRandom,
): void {
    const chant = effect.chant;
    if (!chant) return;
    if (chant.charges <= 0) return;

    // The turn the chant would expire is its release turn: no further payment
    // and no further charge.
    if (effect.turns !== null && effect.turns - 1 <= 0) return;

    const cannotPayHp = chant.payHp > 0 && unit.currentHp <= chant.payHp;
    const cannotPayMana = chant.payMana > 0 && unit.currentMana < chant.payMana;
    if (cannotPayHp || cannotPayMana) {
        // A failed payment consumes the chant and every charge it held.
        effect.turns = 1;
        chant.charges = 0;
        return;
    }

    if (chant.payMana > 0) events.push(...changeResource(unit, 'mana', -chant.payMana));
    if (chant.payHp > 0) events.push(...changeResource(unit, 'hp', -chant.payHp));
    chant.charges = Math.min(chant.maxCharges, chant.charges + 1);
    // Unused random source kept for parity with other per-turn statuses.
    void random;
}

/** Releases a chant's stored charges into its targets. */
function releaseChant(
    unit: CombatUnit,
    effect: CombatEffectInstance,
    events: CombatEvent[],
    state?: Pick<CombatState, 'units'>,
    random: CombatRandom = Math.random,
): void {
    const chant = effect.chant;
    if (!chant || chant.charges <= 0 || chant.damagePerCharge <= 0) return;

    const power = Math.round(chant.damagePerCharge * chant.charges);
    for (const target of chantTargets(unit, effect, state)) {
        if (captureRuneReturn(target, power, 'damage', unit.id, chant.element ?? effect.elementId)) {
            continue;
        }
        events.push(...changeResource(target, 'hp', -power));
        recordRuneDamage(target, power);
        events.push(...interruptChantOnDamage(target, random));
    }
    chant.charges = 0;
}

/** Resolves a rune-store on expiry (`rune_of_restoration`, `rune_of_strength`). */
function resolveRuneStoreOnExpiry(
    unit: CombatUnit,
    effect: CombatEffectInstance,
    events: CombatEvent[],
    state?: Pick<CombatState, 'units'>,
): void {
    const store = effect.runeStore;
    if (!store || store.mode !== 'convert' || unit.status !== 'alive' || store.stored <= 0) return;

    const source = state?.units.find((candidate) => candidate.id === effect.sourceId);
    const side = source?.side ?? unit.side;
    let amount = Math.round(store.stored * store.conversionPercent / 100);
    if (store.outputCapPercent !== null) {
        amount = Math.min(amount, Math.round(effectiveStats(unit).maxHp * store.outputCapPercent / 100));
    }
    if (amount <= 0) return;

    if (store.healOrDamage && state) {
        const wounded = state.units
            .filter((candidate) => candidate.status === 'alive'
                && candidate.side === side
                && candidate.currentHp < effectiveStats(candidate).maxHp)
            .sort((a, b) => a.currentHp / Math.max(1, effectiveStats(a).maxHp)
                - b.currentHp / Math.max(1, effectiveStats(b).maxHp))[0];
        if (wounded) {
            events.push(...changeResource(wounded, 'hp', amount));
            return;
        }
    }

    const enemies = state
        ? state.units.filter((candidate) => candidate.status === 'alive' && candidate.side !== side)
        : [];
    const victim = enemies.sort((a, b) => a.currentHp - b.currentHp)[0];
    if (victim) events.push(...changeResource(victim, 'hp', -amount));
}

/** Pays and returns a stored swing when a return rune expires. */
function resolveRuneReturnOnExpiry(
    unit: CombatUnit,
    effect: CombatEffectInstance,
    events: CombatEvent[],
    state?: Pick<CombatState, 'units'>,
    random: CombatRandom = Math.random,
): void {
    const rune = effect.runeReturn;
    if (!rune || rune.stored <= 0) return;

    const { mana, stamina } = rune.payment;
    const canPay = unit.currentMana >= mana && unit.currentStamina >= stamina;
    const source = state?.units.find((candidate) => candidate.id === rune.storedSourceId) ?? null;
    const amount = Math.round(rune.stored * rune.percent / 100);

    if (rune.storedKind === 'status' && rune.storedEffect) {
        if (!canPay) {
            const applied = applyEffectToUnit(
                unit,
                rune.storedEffect,
                rune.storedSourceId ?? unit.id,
                rune.storedElement,
                random,
            );
            if (applied) events.push(applied);
            rune.stored = 0;
            return;
        }
        if (mana > 0) events.push(...changeResource(unit, 'mana', -mana));
        if (stamina > 0) events.push(...changeResource(unit, 'stamina', -stamina));
        const recipient = source?.status === 'alive' ? source : unit;
        const applied = applyEffectToUnit(
            recipient,
            rune.storedEffect,
            rune.storedSourceId ?? unit.id,
            rune.storedElement,
            random,
            rune.percent / 100,
        );
        if (applied) events.push(applied);
        rune.stored = 0;
        return;
    }

    if (!canPay) {
        // The caster could not afford the return: the original effect resolves
        // on them instead, at its original magnitude.
        events.push(...changeResource(unit, 'hp', rune.storedKind === 'heal' ? rune.stored : -rune.stored));
        rune.stored = 0;
        return;
    }

    if (mana > 0) events.push(...changeResource(unit, 'mana', -mana));
    if (stamina > 0) events.push(...changeResource(unit, 'stamina', -stamina));

    const recipient = source?.status === 'alive' ? source : unit;
    events.push(...changeResource(recipient, 'hp', rune.storedKind === 'heal' ? amount : -amount));
    rune.stored = 0;
}

/**
 * Decrements every timed effect on a unit, expiring the finished ones.
 *
 * A damaging status (`damage_per_turn`) pays out first, so a poison that kills
 * its host on the turn it ticks is recorded before the effect is reaped.
 *
 * The same tick pays what the effect owes its holder: `regen_per_turn` gives
 * the resources back, `self_upkeep` takes them, and `deferred_cost` is paid
 * once, on the turn after the effect landed.
 */
export function tickUnitEffects(
    unit: CombatUnit,
    random: CombatRandom = Math.random,
    state?: Pick<CombatState, 'units'>,
): CombatEvent[] {
    const events: CombatEvent[] = [];
    const remaining: CombatEffectInstance[] = [];
    // A tick-shed status (`rain`) may remove a sibling mid-sweep; those ids
    // are barred from the rebuilt status list, or the cleansing would undo itself.
    const shedThisTick = new Set<string>();

    for (const effect of unit.effects) {
        if (effect.damagePerTurn > 0 && effect.damageTiming !== 'turn_end') {
            // A variable DoT rolls its own `damage_variance` every tick, so a
            // rot can bite hard one turn and barely the next.
            const variance = effect.damagePerTurnVariance
                ? rollVariance(random, effect.damagePerTurnVariance)
                : 1;
            const amount = Math.max(
                1,
                Math.round(effect.damagePerTurn * Math.max(1, effect.stacks) * variance),
            );
            events.push(...changeResource(unit, 'hp', -amount));
        }

        // Fuel burns down by one stack at the start of the bearer's turn.
        if ((effect.decayPerTurn ?? 0) > 0) {
            effect.stacks = Math.max(0, effect.stacks - (effect.decayPerTurn ?? 0));
            if (effect.stacks <= 0) {
                events.push({ type: 'effect_expired', unitId: unit.id, effectId: effect.effectId });
                continue;
            }
        }

        // A seed (`blood_seed`, `mana_seed`) drains a share of a maximum pool
        // at the start of the bearer's turn and can feed its source.
        if (effect.drainPerTurn && random() < effect.drainPerTurn.chance) {
            const stats = effectiveStats(unit);
            const max = effect.drainPerTurn.resource === 'mana' ? stats.maxMana : stats.maxHp;
            const amount = Math.max(0, Math.round(max * effect.drainPerTurn.percentOfMax / 100));
            if (amount > 0) {
                events.push(...changeResource(unit, effect.drainPerTurn.resource, -amount));
                if (effect.drainPerTurn.healToSource && state) {
                    const source = state.units.find((candidate) => candidate.id === effect.sourceId);
                    if (source && source.status === 'alive') {
                        events.push(...changeResource(source, effect.drainPerTurn.resource, amount));
                    }
                }
            }
        }

        if (effect.regenPerTurn) {
            events.push(...payResourceDelta(unit, effect.regenPerTurn, 1));
        }

        // A HoT authored as a percent of the holder's own maxima (`rain`-family
        // regen) pays against the *current* max, so buffs scale it along.
        if (effect.regenPerTurnPercent) {
            const percent = { ...effect.regenPerTurnPercent };
            if ((effect.regenBonusPerNegative ?? 0) > 0) {
                const negatives = unit.effects.filter((active) => active.polarity === 'negative').length;
                percent.hp = (percent.hp ?? 0) + negatives * (effect.regenBonusPerNegative ?? 0);
            }
            if ((effect.regenBonusPerDotPercent ?? 0) > 0) {
                const maxHp = Math.max(1, effectiveStats(unit).maxHp);
                const dotPerTurn = unit.effects.reduce(
                    (total, active) => total + Math.max(0, active.damagePerTurn),
                    0,
                );
                percent.hp = (percent.hp ?? 0)
                    + Math.floor((dotPerTurn / maxHp) * 10) * (effect.regenBonusPerDotPercent ?? 0);
            }
            events.push(...payPercentOfMaxDelta(unit, percent as CombatStatDelta, isHealBlocked(unit)));
        }

        // `cleansing_rain` picks one of the holder's pools at random and pays a
        // percent of its maximum into it.
        if ((effect.randomRegenPerTurnPercent ?? 0) > 0) {
            events.push(...payRandomResourcePercent(unit, effect.randomRegenPerTurnPercent ?? 0, random, isHealBlocked(unit)));
        }

        // `rain` sheds one named-polarity status per turn from its holder.
        if (effect.cleansePerTurn) {
            const shed = tickCleansePerTurn(unit, effect.cleansePerTurn);
            events.push(...shed);
            for (const event of shed) {
                if (event.type === 'effect_expired') shedThisTick.add(event.effectId);
            }
        }

        if (effect.chant) {
            tickChant(unit, effect, events, random);
        }

        if (effect.selfUpkeep) {
            events.push(...payResourceDelta(unit, effect.selfUpkeep, -1));
        }

        if (effect.deferredCost) {
            events.push(...payResourceDelta(unit, effect.deferredCost, -1));
            // The debt is paid once; the effect keeps living without it.
            remaining.push({ ...effect, deferredCost: null });
        } else {
            // A projectile-re-roll status (`Second Chance`) re-arms on every
            // one of its holder's turns, so its counter restarts here.
            remaining.push(
                effect.projectileReroll
                    ? { ...effect, projectileReroll: { ...effect.projectileReroll, used: 0 } }
                    : effect,
            );
        }
    }

    const expiring: CombatEffectInstance[] = [];
    const fossilized: CombatEffectInstance[] = [];
    for (const effect of remaining) {
        if (shedThisTick.has(effect.effectId)) continue;
        // A `turn_start` status ends the very moment its holder's turn begins
        // (`Updraft`); its turn is spent guarding, not counting.
        const expires = effect.expiresMode === 'turn_start'
            || (effect.turns !== null && effect.turns - 1 <= 0);
        if (!expires) {
            expiring.push(
                effect.turns === null ? effect : { ...effect, turns: effect.turns - 1 },
            );
            continue;
        }

        events.push({ type: 'effect_expired', unitId: unit.id, effectId: effect.effectId });

        // Vetus runes and chants resolve their stored payload as they end.
        if (effect.chant) releaseChant(unit, effect, events, state, random);
        resolveRuneStoreOnExpiry(unit, effect, events, state);
        resolveRuneReturnOnExpiry(unit, effect, events, state, random);

        // A status with a final price (`adrenaline`) pays it when it ends.
        events.push(...applyEndCost(unit, effect));

        // A field that expires untouched still bites whoever stood on it
        // (`blast_rush`, `grounding`).
        if ((effect.tripOnAction?.expireDamage ?? 0) > 0) {
            events.push(...changeResource(unit, 'hp', -(effect.tripOnAction?.expireDamage ?? 0)));
        }

        applyOnExpiryDamage(unit, effect, events, state);
        if (effect.fossilizeOnExpiry) fossilized.push(effect);

        if (effect.locksTarget && unit.lockedByEffectId === effect.effectId) {
            unit.lockedTargetId = null;
            unit.lockedByEffectId = null;
        }
    }

    unit.effects = expiring;

    // A petrify status that ends hardens into its fossil. This runs after the
    // new status list is installed so the fossil is not immediately swept away.
    for (const effect of fossilized) {
        applyFossilizeOnExpiry(unit, effect, random, events);
    }

    return events;
}

/**
 * Pays the statuses that resolve at the END of their bearer's turn.
 *
 * Burn (`damage_timing: turn_end`) damages after the action. Overheat gains a
 * stack and bursts at its threshold. The function does not decrement duration;
 * the start-of-turn tick owns that.
 */
export function tickTurnEndEffects(
    unit: CombatUnit,
    random: CombatRandom = Math.random,
): CombatEvent[] {
    const events: CombatEvent[] = [];
    const consumed: CombatEffectInstance[] = [];

    for (const effect of [...unit.effects]) {
        if (effect.damagePerTurn > 0 && effect.damageTiming === 'turn_end') {
            const amount = Math.max(
                1,
                Math.round(effect.damagePerTurn * Math.max(1, effect.stacks)),
            );
            events.push(...changeResource(unit, 'hp', -amount));
        }

        if ((effect.turnEndStacks ?? 0) > 0) {
            effect.stacks = Math.max(1, effect.stacks) + (effect.turnEndStacks ?? 0);
            const thresholdDown = unit.effects.reduce(
                (total, entry) => total + Math.max(0, entry.burstThresholdDown ?? 0),
                0,
            );
            const threshold = Math.max(2, (effect.burstAt ?? 0) - thresholdDown);
            if (effect.burstAt && effect.stacks >= threshold && effect.burst) {
                const burst = effect.burst;
                if (burst.damage > 0) {
                    events.push(...changeResource(unit, 'hp', -burst.damage));
                }
                if (burst.burnStacks > 0 && burst.burnTurns > 0) {
                    const burn: AttackEffect = {
                        effect_id: 'burn',
                        status_effect: 'Burn',
                        turns: burst.burnTurns,
                        polarity: 'negative',
                        damage_per_turn: 4,
                        damage_timing: 'turn_end',
                        stacking: { extend_turns: 1 },
                    };
                    const applied = applyEffectToUnit(unit, burn, effect.sourceId, effect.elementId, random);
                    if (applied) events.push(applied);
                }
                if (burst.pdefPercent > 0 && burst.turns > 0) {
                    const pdef: AttackEffect = {
                        effect_id: 'overheat_burst_pdef',
                        status_effect: 'Overheat Burst',
                        turns: burst.turns,
                        polarity: 'negative',
                        debuff: { physical_defense: burst.pdefPercent },
                    };
                    const applied = applyEffectToUnit(unit, pdef, effect.sourceId, effect.elementId, random);
                    if (applied) events.push(applied);
                }
                consumed.push(effect);
            }
        }

        if (effect.turnEndBurn && random() < effect.turnEndBurn.chance) {
            const burn: AttackEffect = {
                effect_id: 'burn',
                status_effect: 'Burn',
                turns: effect.turnEndBurn.burnTurns,
                polarity: 'negative',
                damage_per_turn: 4,
                damage_timing: 'turn_end',
                stacking: { extend_turns: 1, initial: effect.turnEndBurn.burnStacks },
            };
            const applied = applyEffectToUnit(unit, burn, effect.sourceId, effect.elementId, random);
            if (applied) events.push(applied);
        }
    }

    if (consumed.length > 0) {
        unit.effects = unit.effects.filter((effect) => !consumed.includes(effect));
        for (const effect of consumed) {
            events.push({ type: 'effect_expired', unitId: unit.id, effectId: effect.effectId });
        }
    }

    return events;
}

/**
 * Drops every `round_end` status the moment a round wraps (`Gale Force` lasts
 * until the end of the round, whoever set it). Returns the `effect_expired`
 * events; the caller fires its own on-removal abilities with them.
 */
export function expireRoundBoundEffects(units: CombatUnit[]): CombatEvent[] {
    const events: CombatEvent[] = [];

    for (const unit of units) {
        const kept: CombatEffectInstance[] = [];
        const fossilized: CombatEffectInstance[] = [];
        for (const effect of unit.effects) {
            if (effect.expiresMode === 'round_end') {
                events.push({ type: 'effect_expired', unitId: unit.id, effectId: effect.effectId });
                events.push(...applyEndCost(unit, effect));
                applyOnExpiryDamage(unit, effect, events);
                if (effect.fossilizeOnExpiry) fossilized.push(effect);
                continue;
            }
            kept.push(effect);
        }
        unit.effects = kept;
        for (const effect of fossilized) {
            applyFossilizeOnExpiry(unit, effect, Math.random, events);
        }
    }

    return events;
}

/**
 * Drops the unit's `turn_end` statuses right after its action resolves
 * (`Ranged Veil` veils one lane until each veiled ally acts). Returns the
 * events; the caller fires its own on-removal abilities with them.
 */
export function expireTurnEndEffects(unit: CombatUnit): CombatEvent[] {
    const events: CombatEvent[] = [];
    const kept: CombatEffectInstance[] = [];
    const fossilized: CombatEffectInstance[] = [];

    for (const effect of unit.effects) {
        if (effect.expiresMode === 'turn_end') {
            events.push({ type: 'effect_expired', unitId: unit.id, effectId: effect.effectId });
            events.push(...applyEndCost(unit, effect));
            applyOnExpiryDamage(unit, effect, events);
            if (effect.fossilizeOnExpiry) fossilized.push(effect);
            continue;
        }
        kept.push(effect);
    }
    unit.effects = kept;
    for (const effect of fossilized) {
        applyFossilizeOnExpiry(unit, effect, Math.random, events);
    }

    return events;
}

/** Health the shield of one live status still holds, summed across statuses. */
export function unitShieldRemaining(unit: CombatUnit): number {
    return unit.effects.reduce((total, effect) => total + Math.max(0, effect.shieldRemaining ?? 0), 0);
}

/**
 * Absorbs part of a hit with the target's live status shields, oldest first.
 *
 * Two shield shapes share the wall:
 * - a *pooled* shield (`condensation`) holds a body of HP; hits drain it and
 *   an empty pool drops the status;
 * - a *guarded* shield (`ice_shield`) rolls its `hit_chance` against each hit
 *   — a miss passes the rest of the hit through to the bearer —, soaks the
 *   whole hit, and falls when its `max_hits` are spent (the status goes down
 *   with the wall).
 *
 * Returns the events (`shield_absorbed`, plus `effect_expired` for walls that
 * fell) and the damage left for the holder's health.
 */
export function absorbShieldDamage(
    unit: CombatUnit,
    damage: number,
    random: CombatRandom = Math.random,
): { events: CombatEvent[]; leftover: number } {
    if (damage <= 0) return { events: [], leftover: damage };

    const events: CombatEvent[] = [];
    const fallen: CombatEffectInstance[] = [];
    let leftover = damage;

    for (const effect of unit.effects) {
        if (leftover <= 0) break;
        if (fallen.includes(effect)) continue;
        if (effect.shieldHitsRemaining !== undefined && effect.shieldHitsRemaining <= 0) continue;
        // Not a shield at all: a Counter carries no wall and lets hits pass.
        if (!((effect.shieldPercentOfMaxHp ?? 0) > 0) && effect.shieldHitsRemaining === undefined) continue;

        // A guarded shield guards on the roll; a miss sends the hit through.
        if ((effect.shieldHitChance ?? 1) < 1 && random() >= (effect.shieldHitChance ?? 1)) break;

        let amount: number;
        if ((effect.shieldPercentOfMaxHp ?? 0) > 0) {
            const soaked = effect.shieldRemaining ?? 0;
            amount = Math.min(soaked, leftover);
            effect.shieldRemaining = soaked - amount;
            if (effect.shieldRemaining <= 0) fallen.push(effect);
        } else {
            // An unguarded, unpooled wall soaks the whole hit.
            amount = leftover;
            effect.shieldRemaining = 0;
        }

        if (effect.shieldHitsRemaining !== undefined) {
            effect.shieldHitsRemaining = Math.max(0, effect.shieldHitsRemaining - 1);
            if (effect.shieldHitsRemaining <= 0) fallen.push(effect);
        }

        leftover -= amount;
        events.push({
            type: 'shield_absorbed',
            unitId: unit.id,
            effectId: effect.effectId,
            amount,
            remaining: effect.shieldRemaining ?? 0,
        });
    }

    if (fallen.length > 0) {
        unit.effects = unit.effects.filter((effect) => !fallen.includes(effect));
        for (const wall of fallen) {
            events.push({ type: 'effect_expired', unitId: unit.id, effectId: wall.effectId });
        }
    }

    return { events, leftover };
}

/**
 * Pays percent-of-max amounts into a unit's pools (a percent HoT).
 *
 * The values are percents of the holder's *current* maxima, so a buffed
 * endurance heals proportionally more. `healBlocked` refuses the `hp` pool,
 * matching how {@link applyEffectResources} treats a regen.
 */
function payPercentOfMaxDelta(
    unit: CombatUnit,
    percents: CombatStatDelta,
    healBlocked: boolean,
): CombatEvent[] {
    const events: CombatEvent[] = [];
    const stats = effectiveStats(unit);

    for (const [resource, percent] of Object.entries(percents as Record<string, number>)) {
        const value = Number(percent);
        if (!Number.isFinite(value) || value === 0) continue;

        const max = resource === 'hp'
            ? stats.maxHp
            : resource === 'mana'
                ? stats.maxMana
                : stats.maxStamina;
        const amount = Math.round(max * value / 100);
        if (amount <= 0 && value > 0) continue;

        if (resource === 'hp' && healBlocked) continue;
        events.push(...changeResource(unit, resource as CombatResourceId, amount));
    }

    return events;
}

/**
 * Pays a percent of one random pool's maximum into its resource.
 *
 * A heal-blocked holder cannot gain the `hp` pool: it is dropped from the roll
 * instead of turning the rain into nothing (`cleansing_rain` still pays mana
 * or stamina when it picks one).
 */
function payRandomResourcePercent(
    unit: CombatUnit,
    percent: number,
    random: CombatRandom,
    healBlocked: boolean,
): CombatEvent[] {
    const stats = effectiveStats(unit);
    const pools = ([
        { resource: 'hp' as CombatResourceId, max: stats.maxHp },
        { resource: 'mana' as CombatResourceId, max: stats.maxMana },
        { resource: 'stamina' as CombatResourceId, max: stats.maxStamina },
    ]).filter((pool) => !(pool.resource === 'hp' && healBlocked));

    if (pools.length === 0 || percent <= 0) return [];

    const pool = pools[Math.min(pools.length - 1, Math.floor(random() * pools.length))];
    const amount = Math.round(pool.max * Math.min(100, Math.max(0, percent)) / 100);
    if (amount <= 0) return [];

    return changeResource(unit, pool.resource, amount);
}

/** Sheds up to `spec.count` statuses of the named polarity from the holder. */
function tickCleansePerTurn(
    unit: CombatUnit,
    spec: { count: number; polarity: CombatEffectPolarity | 'any' },
): CombatEvent[] {
    if (spec.polarity === 'positive') {
        return dispelEffects(unit, { count: spec.count });
    }
    if (spec.polarity === 'negative') {
        return cleanseEffects(unit, { count: spec.count });
    }

    // `any`: one negative first; an otherwise clean holder sheds a gift.
    const removed = cleanseEffects(unit, { count: spec.count });
    return removed.length > 0 ? removed : dispelEffects(unit, { count: spec.count });
}

/**
 * Pays a resource delta on a unit's pools.
 *
 * `sign` is `1` for a payout (regeneration) and `-1` for a payment (an upkeep
 * or a deferred cost). The pools are read from the same `hp`/`mana`/`stamina`
 * keys the catalogue uses.
 */
function payResourceDelta(
    unit: CombatUnit,
    delta: CombatStatDelta,
    sign: number,
): CombatEvent[] {    const events: CombatEvent[] = [];

    for (const resource of ['hp', 'mana', 'stamina'] as const) {
        const amount = delta[resource];
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) continue;
        events.push(...changeResource(unit, resource, Math.round(amount * sign)));
    }

    return events;
}

/**
 * Pays a status's final price.
 *
 * `adrenaline` drains a share of the pool when it ends; any shortfall is paid
 * out of health, which is why the helper reads the live maxima.
 */
function applyEndCost(unit: CombatUnit, effect: CombatEffectInstance): CombatEvent[] {
    const events: CombatEvent[] = [];
    const cost = effect.endCost;
    if (cost && cost.percentOfMax > 0) {
        const stats = effectiveStats(unit);
        const max = cost.resource === 'mana' ? stats.maxMana : stats.maxStamina;
        const wanted = Math.round(max * cost.percentOfMax / 100);
        if (wanted > 0) {
            const current = cost.resource === 'mana' ? unit.currentMana : unit.currentStamina;
            const paid = Math.min(current, wanted);
            events.push(...changeResource(unit, cost.resource, -paid));
            const shortfall = wanted - paid;
            if (shortfall > 0) events.push(...changeResource(unit, 'hp', -shortfall));
        }
    }

    const refund = effect.refundSpent;
    if (refund) {
        const stats = effectiveStats(unit);
        for (const resource of refund.resources) {
            if (resource !== 'mana' && resource !== 'stamina') continue;
            const spent = (unit.eventCounts[`${resource}_spent_total`] ?? 0)
                - refund.baseline[resource];
            const amount = Math.round(Math.max(0, spent) * refund.percent);
            if (amount <= 0) continue;
            const max = resource === 'mana' ? stats.maxMana : stats.maxStamina;
            events.push(...changeResource(unit, resource, Math.min(amount, max)));
        }
    }

    return events;
}

/**
 * Moves a unit's HP, mana or stamina by `delta`, clamped to `[0, max]`.
 *
 * Returns the feedback event, or an empty list when the pool was already at the
 * bound. Shared with the turn service so costs and rest both emit the same
 * `resource_changed` feedback the HUD animates.
 */
export function changeResource(
    unit: CombatUnit,
    resource: CombatResourceId,
    delta: number,
): CombatEvent[] {
    const stats = effectiveStats(unit);
    const max = resource === 'hp' ? stats.maxHp : resource === 'mana' ? stats.maxMana : stats.maxStamina;
    const previous = resource === 'hp'
        ? unit.currentHp
        : resource === 'mana'
            ? unit.currentMana
            : unit.currentStamina;

    const next = clamp(previous + delta, 0, max);
    if (next === previous) return [];

    // Paying out of mana/stamina (a cost, a drain, a cursed tax) breaks that
    // resource's idle streak, so the next turn's regen restarts from the floor.
    if (resource !== 'hp' && delta < 0) {
        unit.resourceSpentSinceTurnStart[resource] = true;
        unit.eventCounts[`${resource}_spent_total`] = (unit.eventCounts[`${resource}_spent_total`] ?? 0) + -delta;
    }

    if (resource === 'hp') unit.currentHp = next;
    else if (resource === 'mana') unit.currentMana = next;
    else unit.currentStamina = next;

    return [{ type: 'resource_changed', unitId: unit.id, resource, previous, next }];
}

/**
 * Applies an effect's resource swing: flat damage, healing, regen and drain.
 *
 * Stat changes are handled by {@link effectiveStats}, so this only touches the
 * current HP/mana/stamina pools and emits the deltas.
 *
 * `healBlocked` refuses the healing half (a `heal_block` status: the holder
 * cannot be healed by anybody else). `drainRecipient` is where a drained
 * resource goes when the effect says `drain_to: caster` — and who a
 * `drain_percent_of_damage` effect heals. `phaseMultiplier` is the action's
 * hour-of-the-day value: it scales every magnitude here, but the caster's
 * output boost only reaches healing and regeneration.
 */
export function applyEffectResources(
    unit: CombatUnit,
    effect: AttackEffect,
    random: CombatRandom,
    outputMultiplier = 1,
    options: {
        healBlocked?: boolean;
        drainRecipient?: CombatUnit | null;
        /** Who a `resource_transfer` clause pays from (the acting caster). */
        transferSource?: CombatUnit | null;
        phaseMultiplier?: number;
        /** Direct damage the hit dealt, for a `drain_percent_of_damage` effect. */
        damageDealt?: number;
        /** Element of the skill that carried the effect (drives the target's modulation). */
        sourceElementId?: string | null;
    } = {},
): CombatEvent[] {
    const events: CombatEvent[] = [];
    const record = asRecord(effect) ?? {};
    const phase = options.phaseMultiplier ?? 1;
    // The holder's own statuses (Wet, Fog, …) scale every magnitude of the
    // incoming element: attacks, flat effects, heals and drains alike.
    const elementScale = elementModulationFor(
        unit,
        readString(effect.element_id, '') || options.sourceElementId || null,
    );

    const flatDamage = readNumber(effect.damage, 0);
    if (flatDamage > 0) {
        const variance = readVariance(effect.damage_variance) ?? [1, 1];
        const amount = Math.max(1, Math.round(
            flatDamage * phase * elementScale * (variance[0] + random() * (variance[1] - variance[0])),
        ));
        const sourceId = options.transferSource?.id ?? effect.effect_id;
        if (!captureRuneReturn(
            unit,
            amount,
            'damage',
            sourceId,
            readString(effect.element_id, '') || options.sourceElementId || null,
        )) {
            events.push(...changeResource(unit, 'hp', -amount));
            recordRuneDamage(unit, amount);
            events.push(...interruptChantOnDamage(unit, random));
        }
    }

    // A percentage drain pays the caster back out of the hit it just landed.
    // The damage already carries its own hour-of-day value, so it is not
    // multiplied by the phase again.
    const drainPercent = clamp(readNumber(record.drain_percent_of_damage, 0), 0, 1);
    if (drainPercent > 0 && options.drainRecipient) {
        const drained = Math.round(Math.max(0, options.damageDealt ?? 0) * drainPercent);
        if (drained > 0) events.push(...changeResource(options.drainRecipient, 'hp', drained));
    }

    // A siphon authored as a share of the victim's *maximum* pool
    // (`life_drain`, `mana_drain`) pays the caster that share directly.
    const maxDrain = readDrainPercentOfMaxHp(record.drain_percent_of_max_hp);
    if (maxDrain && options.drainRecipient) {
        const stats = effectiveStats(unit);
        const max = maxDrain.resource === 'mana' ? stats.maxMana : stats.maxHp;
        const amount = Math.round(max * maxDrain.percent / 100 * outputMultiplier * phase * elementScale);
        if (amount > 0) {
            events.push(...changeResource(options.drainRecipient, maxDrain.resource, amount));
        }
    }

    // Healing and regen are the holder's *own* output, so a weapon like the
    // Asclepius Wand boosts them; damage and drain are not touched by it.
    const heal = readNumber(record.heal, 0);
    let healed = false;
    if (heal > 0 && !options.healBlocked) {
        const amount = Math.round(heal * outputMultiplier * phase * elementScale);
        if (amount > 0) {
            if (!captureRuneReturn(
                unit,
                amount,
                'heal',
                options.transferSource?.id ?? unit.id,
                readString(effect.element_id, '') || options.sourceElementId || null,
            )) {
                events.push(...changeResource(unit, 'hp', amount));
            }
            healed = true;
        }
    }

    // A heal authored as a percent of the holder's max HP (`dew`). The holder's
    // *current* maxima read, so endurance buffs scale the water bead.
    const healPercentOfMax = Math.max(0, readNumber(record.heal_percent_of_max, 0));
    if (healPercentOfMax > 0 && !options.healBlocked) {
        const maxHp = effectiveStats(unit).maxHp;
        const amount = Math.round(maxHp * healPercentOfMax / 100 * outputMultiplier * phase * elementScale);
        if (amount > 0 && !captureRuneReturn(
            unit,
            amount,
            'heal',
            options.transferSource?.id ?? unit.id,
            readString(effect.element_id, '') || options.sourceElementId || null,
        )) {
            events.push(...changeResource(unit, 'hp', amount));
        }
        if (amount > 0) healed = true;
    }

    // A one-shot pool restore as percents of the holder's own maxima
    // (`water_spring` refills 20% of the target's mana).
    if (record.resource_regen_percent_of_max) {
        for (const [resource, value] of Object.entries(record.resource_regen_percent_of_max)) {
            const percent = readNumber(value, 0);
            if (percent <= 0) continue;

            const max = resource === 'hp'
                ? effectiveStats(unit).maxHp
                : resource === 'mana'
                    ? effectiveStats(unit).maxMana
                    : effectiveStats(unit).maxStamina;
            if (resource === 'hp' && options.healBlocked) continue;

            const amount = Math.round(max * Math.min(100, percent) / 100 * outputMultiplier * phase * elementScale);
            if (amount > 0) events.push(...changeResource(unit, resource as CombatResourceId, amount));
        }
    }

    // `clear_water` rolls one pool and pays a percent of *its* maximum.
    const randomRegen = asRecord(record.random_resource_regen);
    if (randomRegen) {
        const percent = Math.min(100, Math.max(0, readNumber(randomRegen.percent, 0)));
        if (percent > 0) {
            const stats = effectiveStats(unit);
            const pools = ([
                { resource: 'hp' as CombatResourceId, max: stats.maxHp },
                { resource: 'mana' as CombatResourceId, max: stats.maxMana },
                { resource: 'stamina' as CombatResourceId, max: stats.maxStamina },
            ]).filter((pool) => !(pool.resource === 'hp' && options.healBlocked));
            const pool = pools[Math.min(pools.length - 1, Math.floor(random() * pools.length))];
            const amount = Math.round(pool.max * percent / 100 * outputMultiplier * phase * elementScale);
            if (amount > 0) events.push(...changeResource(unit, pool.resource, amount));
        }
    }

    if (effect.resource_regen) {
        for (const [resource, value] of Object.entries(effect.resource_regen)) {
            const amount = readNumber(value, 0);
            const blocked = resource === 'hp' && options.healBlocked;
            if (blocked) continue;
            if (amount > 0) events.push(...changeResource(unit, resource as CombatResourceId, Math.round(amount * outputMultiplier * phase * elementScale)));
            else if (amount !== 0) events.push(...changeResource(unit, resource as CombatResourceId, Math.round(amount * phase * elementScale)));
        }
    }

    if (effect.resource_drain) {
        const toCaster = readString(record.drain_to, '') === 'caster';
        const recipient = toCaster ? options.drainRecipient ?? null : null;

        for (const [resource, value] of Object.entries(effect.resource_drain)) {
            const amount = Math.round(readNumber(value, 0) * phase * elementScale);
            if (amount === 0) continue;

            events.push(...changeResource(unit, resource as CombatResourceId, -amount));

            if (recipient && amount > 0) {
                events.push(...changeResource(recipient, resource as CombatResourceId, amount));
            }
        }
    }

    // A `resource_transfer` (the Vis recall family) moves a fixed amount from
    // the caster's own pool into the holder's. Nothing is conjured: the caster
    // only pays what the holder can actually absorb, and never more than the
    // caster has left — the exactness of the amount is the clause's contract,
    // so no hour, weather or element scaling touches it.
    const transfer = readResourceTransferSpec(record.resource_transfer);
    if (transfer && options.transferSource && options.transferSource.id !== unit.id) {
        // A transferred HP point is an incoming heal like any other.
        const blocked = transfer.resource === 'hp' && options.healBlocked;
        if (!blocked) {
            const stats = effectiveStats(unit);
            const max = transfer.resource === 'hp' ? stats.maxHp
                : transfer.resource === 'mana' ? stats.maxMana
                    : stats.maxStamina;
            const current = transfer.resource === 'hp' ? unit.currentHp
                : transfer.resource === 'mana' ? unit.currentMana
                    : unit.currentStamina;
            const source = options.transferSource;
            const sourceCurrent = transfer.resource === 'hp' ? source.currentHp
                : transfer.resource === 'mana' ? source.currentMana
                    : source.currentStamina;
            const received = Math.min(transfer.amount, max - current, sourceCurrent);
            if (received > 0) {
                events.push(...changeResource(unit, transfer.resource, received));
                events.push(...changeResource(source, transfer.resource, -received));
            }
        }
    }

    // A one-shot restore of whichever of MN/SN is at the lower percentage
    // (`sunlight_sap`, `group_sap`).
    const lowestPercent = Math.max(0, readNumber(record.regen_lowest_percent, 0));
    if (lowestPercent > 0) {
        const stats = effectiveStats(unit);
        const manaFraction = stats.maxMana > 0 ? unit.currentMana / stats.maxMana : 0;
        const staminaFraction = stats.maxStamina > 0 ? unit.currentStamina / stats.maxStamina : 0;
        const resource = manaFraction <= staminaFraction ? 'mana' : 'stamina';
        const max = resource === 'mana' ? stats.maxMana : stats.maxStamina;
        const amount = Math.round(max * lowestPercent / 100 * outputMultiplier * phase * elementScale);
        if (amount > 0) events.push(...changeResource(unit, resource, amount));
    }

    // `flore` cleanses a negative status each time its bearer receives a
    // Florere heal, up to its authored trigger count.
    if (healed) {
        for (const active of [...unit.effects]) {
            const cleanse = active.cleanseOnHeal;
            if (!cleanse) continue;
            if (cleanse.element && cleanse.element !== options.sourceElementId) continue;
            if (cleanse.triggers >= cleanse.maxTriggers) continue;
            events.push(...cleanseEffects(unit, { count: cleanse.count }));
            cleanse.triggers += 1;
            if (cleanse.triggers >= cleanse.maxTriggers) {
                unit.effects = unit.effects.filter((effect) => effect !== active);
                events.push({ type: 'effect_expired', unitId: unit.id, effectId: active.effectId });
            }
        }
    }

    return events;
}

/** Total healing an effect will produce, used to label an action as a heal. */
export function effectHeals(effect: AttackEffect): boolean {
    const record = asRecord(effect) ?? {};
    if (readNumber(record.heal, 0) > 0) return true;
    if (readNumber(record.heal_percent_of_max, 0) > 0) return true;
    if (readNumber(effect.resource_regen?.hp, 0) > 0) return true;
    for (const value of Object.values(record.resource_regen_percent_of_max ?? {})) {
        if (readNumber(value, 0) > 0) return true;
    }
    if (readNumber(asRecord(record.random_resource_regen)?.percent, 0) > 0) return true;
    if (readNumber(asRecord(record.random_resource_regen_per_turn)?.percent, 0) > 0) return true;
    if (readResourceTransferSpec(record.resource_transfer)?.resource === 'hp') return true;
    return false;
}

/**
 * Revives a defeated unit at a percentage of its maximum HP.
 *
 * A living unit is left untouched, so a mis-aimed revive cannot be used to top
 * somebody up. Returns the resource feedback the caller logs.
 */
export function reviveUnit(unit: CombatUnit, hpPercent: number): CombatEvent[] {
    if (unit.status === 'alive') return [];

    const maxHp = effectiveStats(unit).maxHp;
    const restored = Math.max(1, Math.round((maxHp * clamp(hpPercent, 1, 100)) / 100));

    unit.status = 'alive';
    unit.defending = false;

    return changeResource(unit, 'hp', restored);
}

/**
 * Removes every live status from a unit.
 *
 * Returns one `effect_expired` per status, matching `tickUnitEffects`, so the log
 * reads the same whether a status ended by time or by a cleanse.
 */
export function clearUnitEffects(unit: CombatUnit): CombatEvent[] {
    const events: CombatEvent[] = unit.effects.map((effect) => ({
        type: 'effect_expired',
        unitId: unit.id,
        effectId: effect.effectId,
    }));

    unit.effects = [];
    return events;
}

/**
 * Removes the negative statuses of a unit — the curses, not the gifts.
 *
 * `count` removes at most that many, oldest first; `all` removes every one of
 * them. A `neutral` control status is never touched: a cleanse must not
 * silently delete a stun its own caster is subject to.
 */
export function cleanseEffects(
    unit: CombatUnit,
    options: { count?: number; all?: boolean; damageOverTimeOnly?: boolean } = {},
): CombatEvent[] {
    const removable = unit.effects.filter((effect) => (
        effect.polarity === 'negative'
        && (!options.damageOverTimeOnly || effect.damagePerTurn > 0)
    ));
    const chosen = options.all
        ? removable
        : removable.slice(0, Math.max(0, Math.floor(options.count ?? 0)));

    if (chosen.length === 0) return [];

    const chosenIds = new Set(chosen.map((effect) => effect.effectId));
    unit.effects = unit.effects.filter((effect) => !chosenIds.has(effect.effectId));

    return chosen.map((effect) => ({
        type: 'effect_expired',
        unitId: unit.id,
        effectId: effect.effectId,
    }));
}

/**
 * Removes the positive statuses of a unit — the gifts, not the curses.
 *
 * `count` removes at most that many, oldest first; `all` removes every one of
 * them. `statusId` is the surgical option: it removes that one status, whatever
 * its polarity, and ignores the counts.
 */
export function dispelEffects(
    unit: CombatUnit,
    options: { count?: number; all?: boolean; statusId?: string } = {},
): CombatEvent[] {
    if (options.statusId) {
        const target = unit.effects.find(
            (effect) => effect.effectId === options.statusId || effect.statusEffect === options.statusId,
        );
        if (!target) return [];

        unit.effects = unit.effects.filter((effect) => effect !== target);
        return [{ type: 'effect_expired', unitId: unit.id, effectId: target.effectId }];
    }

    const removable = unit.effects.filter((effect) => effect.polarity === 'positive');
    const chosen = options.all
        ? removable
        : removable.slice(0, Math.max(0, Math.floor(options.count ?? 0)));

    if (chosen.length === 0) return [];

    const chosenIds = new Set(chosen.map((effect) => effect.effectId));
    unit.effects = unit.effects.filter((effect) => !chosenIds.has(effect.effectId));

    return chosen.map((effect) => ({
        type: 'effect_expired',
        unitId: unit.id,
        effectId: effect.effectId,
    }));
}

/** Whether a unit is blocked from being healed by anybody else. */
export function isHealBlocked(unit: CombatUnit): boolean {
    return unit.effects.some((effect) => effect.healBlock);
}

/** Whether a unit may not use skills. */
export function areSkillsPrevented(unit: CombatUnit): boolean {
    return unit.effects.some((effect) => effect.preventSkills);
}

/** Whether a unit cannot be chosen as a target. */
export function isUntargetable(unit: CombatUnit): boolean {
    return unit.effects.some((effect) => effect.untargetable);
}

/** Whether a unit reflects the next hit it takes. */
export function hasCounter(unit: CombatUnit): boolean {
    return unit.effects.some((effect) => effect.counter);
}

/**
 * Extra damage a unit's live statuses grant against a wounded target.
 *
 * Effects such as Ruthless Hunt or Blood Moon carry the same
 * `bonus_vs_hp_below` spec a skill does; the strongest applicable one wins.
 */
export function bonusVsHpBelowFromEffects(unit: CombatUnit, hpFraction: number): number {
    let best = 1;

    for (const effect of unit.effects) {
        const spec = effect.bonusVsHpBelow;
        if (!spec) continue;
        if (hpFraction < spec.threshold) best = Math.max(best, spec.multiplier);
    }

    return best;
}

/** Chance (`0…1`) that confusion turns the unit's hostile action on its own side. */
export function confusionChance(unit: CombatUnit): number {
    let chance = 0;

    for (const effect of unit.effects) {
        if (effect.confuse) chance = Math.max(chance, effect.confusionChance ?? 0.5);
    }

    return chance;
}

/** Lifts every status that says a Lux attack can remove it. */
export function liftLuxCurses(unit: CombatUnit): CombatEvent[] {
    const lifted = unit.effects.filter((effect) => effect.removableByLux);
    if (lifted.length === 0) return [];

    unit.effects = unit.effects.filter((effect) => !effect.removableByLux);

    return lifted.map((effect) => ({
        type: 'effect_expired',
        unitId: unit.id,
        effectId: effect.effectId,
    }));
}

/**
 * Lifts every status the unit marks as expiring on a hit of `elementId`.
 *
 * The Wet conditions: ignis wipes the moisture off. This runs after a real
 * hit lands and reports one `effect_expired` per vanished status so the log
 * can narrate it.
 */
export function expireStatusesOnElementHit(
    unit: CombatUnit,
    elementId: string | null,
): CombatEvent[] {
    if (!elementId) return [];
    const wanted = elementId.trim().toLowerCase();
    if (!wanted) return [];

    const lifted = unit.effects.filter(
        (effect) => effect.expireOnElements?.some((entry) => entry.toLowerCase() === wanted),
    );
    const events: CombatEvent[] = lifted.map((effect) => ({
        type: 'effect_expired',
        unitId: unit.id,
        effectId: effect.effectId,
    }));
    if (lifted.length > 0) {
        const liftedIds = new Set(lifted.map((effect) => effect.effectId));
        unit.effects = unit.effects.filter((effect) => !liftedIds.has(effect.effectId));
    }

    // A stack status can also be washed down rather than removed outright
    // (`overheat` loses one stack to aqua/caeli).
    for (const effect of [...unit.effects]) {
        const amount = effect.washOnElements?.[wanted] ?? 0;
        if (amount <= 0) continue;
        effect.stacks = Math.max(0, effect.stacks - amount);
        if (effect.stacks <= 0) {
            unit.effects = unit.effects.filter((entry) => entry !== effect);
            events.push({ type: 'effect_expired', unitId: unit.id, effectId: effect.effectId });
        }
    }

    return events;
}

/**
 * The multiplier a unit's statuses impose on incoming damage of `damageType`
 * (`frost_mirror` halves physical while it lives). Compounds multiplicatively.
 */
export function damageChannelModulationFor(
    unit: CombatUnit | null | undefined,
    damageType: 'physical' | 'magical' | null | undefined,
): number {
    if (!unit || !damageType) return 1;
    let modulation = 1;

    for (const effect of unit.effects) {
        if (!effect.damageChannelModulation) continue;
        const factor = effect.damageChannelModulation[damageType];
        if (typeof factor === 'number' && Number.isFinite(factor)) modulation *= factor;
    }

    return modulation;
}

/**
 * Fires the unit's field traps as it acts: a `thin_ice` status rolls its slip
 * chance when the bearer performs a matching action, pays its damage and may
 * plant a punishment status (`Slipped`).
 */
export function applyActionTriggers(
    _state: { units: readonly CombatUnit[] },
    actor: CombatUnit,
    action: CombatAction,
    random: CombatRandom,
): CombatEvent[] {
    const events: CombatEvent[] = [];
    const spent: CombatEffectInstance[] = [];

    for (const effect of actor.effects) {
        const trap = effect.tripOnAction;
        if (!trap) continue;
        if (!trapActionsMatch(trap.actions, action.kind)) continue;
        if (trap.damageTypes?.length && !trap.damageTypes.includes(action.damageType)) continue;
        if (trap.maxTriggers !== null && trap.maxTriggers !== undefined
            && (trap.triggers ?? 0) >= trap.maxTriggers) {
            spent.push(effect);
            continue;
        }
        if (trap.chance < 1 && random() >= trap.chance) continue;

        if (trap.damage > 0) {
            events.push(...changeResource(actor, 'hp', -trap.damage));
        }

        if (trap.spawn && actor.status === 'alive'
            && !isImmuneToStatus(actor, trap.spawn.statusEffect ?? trap.spawn.effectId)) {
            const synthetic: AttackEffect = {
                effect_id: trap.spawn.effectId,
                status_effect: trap.spawn.statusEffect ?? '',
                turns: trap.spawn.turns,
                polarity: 'negative',
                ...(trap.spawn.preventActions ? { prevent_actions: trap.spawn.preventActions } : {}),
                ...(trap.spawn.debuff ? { debuff: trap.spawn.debuff as unknown as Record<string, number> } : {}),
            };
            const spawned = createEffectInstance(synthetic, effect.sourceId, effect.elementId, 1, 1, random);
            if (trap.spawn.canStack) {
                spawned.canStack = true;
                spawned.stacks = Math.max(1, trap.spawn.stacking?.initial ?? 1);
                const holder = actor.effects.find((active) => (
                    active.statusEffect
                    && spawned.statusEffect
                    && active.statusEffect.toLowerCase() === spawned.statusEffect.toLowerCase()
                ));
                if (holder) {
                    holder.stacks = Math.max(1, holder.stacks) + spawned.stacks;
                    if (spawned.turns !== null) {
                        const extend = trap.spawn.stacking?.extendTurns ?? 0;
                        holder.turns = Math.max(holder.turns ?? 0, spawned.turns) + extend;
                    }
                } else {
                    actor.effects.push(spawned);
                }
            } else {
                actor.effects.push(spawned);
            }
        }

        trap.triggers = (trap.triggers ?? 0) + 1;
        if (trap.maxTriggers !== null && trap.maxTriggers !== undefined
            && trap.triggers >= trap.maxTriggers) {
            spent.push(effect);
        }
    }

    if (spent.length > 0) {
        actor.effects = actor.effects.filter((effect) => !spent.includes(effect));
        for (const effect of spent) {
            events.push({ type: 'effect_expired', unitId: actor.id, effectId: effect.effectId });
        }
    }

    return events;
}

/** Renders whether an action kind matches a trap's authored action list. */
function trapActionsMatch(actions: readonly string[], kind: CombatAction['kind']): boolean {
    if (actions.includes(kind)) return true;
    const offensive = kind === 'skill' || kind === 'weapon';
    return offensive && actions.includes('attack');
}

/**
 * Fires the unit's live spend triggers: a `hangover` status charges its
 * bearer whenever it pays mana or stamina out, feeding the status's source.
 *
 * Called once per cost payment that actually spent a pool — one skill use is
 * one trigger, whatever mixture of mana and stamina its price was.
 */
export function applySpendTriggers(
    state: { units: readonly CombatUnit[] },
    unit: CombatUnit,
    spend: Partial<Record<CombatResourceId, number>> = {},
): CombatEvent[] {
    const events: CombatEvent[] = [];
    const consumed: CombatEffectInstance[] = [];

    for (const effect of unit.effects) {
        const trigger = effect.spendTrigger;
        if (trigger) {
            if (trigger.damage > 0) {
                events.push(...changeResource(unit, 'hp', -trigger.damage));
            }
            if (trigger.healToSource > 0) {
                const source = state.units.find((candidate) => candidate.id === effect.sourceId);
                if (source && source.status === 'alive') {
                    events.push(...changeResource(source, 'hp', trigger.healToSource));
                }
            }
        }

        const steal = effect.spendSteal;
        if (steal) {
            const spent = Math.max(0, spend[steal.resource] ?? 0);
            if (spent > 0) {
                const source = state.units.find((candidate) => candidate.id === effect.sourceId);
                if (source && source.status === 'alive') {
                    const wanted = steal.amount > 0
                        ? steal.amount
                        : Math.round(spent * steal.percent);
                    const amount = steal.max > 0
                        ? Math.min(steal.max, wanted)
                        : wanted;
                    if (amount > 0) {
                        events.push(...changeResource(source, steal.resource, amount));
                    }
                }
                // A stolen spend is a one-shot debt: the status is spent.
                consumed.push(effect);
            }
        }
    }

    if (consumed.length > 0) {
        unit.effects = unit.effects.filter((effect) => !consumed.includes(effect));
        for (const effect of consumed) {
            events.push({ type: 'effect_expired', unitId: unit.id, effectId: effect.effectId });
        }
    }

    return events;
}

/**
 * Damage channels a status shields its holder from.
 *
 * A live `damage_immunities` effect (`divine_protection`) makes the holder
 * immune to the named channel while the effect lasts; the immunity dies with
 * the effect.
 */
export function isImmuneToDamageType(unit: CombatUnit, damageType: DamageType): boolean {
    return unit.effects.some(
        (effect) => effect.damageImmunities?.includes(damageType) ?? false,
    );
}

/** The focus status — a `locks_target` effect — that is live on the unit. */
export function grantedLockEffect(unit: CombatUnit): CombatEffectInstance | null {
    return unit.effects.find((effect) => effect.locksTarget) ?? null;
}

/**
 * The unit id the holder is currently locked onto, or `null` when unlocked.
 *
 * The lock is grown, not cast: a fresh focus status has no target yet, and the
 * first enemy a damaging action reaches claims it. The claim is remembered on
 * the unit, validated here against the status that caused it, so a renewed
 * buff keeps the same foe in focus and an expired one releases it.
 */
export function liveTargetLockId(unit: CombatUnit): string | null {
    const lock = grantedLockEffect(unit);
    if (!lock || unit.lockedByEffectId !== lock.effectId) return null;

    return unit.lockedTargetId ?? null;
}

/** Pins the holder's focus onto a target when the status has none yet. */
export function claimTargetLock(unit: CombatUnit, targetId: string): void {
    const lock = grantedLockEffect(unit);
    if (!lock || unit.lockedByEffectId === lock.effectId) return;

    unit.lockedTargetId = targetId;
    unit.lockedByEffectId = lock.effectId;
}

/**
 * Inverts the holder's gift statuses: each buff becomes an equal debuff and
 * the status turns into a curse (`Solar Exorcism`).
 *
 * The inversion survives the effect's own turns, so a wasted buff hurts for as
 * long as it had left to live — and a cleanse can now take it off.
 */
export function invertBuffsOn(unit: CombatUnit): CombatEvent[] {
    const events: CombatEvent[] = [];

    for (const effect of unit.effects) {
        if (effect.polarity !== 'positive') continue;
        if (!effect.buff && !effect.debuff) continue;

        const buff = effect.debuff;
        const debuff = effect.buff;
        effect.buff = buff;
        effect.debuff = debuff;
        effect.polarity = 'negative';
        events.push({
            type: 'effect_applied',
            unitId: unit.id,
            effectId: effect.effectId,
            statusEffect: effect.statusEffect,
            turns: effect.turns,
        });
    }

    return events;
}
