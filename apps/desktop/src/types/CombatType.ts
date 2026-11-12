/**
 * Types for the turn-based combat system.
 *
 * Two groups — `allies` and `enemies` — each deploy up to two battle lines,
 * `front` and `rear`. Damage, targeting, positioning and turn order are all
 * derived from this vocabulary, so it is shared by the services that own the
 * rules and by the presentation layer (`components/game/combat`).
 *
 * `front`/`rear` deliberately match `CombatFormationLaneId` so a `CombatState`
 * can be rendered by the formation HUD without a translation step.
 */

import type { AttackEffect, PublicAttack } from './AttackDataType';
import type { CombatAbilityInstance } from './AbilityType';
import type { AiProfile } from './AiType';
import type { Difficulty } from '../constants/DifficultyConstants';
import type { EntitiesData, WeaponEntry } from './EntityDataType';
import type { WeaponActionSpec, WeaponRuntimeState, WeaponStatDelta } from './WeaponType';

/** Which side of the battlefield a unit fights for. */
export type CombatSide = 'allies' | 'enemies';

/** Battle line. `front` trades blows; `rear` supports from a distance. */
export type CombatLine = 'front' | 'rear';

/** Damage channel. Picks the attack/defence stats a hit reads. */
export type DamageType = 'physical' | 'magical';

/**
 * Reach of an action.
 *
 * `short` cannot be used from the rear line and cannot reach the enemy rear
 * line; `medium` and `long` are unrestricted.
 */
export type CombatRange = 'short' | 'medium' | 'long';

export type CombatUnitStatus = 'alive' | 'defeated';

export type CombatPhase = 'active' | 'finished';

export type CombatOutcome = 'victory' | 'defeat' | 'fled';

export type CombatResourceId = 'hp' | 'mana' | 'stamina';

/**
 * Effective statistics of a combatant, in camelCase.
 *
 * The YAML catalogues name these in snake_case; {@link CombatStatDelta} keeps
 * the authored spelling so a buff can be copied straight from a skill file.
 */
export interface CombatStats {
    maxHp: number;
    maxMana: number;
    maxStamina: number;
    physicalAttack: number;
    magicalAttack: number;
    physicalDefense: number;
    magicalDefense: number;
    speed: number;
    /**
     * Outgoing accuracy modifier, in points.
     *
     * It changes how well the unit's *own* attacks land; it never makes the
     * unit easier to hit. The default `0` is a modifier, not a percentage: the
     * authored chance to hit lives on the action.
     */
    accuracy: number;
    /**
     * Incoming evasion modifier, in points.
     *
     * It makes the unit harder to hit — the mirror of {@link accuracy}.
     */
    evasion: number;
    /** Outgoing critical chance, in percent. */
    critChance: number;
}

/** A flat addition to a stat block, as authored in a skill `buff`/`debuff`. */
export interface CombatStatDelta {
    hp?: number;
    mana?: number;
    stamina?: number;
    physical_attack?: number;
    magical_attack?: number;
    physical_defense?: number;
    magical_defense?: number;
    speed?: number;
    accuracy?: number;
    evasion?: number;
    crit_chance?: number;
}

/**
 * How a status reads to the units that clean or dispel it.
 *
 * `positive` is a gift, `negative` a curse, `neutral` a control status that
 * only an explicit status id removes.
 */
export type CombatEffectPolarity = 'positive' | 'negative' | 'neutral';

/** Where a status moves its bearer, as authored by a `move` effect. */
export interface CombatMoveSpec {
    /** `self` moves the caster, `target` moves the unit the effect landed on. */
    who: 'self' | 'target';
    /** Destination line; `other` means "the line the bearer is not in". */
    toLine: 'front' | 'rear' | 'other';
    /** Trades places with the caster instead of just stepping across. */
    swapWithCaster: boolean;
}

/** How far back a `rewind` pulls its target, and what it restores. */
export interface CombatRewindSpec {
    /** How many of the target's own turns to undo; `null` means all of them. */
    turns: number | null;
    /** Which pools are restored. Empty means every pool. */
    resources: Array<'hp' | 'mana' | 'stamina'>;
    /** Whether the statuses of the rewound turns are undone too. */
    cleanse: boolean;
}

/**
 * One snapshot of a unit's past, kept so a `rewind` can undo it.
 *
 * The timeline is the unit's own: it records what it had at the start of each
 * of its turns, so rewinding is "go back to how things were N turns ago".
 */
export interface CombatTimelineEntry {
    /** The unit's turn count when the snapshot was taken. */
    turn: number;
    hp: number;
    mana: number;
    stamina: number;
    /** The statuses the unit carried at that moment. */
    effects: CombatEffectInstance[];
}

/** One live status effect on a unit. */
export interface CombatEffectInstance {
    effectId: string;
    /** Id of the action that applied the effect. */
    sourceId: string;
    /** Authored label (`Frozen`, `Wet`, …), or `null` for a pure stat change. */
    statusEffect: string | null;
    elementId: string | null;
    /** Remaining turns; `null` means "until combat ends". */
    turns: number | null;
    /** The authored `apply_to` scope, kept for display. */
    applyTo: string | null;
    /** Stat increases while the effect is live. */
    buff: CombatStatDelta | null;
    /** Stat decreases while the effect is live. */
    debuff: CombatStatDelta | null;
    /**
     * Stat multipliers while the effect is live (`{ physical_attack: 1.4 }`).
     *
     * Folded in after the flat buffs/debuffs, so `add_status` can express the
     * reference schema's `mode: multiply` without a second effect type.
     */
    statMultipliers: CombatStatDelta | null;
    /**
     * How the status reads to a cleanse or a dispel.
     *
     * Derived from the effect body (a debuff or a damage-over-time reads as
     * `negative`, a buff as `positive`), and overridable by the author.
     */
    polarity: CombatEffectPolarity;
    /** Resources the holder regains on each of the effect's turns. */
    regenPerTurn: CombatStatDelta | null;
    /** Resources the holder pays on each of the effect's turns. */
    selfUpkeep: CombatStatDelta | null;
    /** Health the holder pays on the turn after the effect lands. */
    deferredCost: CombatStatDelta | null;
    /** Status ids the holder cannot suffer while the effect lives. */
    immunities: string[] | null;
    /** Action kinds the effect forbids (`silenced` blocks attacks). */
    preventActions: string[] | null;
    /** The holder may not use skills while the effect lives. */
    preventSkills: boolean;
    /** The holder cannot be chosen as a target while the effect lives. */
    untargetable: boolean;
    /** The holder cannot be healed by anybody else while the effect lives. */
    healBlock: boolean;
    /** The holder reflects the next hit it takes. */
    counter: boolean;
    /** How many turns the effect shifts the holder's place in the order. */
    turnOffset: number;
    /** How many cooldown turns the effect takes off the holder's actions. */
    cooldownTick: number;
    /** Where the effect moves its bearer. */
    move: CombatMoveSpec | null;
    /** How far back the effect rewinds its bearer. */
    rewind: CombatRewindSpec | null;
    /** Flat damage the effect deals to its owner at the start of its turn. */
    damagePerTurn: number;
    /** Variance rolled on each damage-over-time tick (`[min,max]`), if any. */
    damagePerTurnVariance?: [number, number] | null;
    /** Heals the holder whenever any unit on the battlefield falls. */
    healOnKill?: { flat: number; percent: number } | null;
    /** The holder may turn a hostile action on its own side. */
    confuse?: boolean;
    /** Chance (`0…1`) a confused holder's hostile action turns on its allies. */
    confusionChance?: number;
    /** Extra damage against targets below a fraction of their health. */
    bonusVsHpBelow?: { threshold: number; multiplier: number } | null;
    /** The status is lifted when a Lux attack hits the holder. */
    removableByLux?: boolean;
    /**
     * When this effect is live on the unit, the first enemy a damaging action
     * reaches becomes the unit's only legal target (`Keen Focus`).
     */
    locksTarget?: boolean;
    /** Damage channels the holder is immune to while the effect lives. */
    damageImmunities?: DamageType[] | null;
    /**
     * Element effectiveness multipliers the status imposes on incoming
     * actions and effects, keyed by element id (`Wet` reads `ignis: 0.25`,
     * `aqua: 2` — ignis skills on the bearer quarter in strength, aqua and
     * chaos skills double, be they attacks, buffs, debuffs or heals).
     *
     * Compounds multiplicatively when several modulation statuses overlap.
     */
    elementModulation?: Record<string, number> | null;
    /** Elements whose attacks lift this status the moment they hit (`Wet` vs ignis). */
    expireOnElements?: string[] | null;
    /**
     * Max-HP fraction the status grants as a damage shield, as a percent
     * (`12` = 12% of the holder's max HP). `0`/absent when it carries none.
     */
    shieldPercentOfMaxHp?: number;
    /** Health the status currently shields; replenished only on (re)application. */
    shieldRemaining?: number;
    /** Statuses the holder sheds on each of the effect's own turns (`Rain`). */
    cleansePerTurn?: { count: number; polarity: CombatEffectPolarity | 'any' } | null;
    /** Pool maxima the status regenerates each turn, as percents (`hp: 10` = 10%/turn). */
    regenPerTurnPercent?: CombatStatDelta | null;
    /**
     * Percent of one random pool maximum the holder regains each of the
     * effect's turns (`Cleansing Rain`); absent/`0` when it carries none.
     */
    randomRegenPerTurnPercent?: number;
    /**
     * One-shot heal as a percent of the holder's max HP (`Dew` restores 8%);
     * absent/`0` when the status carries none.
     */
    healPercentOfMax?: number;
    /**
     * Falls on its bearer when it spends mana or stamina, healing the status's
     * source (`Hangover` charges the spender and pays the caster).
     */
    spendTrigger?: { damage: number; healToSource: number } | null;
    /**
     * Charge stacking (`Freezing`): each landing charge raises `stacks` on the
     * shared status and refreshes its turns; when the count reaches
     * {@link chargeMax}, the status is spent and its `chargeRelease` status
     * (a `Frozen` miss) lands instead.
     */
    chargeMax?: number;
    chargeRelease?: { statusEffect: string; turns: number; effectId: string; preventActions: string[] | null; debuff: CombatStatDelta | null } | null;
    /**
     * Hit chance the shield rolls against each incoming hit (`ice_shield`
     * rolls 60%); `1`/absent always absorbs. A missed roll passes the hit
     * straight through to the bearer.
     */
    shieldHitChance?: number;
    /** Total hits the shield soaks before breaking (`glacial_wall` absorbs 2). */
    shieldMaxHits?: number;
    /** Hits the shield has left before it breaks. */
    shieldHitsRemaining?: number;
    /** Chance the status reflects the next hit (`frost_mirror` rolls 50%). */
    counterChance?: number;
    /** Elements the counter refuses to reflect; the hit just passes through. */
    counterExceptElements?: string[] | null;
    /** Incoming damage multipliers per channel (`frost_mirror` halves physical). */
    damageChannelModulation?: Record<string, number> | null;
    /** Stat fields the holder cannot gain buffs to (`permafrost` blocks speed). */
    blockStatBuffs?: string[] | null;
    /** Damage channels the holder may not use while the status lives (`ice_shield`). */
    preventDamageChannels?: DamageType[] | null;
    /** Fields the hold has: kinds that may trip the holder (`thin_ice`). */
    tripOnAction?: {
        actions: string[];
        damageTypes?: string[] | null;
        chance: number;
        damage: number;
        spawn: { statusEffect: string; effectId: string; turns: number; debuff: CombatStatDelta | null; preventActions?: string[] | null; stacking?: { initial: number; extendTurns: number } | null; canStack?: boolean } | null;
        maxTriggers?: number | null;
        triggers?: number;
        expireDamage?: number;
    } | null;
    /** How many copies are stacked; `1` when the effect does not stack. */
    stacks: number;
    canStack: boolean;
    /**
     * Boundary expiry rather than turn counting (`expires`): `turn_start` drops
     * the status the moment its holder's next turn begins, `round_end` when the
     * round wraps. `null`/absent counts `turns` normally.
     */
    expiresMode?: 'turn_start' | 'turn_end' | 'round_end' | null;
    /** While live, the holder may switch lanes without spending its turn (`Cloudstep`). */
    laneChangeFree?: boolean;
    /** Move the holder fires by itself when an attack misses them (`Zephyr Veil`). */
    onMissMove?: (CombatMoveSpec & { breakAfter?: boolean }) | null;
    /**
     * Outgoing effect-strength multipliers by element id while the status lives
     * (`Gale Resonance` boosts the bearer's caeli effects by ×1.15). Folded into
     * the output multiplier of every effect the bearer lands.
     */
    elementPower?: Record<string, number> | null;
    /**
     * Accuracy the holder's projectile hits gain (`Skyline Sight` +12). The
     * bonus only reaches actions that read as projectiles, and `vsLine` narrows
     * it to one defender lane (`Tailwind Trajectory` aims at the rear).
     */
    projectileAccuracy?: { amount: number; vsLine: 'front' | 'rear' | null } | null;
    /**
     * Accuracy every attacker gains against the marked holder, as long as the
     * incoming action is a projectile (`Crosswind Mark` +15).
     */
    projectileMark?: { accuracy: number } | null;
    /**
     * Flat evasion the holder gains against ranged actions (`Ranged Veil` +15):
     * thrown/long-reach weapons and spells (magical damage).
     */
    rangedEvasion?: number;
    /**
     * The holder may re-roll its first missed projectile shot each of its turns
     * (`Second Chance`); `used` tracks how often it fired since the last reset.
     */
    projectileReroll?: { perTurn: number; used: number } | null;
    /** A mark that detonates when the bearer's turn arrives. */
    detonateOnTurn?: CombatDetonateOnTurnSpec | null;
    /** A mark that adds damage when another chaos hit lands and can spread. */
    chainDetonation?: CombatChainDetonationSpec | null;
    /** Conducts electric hits and can be grounded by Lapis. */
    conductor?: CombatConductorSpec | null;
    /** Chance to interrupt the bearer's next matching action. */
    interrupt?: CombatInterruptSpec | null;
    /** Flat damage thrown back at an attacker. */
    reflect?: CombatReflectSpec | null;
    /** Steals part of the bearer's next resource spend for the status source. */
    spendSteal?: CombatSpendStealSpec | null;
    /** A one-shot dodge plus riposte against a matching damage channel. */
    evadeNext?: {
        damageTypes: DamageType[] | null;
        power: number;
        chance: number;
        directOnly: boolean;
        returnToFreeLane: boolean;
    } | null;
    /** Redirects damage aimed at protected allies onto this unit. */
    damageRedirect?: { scope: 'allies_all' | 'allies_lane' } | null;
    /** Multipliers the bearer applies to its own action costs. */
    costMultiplier?: { mana?: number; stamina?: number } | null;
    /** Price paid when the status ends (stamina, HP covering the shortfall). */
    endCost?: { resource: CombatResourceId; percentOfMax: number; shortfall: 'hp' } | null;
    /** Direct-damage retaliation when the bearer falls. */
    onDeathBlast?: { power: number } | null;
    /** Chance the bearer refuses any new status before it lands (mud seals). */
    statusResistChance?: number;
    /** Multiplier applied to buff/debuff magnitudes landing on the bearer. */
    effectMagnitudeMultiplier?: number;
    /** Reach bands the holder cannot use (`buried`). */
    preventRanges?: Array<'short' | 'medium' | 'long'> | null;
    /** Elements the holder cannot use (`buried`). */
    preventElements?: string[] | null;
    /** Reach bands that cannot target the holder. */
    untargetableRanges?: Array<'short' | 'medium' | 'long'> | null;
    /** Elements whose actions cannot target the holder. */
    untargetableElements?: string[] | null;
    /** A wall that only breaks to crit/super-effective hits or expiry. */
    barrier?: { breakOnCrit: boolean; breakOnSuperEffective: boolean } | null;
    /** Single-target attacks must be aimed at this bearer when possible. */
    taunt?: boolean;
    /** Extra critical damage taken (`fossil` +20% = 0.2). */
    critDamageTaken?: number;
    /** A shield that soaks a number of hits with a break chance. */
    intercept?: CombatInterceptSpec | null;
    /** The status shatters into a bleed when hit by the named channel. */
    shatterOnDamageType?: CombatShatterSpec | null;
    /** Marks the status as petrify-family. */
    petrifyClass?: boolean;
    /** When this status expires, the bearer hardens into another status. */
    fossilizeOnExpiry?: CombatFossilizeSpec | null;
    /** Flat damage paid when this status expires. */
    onExpiryDamage?: { power: number; scope: 'self' | 'all' } | null;
    /** Merge repeated landings into one stack status. */
    mergeOnApply?: boolean;
    /** Extra turns added when a landing merges into the existing stack. */
    extendOnApply?: number;
    /** When `damagePerTurn` is paid (`turn_end` for Burn). */
    damageTiming?: 'turn_start' | 'turn_end';
    /** Stacks shed on each start-of-turn tick (`fuel`). */
    decayPerTurn?: number;
    /** Stacks gained at the end of the bearer's own turn (`overheat`). */
    turnEndStacks?: number;
    /** Chance to catch Burn at the end of the bearer's turn. */
    turnEndBurn?: { chance: number; burnStacks: number; burnTurns: number } | null;
    /** Lowers Overheat's burst threshold. */
    burstThresholdDown?: number;
    /** Per-stack cost tax (`overheat`). */
    perStackCost?: number;
    /** Per-stack regeneration loss (`overheat`). */
    perStackRegenReduction?: number;
    /** Stack threshold at which the status bursts. */
    burstAt?: number;
    /** Burst payload (`overheat`). */
    burst?: {
        damage: number;
        burnStacks: number;
        burnTurns: number;
        pdefPercent: number;
        turns: number;
    } | null;
    /** Stack loss on matching element hits (`overheat` vs aqua/caeli). */
    washOnElements?: Record<string, number> | null;
    /** Elements that light a Burn when they hit (`fuel`). */
    igniteOnHit?: { elements: string[]; burnStacks: number; burnTurns: number } | null;
    /** Chance to light the attacker when it strikes (`furnace_ward`). */
    igniteAttackerOnHit?: {
        damageTypes: string[] | null;
        chance: number;
        burnStacks: number;
        burnTurns: number;
    } | null;
    /** Fire-wall damage reductions for the protected side. */
    fireWall?: {
        rangedWeapon: number;
        projectile: number;
        physical: number;
        erodeElements: string[] | null;
        noErode: boolean;
    } | null;
    /** Outgoing damage multipliers by element. */
    elementDamage?: Record<string, number> | null;
    /** Projectile/ranged actions treated as this element. */
    projectileElement?: string | null;
    /** Removes only damage-over-time effects. */
    cleanseDot?: number;
    /** Extra HoT per negative status on the bearer. */
    regenBonusPerNegative?: number;
    /** Extra HoT per 10% of max HP currently drained by DoTs. */
    regenBonusPerDotPercent?: number;
    /** One-shot healing of the lower of mana/stamina, as a percent. */
    regenLowestPercent?: number;
    /** Refunds part of the resources spent while the status was live. */
    refundSpent?: {
        percent: number;
        resources: string[];
        baseline: { mana: number; stamina: number };
    } | null;
    /** Cleanse on receiving a heal of the named element. */
    cleanseOnHeal?: { count: number; element: string; maxTriggers: number; triggers: number } | null;
    /** Flat damage reduction with charges (`pollen_ward`). */
    damageReduction?: { percent: number; charges: number; healAdjacentPercent: number } | null;
    /** Drains a percent of a max pool on hit. */
    drainPercentOfMaxHp?: { percent: number; resource: 'hp' | 'mana'; to: 'caster' } | null;
    /** Drains a percent of a max pool at the start of each turn. */
    drainPerTurn?: { resource: 'hp' | 'mana'; percentOfMax: number; chance: number; healToSource: boolean } | null;
    /** The bearer cannot be moved by forced movement. */
    movementImmunity?: boolean;
    /** Restores the holder at the start of each of its turns while the status lives. */
    rewindEachTurn?: CombatRewindSpec | null;
    /** Turns added/removed from other statuses when this one lands. */
    shiftOtherEffects?: {
        turns: number;
        direction: 'shorten' | 'extend';
        polarity: 'positive' | 'negative' | 'any';
    } | null;
    /** Turns the holder's stamina recovery is delayed. */
    fatigueRecoveryDelay?: number;
    /** Time suspension: skipped turns, invulnerability or deferred harm. */
    suspend?: {
        invulnerable: boolean;
        deferDamage: boolean;
        deferStatuses: boolean;
        freezeCooldowns: boolean;
        freezeEffects: boolean;
        deferredDamage: number;
        deferredStatuses: Array<{
            effect: AttackEffect;
            sourceId: string;
            elementId: string | null;
            outputMultiplier: number;
            phaseMultiplier: number;
        }>;
    } | null;
    /** Cancels the holder's next action. */
    anchor?: { cancelActions: boolean } | null;
    /** Records part of the holder's incoming damage into a delayed echo. */
    echoMark?: {
        percent: number;
        maxPercent: number | null;
        addPercentPerHit: number;
        resolve: 'turn_end' | 'caster_next_turn' | 'deferred';
        delayTurns: number;
        deferStatuses: boolean;
        canCrit: boolean;
        cap: number | null;
        pending: number;
        currentPercent: number;
        recorded: number;
        readyTurn: number | null;
    } | null;
    /** A bonus the holder's next matching action consumes. */
    nextActionBonus?: {
        element: string | null;
        accuracy: number;
        cooldown: number;
        charges: number;
    } | null;
    /** A gravity zone that slows and traps its holder. */
    gravityZone?: {
        speedPerTurn: number;
        pull: boolean;
        preventExit: boolean;
        epicenterHits: boolean;
        ignoreEvasion: boolean;
        endsOnCasterInterrupt: boolean;
    } | null;
    /** A delayed cascading strike through the bearer's lane. */
    riftMark?: { power: number; cascade: number } | null;
    /** A rescue rune: the next defeat leaves the bearer at 1 HP (`rune_of_survival`). */
    rescueRune?: {
        hpPercent: number;
        manaPercent: number;
        staminaPercent: number;
    } | null;
    /** A rune that banks incoming damage and converts it when it expires. */
    runeStore?: {
        mode: 'memory' | 'convert';
        capPercent: number;
        conversionPercent: number;
        outputCapPercent: number | null;
        healOrDamage: boolean;
        stored: number;
    } | null;
    /** A rune that stores the first incoming swing and returns it at expiry. */
    runeReturn?: {
        percent: number;
        payment: { mana: number; stamina: number };
        stored: number;
        storedKind: 'damage' | 'heal' | 'status' | null;
        storedSourceId: string | null;
        storedElement: string | null;
        storedEffect: AttackEffect | null;
    } | null;
    /** A channeled chant: charges build each turn and release on expiry. */
    chant?: {
        maxCharges: number;
        damagePerCharge: number;
        elementMode: 'fixed' | 'random';
        randomElements: string[];
        interruptChance: number;
        payHp: number;
        payMana: number;
        scope: 'one' | 'lane' | 'all';
        charges: number;
        targetId: string | null;
        element: string | null;
    } | null;
    /** A resurrection link: when the caster falls, the bearer falls too. */
    fateLink?: { casterId: string } | null;
    /** Turn count when the status landed, used by detonations to scale. */
    appliedTurnCount?: number;
}

/** Remaining cooldown, in turns, keyed by action id. */
export type CombatCooldowns = Record<string, number>;

/** A living participant. Combat is simulated by mutating these. */
export interface CombatUnit {
    /** Unique within one combat, e.g. `allies_front_0_arthur`. */
    id: string;
    /** Catalogue id of the entity the unit was built from. */
    entityId: string;
    /** Which catalogue `entityId` names, so the view can resolve the unit's sprites. */
    entityType: CombatEntityType;
    name: string;
    side: CombatSide;
    line: CombatLine;
    /** Index within its own lane, used to stack the sprites in the HUD. */
    slot: number;
    isPlayerControlled: boolean;
    status: CombatUnitStatus;
    elementIds: string[];
    stats: CombatStats;
    currentHp: number;
    currentMana: number;
    currentStamina: number;
    /** How many times each trigger event has fired for this unit (`event_count`). */
    eventCounts: Record<string, number>;
    /** Free-form values recorded by `set_flag` and read by a `flag` condition. */
    flags: Record<string, unknown>;
    actions: CombatAction[];
    effects: CombatEffectInstance[];
    /** Abilities authored on the entity, with their per-fight state. */
    abilities: CombatAbilityInstance[];
    /**
     * The unit's resolved AI personality (weights, thresholds, targeting).
     *
     * Always present — a unit with no authored `ai:` block carries the balanced
     * default — so the decider never has to guess. Serialisable, like `abilities`.
     */
    aiProfile: AiProfile;
    /**
     * Damage channels the unit is immune to.
     *
     * Kept apart from `effects` because immunity is read by the damage chain
     * itself (a folded multiplier), not by `effectiveStats`.
     */
    immunities: DamageType[];
    /** How many of this unit's own turns have elapsed (`turn_count`). */
    turnCount: number;
    /** Consecutive turns each resource went unspent — drives the idle regen curve. */
    resourceIdleTurns: Record<Exclude<CombatResourceId, 'hp'>, number>;
    /** Whether each resource was paid out of since this unit's last turn began. */
    resourceSpentSinceTurnStart: Record<Exclude<CombatResourceId, 'hp'>, boolean>;
    cooldowns: CombatCooldowns;
    /** Set by the `defend` action; reduces incoming damage and adds evasion until the next turn. */
    defending: boolean;
    /**
     * The unit a `locks_target` status nailed down, once a hit shows who.
     *
     * `null`/absent means the buff has not met a target yet; the first enemy a
     * damaging action reaches while the buff lives becomes the locked one.
     * {@link lockedByEffectId} names the status that made the lock, so a read
     * verifies the status is still there instead of trusting stale state.
     */
    lockedTargetId?: string | null;
    lockedByEffectId?: string | null;
    /**
     * The equipped weapon's mutable state (durability, ammo, passive modifiers),
     * or `null` for a unit with no weapon. Cloned per unit; the action list is
     * shared, so per-holder state lives here rather than on the action.
     *
     * Always the `state` of the carried weapon that is equipped.
     */
    weapon: WeaponRuntimeState | null;
    /**
     * Every weapon the unit carries into the fight, equipped or not.
     *
     * Each entry keeps its own durability and ammo, so a weapon swapped out
     * mid-fight comes back with the wear it already took.
     */
    carriedWeapons: CarriedWeapon[];
    /**
     * The unit's recent past, one snapshot per turn.
     *
     * A `rewind` reads it to put the unit back the way it was, so the mechanic
     * needs no separate undo log.
     */
    timeline: CombatTimelineEntry[];
}

/**
 * One weapon a unit carries, with the pieces that become live when it is equipped.
 *
 * `actions`, `stats` and `abilities` are what equipping adds to the unit; `state`
 * is the holder's own durability and ammo for it.
 */
export interface CarriedWeapon {
    weaponId: string;
    state: WeaponRuntimeState;
    /** The weapon's swing (and throw) actions, added to the unit while equipped. */
    actions: CombatAction[];
    /** Stat modifiers applied while equipped. */
    stats: WeaponStatDelta | null;
    /** Passives merged into the unit while equipped. */
    abilities: CombatAbilityInstance[];
}

/** How a unit chooses what an action hits. */
export type CombatTargetRule =
    /**
     * One unit chosen from everybody in the battle — allies, enemies and the
     * actor itself. The frontend lists every living unit as a legal target.
     */
    | 'any_one'
    | 'enemies_all'
    | 'allies_all'
    | 'self'
    | 'both_teams'
    /**
     * Aimed at one enemy; the hit addresses the whole lane: every living unit
     * of the aim's side standing in the aim's line (`avalanche`).
     */
    | 'enemies_lane';

export type CombatActionKind =
    | 'skill'
    | 'weapon'
    | 'defend'
    | 'rest'
    | 'flee'
    | 'inventory'
    | 'switch_line';

export interface CombatRecoilSpec {
    hp: number;
    fractionOfDamage: number;
}

export interface CombatFriendlyFireSpec {
    damage: number;
    percentOfPower: number;
    chance: number;
    scope: 'allies_all' | 'allies_lane';
}

export interface CombatBacklaneSplashSpec {
    chance: number;
    power: number;
    percentOfDamage: number;
    both: boolean;
}

export interface CombatChainSpec {
    chance: number;
    chanceStep: number;
    minChance: number;
    jumps: number;
    powerPercent: number;
    accuracy: number | null;
    includeAllies: boolean;
    weightedBacklane: boolean;
    prioritizeStatus: string | null;
    stunChance: number;
    branches: number;
}

export interface CombatShrapnelSpec {
    count: number;
    power: number;
    accuracy: number | null;
    includeAllies: boolean;
    focusStatus: string | null;
}

export interface CombatInstabilitySpec {
    status: string;
    max: number;
    damagePerCharge: number;
    variancePerCharge: number;
    selfDamage: number;
    selfDamageChance: number;
    turns: number;
}

export interface CombatOnKillDetonationSpec {
    power: number;
    includeAllies: boolean;
}

export interface CombatDetonateOnTurnSpec {
    power: number;
    scalePerTurn: number;
    maxPower: number | null;
    includeLine: boolean;
    splashChance: number;
    turnSkipChance: number;
}

export interface CombatChainDetonationSpec {
    power: number;
    recoilPerTarget: number;
}

export interface CombatConductorSpec {
    jumpPower: number;
    groundedByElements: string[] | null;
    groundShieldPercent: number;
}

export interface CombatInterruptSpec {
    chance: number;
    actions: string[] | null;
}

export interface CombatReflectSpec {
    power: number;
    chance: number;
    consume: boolean;
    /** Reflects left before the status falls; omitted means unlimited. */
    charges?: number;
    /** Damage channels accepted; omitted means any. */
    damageTypes: DamageType[] | null;
    /** Fraction of the incoming hit thrown back instead of the flat power. */
    percentOfDamage: number;
    /** Elements that strike the bearer instead of being reflected. */
    exceptElements: string[] | null;
    /** Extra multiplier applied to an excepted element's hit. */
    exceptionMultiplier: number;
    /** The status breaks when an excepted element hits. */
    exceptionBreaks: boolean;
}

export interface CombatInterceptSpec {
    hits: number;
    breakChance: number;
}

export interface CombatShatterSpec {
    damageType: DamageType;
    statusEffect: string;
    turns: number;
    damagePerTurn: number;
}

export interface CombatFossilizeSpec {
    statusEffect: string;
    turns: number;
    debuff: CombatStatDelta | null;
    critDamageTaken: number;
    preventActions: string[] | null;
    preventRanges: Array<'short' | 'medium' | 'long'> | null;
    preventElements: string[] | null;
    breakPower: number;
}

export interface CombatAftershockSpec {
    power: number;
    minTurns: number;
    maxTurns: number;
}

export interface CombatShuffleSpec {
    chance: number;
    laneChance: number;
}

export interface CombatSpendStealSpec {
    resource: 'mana' | 'stamina';
    percent: number;
    amount: number;
    max: number;
}

export interface CombatActionCost {
    mana: number;
    stamina: number;
    /** Health the action takes from its own user. */
    hp: number;
    /** Extra health cost as a percent of the user's maximum HP (blood prices). */
    hpPercentMax?: number;
    /** Turns the action stays unavailable after use. */
    cooldown: number;
}

/** A ready-to-use action, derived from a skill, a weapon or the universal list. */
export interface CombatAction {
    id: string;
    kind: CombatActionKind;
    name: string;
    description: string;
    elementId: string;
    /** SFX track id played when the action is used; `null` falls back to the element sound. */
    sfxId?: string | null;
    damageType: DamageType;
    range: CombatRange;
    /** Authored power; `0` for actions that only heal or buff. */
    power: number;
    /** Hit chance as a percentage (`100` always hits). */
    accuracy: number;
    hitCount: number;
    /**
     * `true` turns `hitCount` into independent rays instead of repeated hits on
     * one target: each ray picks its own random living enemy and rolls its own
     * accuracy. The same unit may be picked several times.
     */
    scatterTargets: boolean;
    /** Number of scatter rays; `null` falls back to {@link hitCount}. */
    scatterHits: number | null;
    /** Scatter rays may pick any living enemy, ignoring reach and lane rules. */
    canHitAnyEnemy: boolean;
    /** The lane (front/rear) damage multiplier is skipped (`×1`). */
    ignorePositionPenalty: boolean;
    costs: CombatActionCost;
    targeting: CombatTargetRule;
    effects: AttackEffect[];
    /** Multiplier range applied to each hit, e.g. `[0.8, 1.2]`. */
    damageVariance: [number, number] | null;
    /** `true` when the action deals direct damage. */
    dealsDamage: boolean;
    /** `true` when the action restores HP through an effect. */
    heals: boolean;
    /**
     * Per-swing weapon mechanics, when the action came from a weapon.
     *
     * Absent for skills and universal movements, so a weapon-only rule (extra
     * accuracy by range, exponential stacking, ammo) never fires on a skill.
     */
    weapon?: WeaponActionSpec;
    /**
     * The action is worth its full strength by day and fades to a quarter of it
     * at night (`SOLAR_NIGHT_MULTIPLIER`).
     *
     * The flag is on the action, not on the effect, because a solar skill is
     * solar in every part of itself.
     */
    solar: boolean;
    /** The mirror of {@link solar}: full strength at night, a quarter by day. */
    lunar: boolean;
    /** The action only works while the sun is up. */
    onlyDuringDay?: boolean;
    /** The action only works while the sun is down. */
    onlyDuringNight?: boolean;
    /** Base chance of a critical hit, in percent. */
    critChance: number;
    /** The hit always lands, whatever the accuracy roll would say. */
    ignoreAccuracy: boolean;
    /** Fraction of the target's defence the hit ignores (0 … 1). */
    defensePierce: number;
    /** Extra multipliers per element of the defender. */
    bonusVsElements: Record<string, number>;
    /** Extra multiplier against a target below a fraction of its health. */
    bonusVsHpBelow: { threshold: number; multiplier: number } | null;
    /** Health fraction below which the target panics and flees the fight. */
    fleeBelowHp: number | null;
    /** The status that guarantees a critical hit against its bearer. */
    guaranteedCritVsStatus: string | null;
    /**
     * Extra numbers against a target carrying a named status by id or label
     * (`hydro_lance` pierces 5% deeper into a wet target, snow_ball hits a
     * Frozen target harder). Every matching entry folds in.
     */
    bonusVsStatus?: Array<{ status: string; multiplier: number; defensePierce: number }> | null;
    /**
     * Splash the action throws onto the target's adjacent living compatriots:
     * every adjacent unit in the main target's line (excluding the aimed
     * targets) takes a reduced copy of the hit (`riptide`).
     */
    collateral?: {
        damageMultiplier: number;
        /** Chance the splash goes off at all (`1`/absent = always). */
        chance: number;
        includePrimaryTargets: boolean;
        includeCaster: boolean;
    } | null;
    /**
     * Bonus per charge a bearing target holds of a stacking status, consumed
     * when the hit resolves (`avalanche` spends Freeze charges for damage).
     */
    bonusPerCharge?: { status: string; multiplierPerCharge: number; consume: boolean } | null;
    /**
     * Adds `power = power + perPoint × stat` to every hit, read straight off
     * the caster's live stats (`Tempest Flurry` scales with speed). Previews
     * share the same chain, so they stay in sync. `null`/absent keeps `power`.
     */
    powerScaling?: { stat: keyof CombatStats; perPoint: number } | null;
    /**
     * Multiplier a critical hit uses instead of the global ×1.75
     * (`Meteor Drop` doubles on crit). `null`/absent keeps the default.
     */
    critMultiplier?: number | null;
    /** Health the caster pays for a reckless action. */
    recoil?: CombatRecoilSpec | null;
    /** Splash a reckless action throws onto the caster's own allies. */
    friendlyFire?: CombatFriendlyFireSpec | null;
    /** A chance the blast clips the enemy rear line as well. */
    backlaneSplash?: CombatBacklaneSplashSpec | null;
    /** Fraction of the hit the caster takes back when the target line has no room. */
    noSpaceRecoil?: { fraction: number } | null;
    /** Serial chain lightning / forks. */
    chain?: CombatChainSpec | null;
    /** Low-accuracy shrapnel thrown after the main blast. */
    shrapnel?: CombatShrapnelSpec | null;
    /** Charges that build on the caster and make the next explosive unstable. */
    instability?: CombatInstabilitySpec | null;
    /** Flat damage dealt when a control effect is resisted. */
    controlImmuneDamage?: number;
    /** A secondary blast when the action defeats a target. */
    onKillDetonation?: CombatOnKillDetonationSpec | null;
    /** Cuts the caster's own cooldowns when a hit target carries a status. */
    cooldownReset?: { status: string; amount: number } | null;
    /** Adds accumulated damage taken to the hit's power (`retaliation`). */
    damageTakenScaling?: { perPoint: number; max?: number } | null;
    /** Weak/resist multiplier applied after normal element effectiveness. */
    elementEffectiveness?: { weak: number; resist: number } | null;
    /** Named stacking statuses consumed for burst damage or healing. */
    consumeStacks?: Array<{
        status: string;
        perStack: number;
        ignoreDefense: boolean;
        healPercentPerStack: number;
    }> | null;
    /** Schedules a battlefield-wide aftershock after a random delay (`tremor`). */
    aftershock?: CombatAftershockSpec | null;
    /** Shuffles the struck side's lane positions (`earthquake`). */
    shufflePositions?: CombatShuffleSpec | null;
    /** The hit ignores the defender's Evasion and ordinary dodge statuses. */
    ignoreEvasion?: boolean;
    /** The hit can never critically strike. */
    cannotCrit?: boolean;
    /** The hit fizzles when the target changes position before resolution. */
    failIfTargetMoves?: boolean;
    /** Fraction of the cost paid when the target-moved clause fizzles. */
    failCostFraction?: number;
    /** Extra damage multiplier while the caster is in the front line. */
    frontLaneBonus?: number;
    /** Extra damage per lane of distance between caster and target. */
    distanceScaling?: { perLane: number; maxLanes: number } | null;
    /** Cascading damage through an `enemies_lane` strike. */
    laneCascade?: { first: number; subsequent: number } | null;
    /** Extra multiplier against a target already unable to change lanes. */
    bonusVsImmobile?: number;
    /** Share of the hit added to a pending echo. */
    echoBurst?: { percent: number } | null;
    /** Restores a defeated ally instead of resolving an ordinary attack (`oath_of_return`). */
    resurrect?: {
        hpPercent: number;
        manaPercent: number;
        staminaPercent: number;
    } | null;
    /** The action's damage cannot be saved by a rescue rune. */
    ignoreRescue?: boolean;
    /** The action opens the two-mode `rune_of_fate` choice. */
    runeFate?: boolean;
}

/**Damage-channel modifiers folded from a defender's passive abilities.
 *
 * `multiplier` scales the damage (a big slime's gelatinous body leaves 10% of a
 * physical hit); `immune` voids it outright (`fire_cloak`). Both the real hit and
 * the HUD preview read the same value, so they can never disagree.
 */
export interface AttackModifier {
    /** Multiplier applied to the damage (`1` = unchanged). */
    multiplier: number;
    /** `true` when an ability makes the defender immune to the hit. */
    immune: boolean;
}

/**
 *  Everything the HUD needs to render one action slot for the active unit. */
export interface CombatActionPreview {
    action: CombatAction;
    usable: boolean;
    /** Why the action is unusable; `null` when `usable` is `true`. */
    reason: CombatErrorCode | null;
    /** Unit ids the action may be aimed at (empty for untargeted rules). */
    targetIds: string[];
}

/**
 * What one action would do to one target, worked out without rolling randomness.
 *
 * Backs the target preview: `hpDelta` is signed, so a positive number is health
 * the target stands to lose and a negative one is health it would gain back.
 * `elementMultiplier` is what turns the preview into an effectiveness reading.
 */
export interface CombatActionImpact {
    /** Health the target loses (positive) or gains (negative). */
    hpDelta: number;
    /** Which direction the health moves, so the HUD can colour the number. */
    kind: 'damage' | 'heal';
    /** `true` for previews, which never roll accuracy. */
    isHit: boolean;
    /** Hits counted (`1` for previews). */
    hits: number;
    /** Attack stat the action read from the attacker. */
    attackValue: number;
    /** Ability multiplier folded from the target's passive abilities (`1` = none). */
    attackMultiplier: number;
    /** `true` when an ability made the target immune to the hit. */
    immune: boolean;
    /** Defence stat the action read from the defender. */
    defenseValue: number;
    /** Authored power. */
    power: number;
    /** Damage channel the action uses. */
    damageType: DamageType;
    /** Efficacy of the action's element against this target (`x0` … `x1.6`). */
    elementMultiplier: number;
    /** Variance multiplier (`1` for previews, which do not roll). */
    variance: number;
    /** Lane modifier applied (`1`, `0.85` or `0.8`). */
    positionModifier: number;
    /** Reduction from the target bracing (`0` or `DEFEND_DAMAGE_REDUCTION`). */
    defenseReduction: number;
    /** One hit before the lane, bracing and variance steps. */
    baseDamage: number;
    /** Rounded damage applied across every hit. */
    finalDamage: number;
    /** Chance of a critical hit, in percent. */
    critChance: number;
    /** Chance of the hit landing, in percent (0 … 100). */
    hitChance: number;
}

/** Damage breakdown for one attacker/target pair. */
export interface AttackResolution {
    attackerId: string;
    targetId: string;
    actionId: string;
    /** `false` when every hit missed. */
    isHit: boolean;    /** Ability multiplier folded from the target's passive abilities (`1` = none). */
    attackMultiplier: number;
    /** `true` when an ability made the target immune to the hit. */
    immune: boolean;    /** How many hits landed. */
    hits: number;
    /** Attack stat the action read from the attacker. */
    attackValue: number;
    /** Defence stat the action read from the defender. */
    defenseValue: number;
    /** Authored power. */
    power: number;
    /** Damage channel the action used. */
    damageType: DamageType;
    /** Element efficacy taken from the shared element matrix. */
    elementMultiplier: number;
    /** Variance multiplier rolled for this action. */
    variance: number;
    /** Lane modifier (1, 0.85 or 0.8). */
    positionModifier: number;
    /** Damage reduction from the target bracing (0 when it is not). */
    defenseReduction: number;
    /** One hit before the lane, bracing and variance steps. */
    baseDamage: number;
    /** Final damage applied across every hit. */
    finalDamage: number;
    /** Damage the target's shields absorbed (`0` for unshielded targets). */
    shielded: number;
    /** Chance of a critical hit, in percent. */
    critChance: number;
    /** `true` when at least one of the hits was critical. */
    isCrit: boolean;
    /** Chance of a hit landing, in percent. */
    hitChance: number;
    /** Target HP before the hit. */
    targetHpBefore: number;
    /** Target HP after the hit. */
    targetHpAfter: number;
    /** Status effects that were applied. */
    appliedEffectIds: string[];
}

/** Healing applied by one action to one target. */
export interface HealResolution {
    sourceId: string;
    targetId: string;
    actionId: string;
    amount: number;
    targetHpAfter: number;
}

/** A typed feedback message the presentation layer can animate. */
export type CombatEvent =
    | { type: 'combat_started'; round: number; order: string[] }
    | { type: 'turn_started'; unitId: string; round: number }
    | {
        type: 'action_used';
        actorId: string;
        actionId: string;
        actionName: string;
        kind: CombatActionKind;
        targetIds: string[];
        elementId?: string | null;
        sfxId?: string | null;
    }
    | { type: 'attack_resolved'; resolution: AttackResolution }
    | { type: 'healed'; resolution: HealResolution }
    | {
        type: 'effect_applied';
        unitId: string;
        effectId: string;
        statusEffect: string | null;
        turns: number | null;
    }
    | { type: 'effect_expired'; unitId: string; effectId: string }
    /** A status the target could not suffer, because it is immune to it. */
    | { type: 'effect_resisted'; unitId: string; effectId: string; statusEffect: string | null; captured?: boolean }
    /**
     * A unit was rewound: its resources went back to what they were, and the
     * statuses of the rewound turns were undone.
     */
    | {
        type: 'unit_rewound';
        unitId: string;
        /** How many of the unit's turns were undone. */
        turns: number;
        restoredHp: number;
        restoredMana: number;
        restoredStamina: number;
        /** Statuses the rewind removed. */
        removedEffectIds: string[];
    }
    | { type: 'flee_attempted'; unitId: string; escaped: boolean }
    | {
        type: 'resource_changed';
        unitId: string;
        resource: CombatResourceId;
        previous: number;
        next: number;
    }
    | { type: 'unit_defeated'; unitId: string }
    | { type: 'unit_revived'; unitId: string; casterId: string }
    /** A living rear-line unit stepped into its side's emptied front line. */
    | { type: 'unit_line_changed'; unitId: string; line: CombatLine; slot: number }
    /** A skill pushed the unit's next turn back through the queue mid-round. */
    | { type: 'action_postponed'; unitId: string; slots: number }
    /** A skill raised a battlefield-wide weather state (`Rain`, `Storm`). */
    | { type: 'weather_changed'; id: string; label: string; rounds: number }
    /** The weather state faded away. */
    | { type: 'weather_ended'; id: string }
    /** A projectile hit was re-rolled and landed (`Second Chance`). */
    | { type: 'attack_retried'; attackerId: string; targetId: string }
    /** An ability owned by `unitId` satisfied its trigger and condition. */
    | {
        type: 'ability_triggered';
        unitId: string;
        abilityId: string;
        abilityName: string;
        targetIds: string[];
    }
    /** `sourceId` brought `unitId` onto the field (a split or a summon). */
    | {
        type: 'unit_summoned';
        sourceId: string;
        unitId: string;
        entityId: string;
        name: string;
        side: CombatSide;
        line: CombatLine;
        slot: number;
    }
    /** The unit at `unitId` was replaced in place by another entity. */
    | { type: 'unit_transformed'; unitId: string; entityId: string; name: string }
    /** Part of a hit was thrown back at the attacker. */
    | {
        type: 'damage_reflected';
        sourceId: string;
        targetId: string;
        abilityId: string;
        abilityName: string;
        isHit: boolean;
        amount: number;
        targetHpAfter: number;
    }
    /** A status shield absorbed part of a hit; `remaining` is what is left. */
    | {
        type: 'shield_absorbed';
        unitId: string;
        effectId: string;
        amount: number;
        remaining: number;
    }
    /** A unit whose every action was unavailable passed its turn untouched. */
    | { type: 'turn_skipped'; unitId: string }
    /** An anchor mark consumed itself and cancelled the bearer's action. */
    | { type: 'action_cancelled'; unitId: string; actionId: string; effectId: string }
    /** A status was queued by a time suspension instead of landing. */
    | { type: 'effect_deferred'; unitId: string; effectId: string; statusEffect: string | null }
    /** A deferred echo or suspension released its stored damage. */
    | { type: 'damage_deferred'; unitId: string; amount: number; sourceId: string }
    /** A status interrupted the unit's action (`Shock`); costs were still paid. */
    | {
        type: 'action_interrupted';
        unitId: string;
        actionId: string;
        effectId: string;
        statusEffect: string | null;
    }
    | { type: 'turn_ended'; unitId: string }
    /** A weapon on `unitId` lost durability (wear) or was repaired. */
    | {
        type: 'weapon_durability_changed';
        unitId: string;
        weaponId: string;
        previous: number;
        next: number;
    }
    /** A weapon reached 0 durability and was destroyed. */
    | { type: 'weapon_broken'; unitId: string; weaponId: string; weaponName: string }
    /** A unit switched its equipped weapon. Costs no turn. */
    | {
        type: 'weapon_equipped';
        unitId: string;
        weaponId: string;
        weaponName: string;
        previousWeaponId: string | null;
    }
    /** A ranged weapon spent (or kept) a unit of ammunition. */
    | {
        type: 'weapon_ammo_changed';
        unitId: string;
        itemId: string;
        consumed: boolean;
        remaining: number;
    }
    /** A defeated enemy dropped an item (a loot roll, boosted by a weapon). */
    | {
        type: 'loot_gained';
        itemId: string;
        itemName: string;
        quantity: number;
        sourceId: string;
    }
    | { type: 'combat_ended'; outcome: CombatOutcome; reason: string };

/**
 * Speed each unit has banked towards its next turn, keyed by unit id.
 *
 * The remainder left over after a round's turns are handed out carries into the
 * next round, so a speed that does not divide evenly still gets its share
 * (`30` against `20` yields 1 turn, then 2).
 */
export type CombatTurnGauges = Record<string, number>;

/** Whether the sun is up, as the natural hour of the fight. */
export type CombatTimePhase = 'day' | 'night';

/** A celestial body an eclipse can block. */
export type CombatCelestialBlock = 'solar' | 'lunar';

/**
 * The time state the battlefield actually presents.
 *
 * An eclipse blocks its celestial body without changing the natural hour:
 * `day_no_solar` means the sun is blocked (solar eclipse, effective during the
 * day) and `night_no_lunar` means the moon is blocked (lunar eclipse, effective
 * during the night). Damage and effect bonuses read this state; skills that
 * only work during the day/night read the natural {@link CombatTimePhase}.
 */
export type EffectiveCombatTimePhase = CombatTimePhase | 'day_no_solar' | 'night_no_lunar';

/**
 * A battlefield-wide celestial block forced by an eclipse.
 *
 * The block only takes effect when the natural phase matches the body it hides
 * (solar during the day, lunar during the night). While active it suppresses
 * that body's combat bonuses without changing the natural hour.
 */
export interface CombatPhaseOverride {
    /** Which celestial body is blocked. */
    blocked: CombatCelestialBlock;
    /** Full rounds left; the override clears when it reaches zero. */
    rounds: number;
    /** The unit whose action forced the block. */
    sourceId: string;
}

/**
 * A battlefield-wide weather state forced by a skill (`Rain`, `Storm` …).
 *
 * Weather lasts whole rounds, chips the opposing side lightly at every round
 * tick (`chipDamage`), and multiplies the effectiveness of actions/effects of
 * the elements listed in {@link elementEffectMultipliers} — both their damage
 * and their effect magnitudes (`Rain` makes aqua skills stronger and ignis
 * skills weaker).
 */
export interface CombatWeather {
    /** Catalogue id of the skill that raised the weather. */
    id: string;
    /** Display name (`Rain`, `Storm`). */
    label: string;
    /** Which side enjoys the weather; the other one pays the chip damage. */
    side: CombatSide;
    /** Full rounds left; the weather clears when it reaches zero. */
    rounds: number;
    /** Effect/damage multipliers per element id (absent elements read ×1). */
    elementEffectMultipliers: Record<string, number>;
    /** Flat HP the opposing side loses at every round tick. */
    chipDamage: number;
}

/** The serializable shape of a fight. The frontend renders this directly. */
export interface CombatState {
    sessionId: string;
    encounterId: string;
    encounterName: string;
    round: number;
    /** Index into {@link CombatState.order}. */
    turnIndex: number;
    /**
     * The hour of the day the fight happens at.
     *
     * Taken from the world clock when the fight opens, and fixed for its whole
     * duration — the sun does not move while two people are hitting each other.
     */
    hour: number;
    /** The natural phase (sun up/down), derived from {@link CombatState.hour}. */
    timePhase: CombatTimePhase;
    /**
     * A celestial block forced over the battlefield, or `null`.
     *
     * Folded into {@link EffectiveCombatTimePhase} by {@link effectiveTimePhase}
     * when the natural hour matches the blocked body.
     */
    phaseOverride: CombatPhaseOverride | null;
    /**
     * A battlefield-wide weather state (`Rain`, `Storm` …), or `null` for a
     * clear sky. Lasts whole rounds and modulates elements while it holds.
     */
    weather?: CombatWeather | null;
    /** Delayed battlefield-wide aftershocks scheduled by a skill (`tremor`). */
    pendingAftershocks?: Array<{
        sourceId: string;
        power: number;
        rounds: number;
        elementId?: string;
    }>;
    /**
     * Turn queue for the current round, fastest first.
     *
     * A unit that acts several times in a round appears several times, so the
     * queue is rebuilt at every round boundary from the units still standing.
     */
    order: string[];
    /** Speed banked per unit, carried between rounds. */
    turnGauges: CombatTurnGauges;
    units: CombatUnit[];
    phase: CombatPhase;
    outcome: CombatOutcome | null;
    /** Most recent feedback, oldest first, capped while the fight runs. */
    log: CombatEvent[];
}

/** Result of advancing the fight by one action. */
export interface CombatTurnResult {
    state: CombatState;
    /** Only the events produced by this step. */
    events: CombatEvent[];
    outcome: CombatOutcome | null;
}

/** How an encounter member is loaded from the entity catalogues. */
export type CombatEntityType = 'character' | 'mob';

export interface CombatEncounterMember {
    /** File id in `data/entities/characters` or `data/entities/mobs`. */
    entityId: string;
    entityType: CombatEntityType;
    line: CombatLine;
    /** Marks the unit as played by the player rather than the AI. */
    isPlayerControlled?: boolean;
    /** Display override (a "Corrupted Slime" that is still `slime.yaml`). */
    name?: string;
    /** Max-HP override for bosses and scaled encounters. */
    hp?: number;
    /**
     * What this member carries into the fight, item id to quantity.
     *
     * When set, it replaces the entity store as the source of the unit's opening
     * inventory — the Test Playground declares stock per fight this way. When
     * absent, the store (with the entity YAML as first-time fallback) is read.
     */
    inventory?: Record<string, number>;
    /**
     * Catalogue weapon ids the member carries into the fight; the first is equipped.
     *
     * When absent, the entity's own weapon is used. An empty list fights unarmed.
     */
    weapons?: string[];
}

/** An authored fight: who stands where. */
export interface CombatEncounter {
    id: string;
    name: string;
    description?: string;
    /**
     * Forces the phase of the fight, ignoring the world clock's hour.
     *
     * Left out, the fight takes the hour of the day it starts at.
     */
    timePhase?: CombatTimePhase;
    allies: CombatEncounterMember[];
    enemies: CombatEncounterMember[];
}

/** One action request from the HUD. */
export interface CombatActionRequest {
    actionId: string;
    /** Required for `any_one`; ignored otherwise. */
    targetId?: string;
    /** Item id when the action is `inventory`. */
    itemId?: string;
    /** Optional cast mode for actions that offer a choice (`rune_of_fate`). */
    mode?: string;
}

/**
 * Element efficacy lookup, precomputed once per combat.
 *
 * `defenseScores[targetElementId][offensiveElementId]` is the RAW defensive
 * score the shared element matrix gives one target element against one
 * offensive element. Raw scores are stored (not multipliers) so a multi-element
 * defender can sum its elements before the total is mapped once.
 */
export interface CombatElementIndex {
    defenseScores: Record<string, Record<string, number>>;
}

/** Injectable randomness so turns can be replayed deterministically in tests. */
export type CombatRandom = () => number;

/** Stable error codes, safe to branch on in the presentation layer. */
export type CombatErrorCode =
    | 'encounter_not_found'
    | 'encounter_invalid'
    | 'session_not_found'
    | 'session_finished'
    | 'unit_not_found'
    | 'not_your_turn'
    | 'action_not_found'
    | 'action_unavailable'
    | 'flee_unavailable'
    | 'target_required'
    | 'target_invalid'
    | 'out_of_range'
    | 'insufficient_mana'
    | 'insufficient_stamina'
    | 'out_of_ammo'
    | 'action_on_cooldown'
    | 'item_not_found'
    | 'item_not_usable'
    | 'item_not_usable_in_combat'
    | 'item_not_usable_outside_combat'
    | 'insufficient_quantity'
    | 'entity_not_found'
    | 'invalid_quantity'
    | 'inventory_full'
    | 'weapon_not_found'
    | 'weapon_already_equipped'
    | 'weapon_broken'
    | 'not_implemented';

/** A failure the caller can act on. Technical detail stays in the logs. */
export interface CombatError {
    code: CombatErrorCode;
    message: string;
    details?: Record<string, unknown>;
}

/** Discriminated result used instead of throwing across the API boundary. */
export type CombatResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: CombatError };

/** Options accepted when a fight is started. */
export interface StartCombatOptions {
    /** Replaces the encounter file (scripted fights, tests). */
    encounter?: CombatEncounter;
    /** Deterministic randomness. Defaults to `Math.random`. */
    random?: CombatRandom;
    /**
     * The hour of the day the fight happens at.
     *
     * Defaults to the world clock's hour. The fight keeps this hour for its
     * whole duration.
     */
    hour?: number;
    /**
     * Forces the phase, ignoring the hour.
     *
     * For the few fights that happen at a fixed time (a duel under the moon,
     * a test), where the hour itself does not matter.
     */
    timePhase?: CombatTimePhase;
    /**
     * Whether the fight's inventories are written back to the entity store when it
     * ends. On by default, so the game's items survive a battle; the Test
     * Playground turns it off, because its entities exist for one fight only.
     */
    persistInventories?: boolean;
    /**
     * How well the opponents play. Modulates the AI only (noise, switched-off
     * considerations, thresholds), never the combat rules. Defaults to `normal`.
     */
    difficulty?: Difficulty;
}

/** Re-exported so consumers of the combat types need one import. */
export type { EntitiesData, PublicAttack, WeaponEntry };
