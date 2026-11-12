/** Public and source types for the shared skills catalogue and learning trees. */

export interface LearningCost {
    experience_points: number;
}

export interface LearningRequirements {
    required_attack_ids?: string[];
    [key: string]: unknown;
}

/** A resource an effect can pay out or take in. */
export type AttackResourceId = 'hp' | 'mana' | 'stamina';

/** A per-resource amount, as authored by `resource_regen` and friends. */
export type AttackResourceAmounts = Partial<Record<AttackResourceId, number>>;

/**
 * A `resource_transfer` clause: the caster pays a fixed amount out of their
 * own pool and the recipient receives the same — a pure transfer, nothing
 * conjured (the Vis recall family).
 */
export interface AttackResourceTransfer {
    /** The pool the amount is moved through. */
    resource: AttackResourceId;
    /** What moves from the caster to each recipient, before clamping. */
    amount: number;
}

/** Where a `move` effect sends its bearer. */
export interface AttackMoveSpec {
    /** `self` moves the caster, `target` moves whoever the effect landed on. */
    who?: 'self' | 'target';
    /** Destination line; `other` means "the line the bearer is not in". */
    to_line?: 'front' | 'rear' | 'other';
    /** Trades places with the caster instead of just stepping across. */
    swap_with_caster?: boolean;
}

/** Which targets an effect's conditional clause may reach. */
export interface AttackEffectCondition {
    /** Only units that have not acted yet this round. */
    requires_pending?: boolean;
    /** Only units that have already acted this round. */
    requires_acted?: boolean;
    /** Only units standing in the named line. */
    target_line?: 'front' | 'rear';
    /** Only units that cannot be placed in the named line (it is full). */
    requires_no_space?: 'front' | 'rear';
}

/** A `weather` clause: it forces a battlefield-wide weather state. */
export interface AttackWeatherSpec {
    /** Full rounds the weather lasts; omitted means 3. */
    rounds?: number;
    /** Flat HP the opposing side loses at every round tick. */
    chip_damage?: number;
    /** Effect/damage multipliers per element id while the weather holds. */
    element_effect_multipliers?: Record<string, number>;
}

/** A `turn_postpone` clause: it delays the target's next turn mid-round. */
export interface AttackPostponeSpec {
    /** Slots to push the target's next turn back; omitted means 1. */
    slots?: number;
    /** One extra slot per this many points the caster's speed leads the target's. */
    per_speed_advantage?: number;
    /** Gate on the target's state; omitted means always. */
    condition?: AttackEffectCondition;
}

/** A `move` effect that triggers on its own. */
export interface AttackOnMissMoveSpec extends AttackMoveSpec {
    /** Drops the status after the move fires. */
    break_after?: boolean;
}

/** How far back a `rewind` pulls its target, and what it restores. */
export interface AttackRewindSpec {
    /** How many of the target's own turns to undo; omitted means all of them. */
    turns?: number;
    /** Which pools are restored; omitted means every pool. */
    resources?: AttackResourceId[];
    /** Whether the statuses of the rewound turns are undone too. */
    cleanse?: boolean;
}

/** The caster's own price for a reckless action (Chaos detonations). */
export interface AttackRecoilSpec {
    /** Flat health the caster pays. */
    hp?: number;
    /** Fraction of the direct damage dealt that the caster takes back. */
    fraction_of_damage?: number;
}

/** Splash a reckless action throws onto the caster's own side. */
export interface AttackFriendlyFireSpec {
    /** Flat health each ally in scope pays. */
    damage?: number;
    /** Percent of the action's power each ally pays (0 … 1). */
    percent_of_power?: number;
    /** Chance the splash happens at all (defaults to 1). */
    chance?: number;
    /** `allies_all` or the line the main target stands in (defaults to `allies_lane`). */
    scope?: 'allies_all' | 'allies_lane';
}

/** A chance for the blast to clip the enemy rear line as well. */
export interface AttackBacklaneSplashSpec {
    chance: number;
    power: number;
    /** Hit the main target too, on top of the rear-line victim. */
    both?: boolean;
}

/**
 * Serial chain lightning (or a fork).
 *
 * Each jump starts from the previous victim, picks one unit not yet hit,
 * checks its own accuracy and deals `power_percent` of the previous jump.
 * Adjacency is approximated by line: same line first, then the other one.
 */
export interface AttackChainSpec {
    /** Chance the first jump happens (defaults to 1). */
    chance?: number;
    /** Chance lost per jump. */
    chance_step?: number;
    /** Floor for the jump chance. */
    min_chance?: number;
    /** Maximum jumps after the main hit. */
    jumps?: number;
    /** Each jump's power as a fraction of the previous one (defaults to 0.6). */
    power_percent?: number;
    /** Accuracy used by jumps; omitted inherits the action's. */
    accuracy?: number;
    /** Include the caster's own side as chain candidates (`arc_burst`). */
    include_allies?: boolean;
    /** Rear-line candidates weigh 0.8 instead of 1. */
    weighted_backlane?: boolean;
    /** Prefer candidates carrying this status (`Wet` for `forked_lightning`). */
    prioritize_status?: string;
    /** Chance each jump stuns its victim for one turn. */
    stun_chance?: number;
    /** Independent forks from the main target instead of a serial chain. */
    branches?: number;
}

/** Low-accuracy shrapnel thrown after the main blast. */
export interface AttackShrapnelSpec {
    /** Projectiles thrown. */
    count: number;
    /** Flat power of each projectile. */
    power: number;
    /** Hit chance per projectile; omitted inherits the action's accuracy. */
    accuracy?: number;
    /** Shrapnel may pick the caster's allies too. */
    include_allies?: boolean;
    /** Concentrate on the main target while the caster carries this status (`Precision Burst`). */
    focus_status?: string;
}

/** Charges that build on the caster and make the next explosive unstable. */
export interface AttackInstabilitySpec {
    /** Status label used for the charge stack (defaults to `Instability`). */
    status?: string;
    /** Charges that trigger a premature detonation. */
    max?: number;
    /** Extra damage per charge (0.1 = +10%). */
    damage_per_charge?: number;
    /** Extra variance per charge. */
    variance_per_charge?: number;
    /** Health the caster loses when the stack blows up. */
    self_damage?: number;
    /** Chance the stack blows up at its maximum. */
    self_damage_chance?: number;
    /** Turns the charges survive without another explosive. */
    turns?: number;
}

/** A secondary blast when the action defeats a target (`demolition`). */
export interface AttackOnKillDetonationSpec {
    power: number;
    /** Let the secondary blast hit the caster's own line too. */
    include_allies?: boolean;
}

/** A mark that detonates when its bearer's turn arrives. */
export interface AttackDetonateOnTurnSpec {
    /** Base power of the detonation. */
    power: number;
    /** Extra power per turn elapsed since the mark landed. */
    scale_per_turn?: number;
    /** Hard cap for the scaled power. */
    max_power?: number;
    /** The blast also hits everybody else in the bearer's line. */
    include_line?: boolean;
    /** Chance the bearer loses the turn to the detonation. */
    turn_skip_chance?: number;
}

/** `Marked for Detonation`: another chaos hit adds power and can chain marks. */
export interface AttackChainDetonationSpec {
    /** Extra power added to a chaos hit on the bearer. */
    power: number;
    /** Extra health the caster pays for each chained mark. */
    recoil_per_target?: number;
}

/** A conductor that electric hits jump through, and Lapis can ground. */
export interface AttackConductorSpec {
    /** Flat damage an electric hit jumps to the nearest enemy. */
    jump_power: number;
    /** Elements that ground the conductor and remove it (`lapis`). */
    grounded_by_elements?: string[];
    /** Shield percent the grounded conductor grants the nearest ally. */
    ground_shield_percent?: number;
}

/** A status that may interrupt the bearer's next skill. */
export interface AttackInterruptSpec {
    /** Chance (`0…1`) the attempt is interrupted. */
    chance: number;
    /** Action kinds that can be interrupted; omitted means skills and weapons. */
    actions?: string[];
}

/** Flat damage thrown back when the bearer is hit. */
export interface AttackReflectSpec {
    /** Flat damage reflected. */
    power: number;
    /** Chance (`0…1`); omitted means always. */
    chance?: number;
    /** The status is spent by a successful reflection. */
    consume?: boolean;
}

/** A portion of the bearer's next resource spend goes to the status source. */
export interface AttackSpendStealSpec {
    resource: 'mana' | 'stamina';
    /** Fraction of the spend stolen (0 … 1). */
    percent?: number;
    /** Flat cap on the amount stolen. */
    amount?: number;
    /** Hard cap regardless of the fraction. */
    max?: number;
}

export interface AttackEffect {
    effect_id: string;
    /** Omit to inherit the attack's element. */
    element_id?: string;
    status_effect?: string;
    apply_to?: string;
    turns?: number | [number, number];
    effect_hit_chance?: number;
    buff?: Record<string, number>;
    debuff?: Record<string, number>;
    resource_regen?: AttackResourceAmounts;
    resource_drain?: AttackResourceAmounts;
    resource_transfer?: AttackResourceTransfer;
    /** While the effect lives, its holder cannot switch targets. */
    locks_target?: boolean;
    /** Landing the effect inverts the victim's current buffs into debuffs. */
    invert_buffs?: boolean;
    /** Damage channels the holder cannot be hurt by while the effect lives. */
    damage_immunities?: Array<'physical' | 'magical'>;
    /**
     * Heals the caster by this fraction of the direct damage the hit dealt
     * (`0.15` = 15%).
     */
    drain_percent_of_damage?: number;
    /** Blocks lunar combat bonuses while the effect lasts (effective at night). */
    block_lunar?: boolean;
    /** Blocks solar combat bonuses while the effect lasts (effective during the day). */
    block_solar?: boolean;
    /** Rounds the eclipse block lasts; defaults to 5. */
    phase_rounds?: number;
    /** Flat damage the effect deals to its owner at the start of its turn. */
    damage_per_turn?: number;
    /** Variance rolled on each damage-over-time tick (`[min,max]`). */
    damage_variance?: number[];
    /** Heals the caster for this flat amount whenever any unit falls. */
    heal_on_kill?: number;
    /** Heals the caster for this fraction of its max HP whenever any unit falls. */
    heal_on_kill_percent?: number;
    /** The holder's hostile actions may hit its own side. */
    confuse?: boolean;
    /** Chance (`0…1`) the confusion turns an action; defaults to 0.5. */
    confusion_chance?: number;
    /** Extra damage against targets below a fraction of their health. */
    bonus_vs_hp_below?: { threshold: number; multiplier: number };
    /** The status is lifted when a Lux attack hits the holder. */
    removable_by_lux?: boolean;
    /** Lower a random number of random stats; the values fold into `debuff`. */
    random_debuff?: { count?: number; amount?: number; stats?: string[] };
    /** Raise a random number of random stats; the values fold into `buff`. */
    random_buff?: { count?: number; amount?: number; stats?: string[] };
    /** Apply to a random subset of the resolved scope. */
    random_targets?: { min?: number; max?: number };
    damage?: number;
    can_stack?: boolean;
    /** How the status reads to a cleanse (`negative`) or a dispel (`positive`). */
    polarity?: 'positive' | 'negative' | 'neutral';
    /** Removes up to this many negative statuses. */
    cleanse?: number;
    /** Removes every negative status. */
    cleanse_all?: boolean;
    /** Removes up to this many positive statuses. */
    dispel?: number;
    /** Removes every positive status. */
    dispel_all?: boolean;
    /** Removes one named status, whatever its polarity. */
    dispel_status?: string;
    /** Resources the holder regains on each of the effect's turns. */
    regen_per_turn?: AttackResourceAmounts;
    /** Status ids the holder cannot suffer while the effect lives. */
    status_immunities?: string[];
    /** The holder may not use skills. */
    prevent_skills?: boolean;
    /** The holder cannot be chosen as a target. */
    untargetable?: boolean;
    /** The holder cannot be healed by anybody else. */
    heal_block?: boolean;
    /** Damage channels the holder, be it skills or weapons, may not act with. */
    prevent_damage_channels?: Array<'physical' | 'magical'>;
    /** The holder reflects the next hit it takes. */
    counter?: boolean;
    /** How many turns the effect shifts the holder's place in the order. */
    turn_offset?: number;
    /** How many cooldown turns the effect takes off the holder's actions. */
    cooldown_tick?: number;
    /** Where the effect moves its bearer. */
    move?: AttackMoveSpec;
    /** Gate: only units matching the condition receive the effect at all. */
    condition?: AttackEffectCondition;
    /** Delays the target's next turn by one or more slots, once, on landing. */
    turn_postpone?: AttackPostponeSpec;
    /** While the effect lives its holder may switch lines without spending a turn. */
    lane_change_free?: boolean;
    /** Move the holder fires by itself when an attack misses them. */
    on_miss_move?: AttackOnMissMoveSpec;
    /**
     * Ends the effect at a boundary rather than counting `turns`: its holder's
     * next turn start (`turn_start`), right after the holder's action ends
     * (`turn_end`), or when the round wraps (`round_end`).
     */
    expires?: 'turn_start' | 'turn_end' | 'round_end';
    /**
     * Forces a battlefield-wide weather state on landing (`Rain`, `Storm`):
     * it replaces whatever weather holds, lasts whole rounds, chips the
     * opposing side and multiplies listed elements' effectiveness.
     */
    weather?: AttackWeatherSpec;
    /**
     * Effect-strength multipliers the holder's own effects gain by element id
     * while the status lives (`Gale Resonance`, caeli ×1.15).
     */
    element_power?: Record<string, number>;
    /**
     * Accuracy the holder's projectile hits gain (`Skyline Sight`); `vs_lane`
     * narrows the bonus to one defender lane (`Tailwind Trajectory`).
     */
    projectile_accuracy?: { amount: number; vs_lane?: 'front' | 'rear' };
    /** Accuracy every projectile attacker gains against the marked holder. */
    projectile_mark?: { accuracy: number };
    /** Flat evasion the holder gains against ranged actions (`Ranged Veil`). */
    ranged_evasion?: number;
    /** The holder may re-roll its first missed projectile shot each turn. */
    projectile_reroll?: { per_turn: number };
    /** How far back the effect rewinds its bearer. */
    rewind?: AttackRewindSpec;
    /** Where the drained resource goes: back to the caster, or nowhere. */
    drain_to?: 'target' | 'caster';
    /** Resources the holder pays on each of the effect's turns. */
    self_upkeep?: AttackResourceAmounts;
    /** Health the holder pays on the turn after the effect lands. */
    deferred_cost?: AttackResourceAmounts;
    /** Health the holder pays for every target the action reached. */
    self_damage_per_target?: number;
    /** The older spelling of a `debuff` on the attacker's own accuracy. */
    lower_accuracy?: number;
    /**
     * Element effectiveness multipliers the status imposes on incoming
     * actions and effects (`Wet` halves ignis, doubles aqua/chaos).
     */
    element_modulation?: Record<string, number>;
    /** Elements whose attacks lift the status the moment they hit. */
    expire_on_elements?: string[];
    /** Damage shield the landing grants, as a percent of the holder's max HP or a hit-counted wall. */
    shield?: { percent_of_max_hp?: number; hit_chance?: number; max_hits?: number };
    /** Statuses the holder sheds each of the effect's own turns (`rain`). */
    cleanse_per_turn?: { count: number; polarity?: 'negative' | 'positive' | 'any' };
    /** Pool maxima the status regenerates each turn, as percents of the holder's own max. */
    regen_per_turn_percent?: AttackResourceAmounts;
    /** One-shot heal as a percent of the holder's max HP (`dew`). */
    heal_percent_of_max?: number;
    /** One-shot random resource restore as a percent of that pool's max (`clear_water`). */
    random_resource_regen?: { percent: number };
    /** Per-turn random resource restore as a percent of that pool's max (`cleansing_rain`). */
    random_resource_regen_per_turn?: { percent: number };
    /** One-shot pool restore as percents of the holder's own maxima (`water_spring`). */
    resource_regen_percent_of_max?: AttackResourceAmounts;
    /** Falls on the holder when it spends mana/stamina, healing the caster (`hangover`). */
    spend_trigger?: { damage: number; heal_to_source: number };
    /**
     * A landing upgrade that only applies when the target already carries a
     * matching status (`condensation` lasts one turn longer under `mist`).
     */
    upgrade_vs_status?: {
        status: string;
        extra_turns?: number;
        /** Chance the extra turn applies (`whirlpool` roots +1 turn 50% of the time). */
        extra_turns_chance?: number;
        extra_heal_percent_of_max?: number;
        extra_regen_per_turn_percent?: AttackResourceAmounts;
    };
    /** Landing replaces (refreshes) any other status carrying the same label. */
    refresh_status?: boolean;
    /**
     * Charge stacking: each landing charge raises the shared status's charge
     * count; reaching `max` spends it and lands the `release` status (`Freeze`
     * charges build to a `Frozen` miss).
     */
    charges?: {
        max: number;
        /** Charges granted by this landing alone (defaults to 1). */
        initial?: number;
        release?: {
            status_effect?: string;
            turns?: number;
            prevent_actions?: string[];
            debuff?: Record<string, number>;
        };
    };
    /** Statuses this landing strips from the target first (Freezing washes Wet off). */
    also_remove_status?: string[];
    /** The landing only applies when every hit of the action landed (`ice_blades`). */
    require_all_hits?: boolean;
    /** Fits the holder when it acts in one of the named kinds (`thin_ice` slips). */
    trip_on_action?: {
        actions: string[];
        /** Damage channels that may trip it; empty means any. */
        damage_types?: string[];
        chance: number;
        /** Health the tripping holder pays. */
        damage?: number;
        /** Punishment status added on the trip (a `Slipped` SPD loss). */
        spawn?: { status_effect?: string; turns?: number; prevent_actions?: string[]; debuff?: Record<string, number> };
        /** The field disappears after this many trips. */
        max_triggers?: number;
        /** Flat damage the field deals when it expires still armed. */
        expire_damage?: number;
    };
    /** A mark that detonates when its bearer's turn arrives (Chaos marks). */
    detonate_on_turn?: AttackDetonateOnTurnSpec;
    /** A mark that adds damage when another chaos hit lands and can spread. */
    chain_detonation?: AttackChainDetonationSpec;
    /** An electric conductor that jumps damage and can be grounded by Lapis. */
    conductor?: AttackConductorSpec;
    /** A chance to interrupt the bearer's next matching action (`Shock`). */
    interrupt?: AttackInterruptSpec;
    /** Flat damage thrown back at an attacker (`Recoil Guard`, `Static Field`). */
    reflect?: AttackReflectSpec;
    /** Steals part of the bearer's next mana/stamina spend for the status source. */
    spend_steal?: AttackSpendStealSpec;
    /** Dodges the next matching hit and answers with flat PWR. */
    evade_next?: { damage_types?: string[]; power?: number; chance?: number };
    /** While the bearer lives, damage aimed at its allies is taken by it instead. */
    damage_redirect?: { scope?: 'allies_all' | 'allies_lane' };
    /** Multipliers the bearer applies to its own skill costs while the status lives. */
    cost_multiplier?: { mana?: number; stamina?: number };
    /** A price paid when the status ends (stamina, with HP covering a shortfall). */
    end_cost?: { resource?: 'mana' | 'stamina'; percent_of_max: number; shortfall?: 'hp' };
    /** A direct-damage retaliation when the bearer falls. */
    on_death_blast?: { power: number };
    /** Stat fields the holder cannot gain buffs to while the status lives. */
    block_stat_buffs?: string[];
    /** Incoming damage multipliers per channel (`frost_mirror` halves physical). */
    damage_channel_modulation?: Record<string, number>;
    /** Chance the status reflects the next hit instead of the flat `counter`. */
    counter_chance?: number;
    /** Elements the counter refuses to reflect, letting the hit through. */
    counter_except_elements?: string[];
    [key: string]: unknown;
}

/** An authored skill (attack) in the single shared catalogue. */
export interface AttackSkill {
    id: string;
    name: string;
    description?: string;
    element_id: string;
    learning_cost?: LearningCost;
    learning_requirements?: LearningRequirements;
    damage?: Record<string, unknown>;
    targeting?: Record<string, unknown> | string;
    hit_count?: number;
    /** Fire `hit_count` independent rays, each picking a random living enemy. */
    scatter_targets?: boolean;
    /** Ray count for a scatter action; defaults to `hit_count`. */
    scatter_hits?: number;
    /** Scatter rays may pick any living enemy, ignoring reach and lane rules. */
    can_hit_any_enemy?: boolean;
    /** Skip the lane (front/rear) damage multiplier for this action. */
    ignore_position_penalty?: boolean;
    power?: Record<string, unknown> | number;
    accuracy?: number;
    costs?: Record<string, number>;
    effects?: AttackEffect[];
    collateral?: Record<string, unknown>;
    /** The skill is worth its full strength by day and fades to a quarter of it at night. */
    solar?: boolean;
    /** The mirror of `solar`: full strength at night, a quarter of it by day. */
    lunar?: boolean;
    /** The skill only works while the sun is up (the phase, not the hour). */
    only_during_day?: boolean;
    /** The skill only works while the sun is down. */
    only_during_night?: boolean;
    /** Base chance of a critical hit, in percent. */
    crit_chance?: number;
    /** The hit always lands. */
    ignore_accuracy?: boolean;
    /** Fraction of the target's defence the hit ignores (0 … 1). */
    defense_pierce?: number;
    /** Extra multipliers per element of the defender. */
    bonus_vs_elements?: Record<string, number>;
    /** Extra numbers against a target carrying a named status (`hydro_lance` vs Wet). */
    bonus_vs_status?: {
        status: string;
        /** Damage multiplier against that bearer (`1` = unchanged). */
        multiplier?: number;
        /** Extra defence the hit ignores against that bearer (0 … 1). */
        defense_pierce?: number;
    } | Array<{
        status: string;
        multiplier?: number;
        defense_pierce?: number;
    }>;
    /** Extra multiplier against a target below a fraction of its health. */
    bonus_vs_hp_below?: { threshold: number; multiplier: number };
    /** Health fraction below which the target panics and flees the fight. */
    flee_below_hp?: number;
    /** The status that guarantees a critical hit against its bearer. */
    guaranteed_crit_vs_status?: string;
    /**
     * Bonus damage per charge a bearing target holds of a stacking status,
     * spent on the hit (`avalanche` burns Freeze charges).
     */
    bonus_per_charge?: {
        status: string;
        multiplier_per_charge: number;
        /** The consumed charges are stripped from the target on a hit. */
        consume?: boolean;
    };
    /** The kind of skill, for the catalogue's own bookkeeping. */
    kind?: string;
    /** The reach of the skill (`short`, `medium`, `long`). */
    range?: string;
    /** The variance of each hit, as `[min, max]`. */
    damage_variance?: number[];
    /** Adds `power = base + per_point × stat` to every hit (speed-scaled skills). */
    power_scaling?: { stat: string; per_point: number };
    /** Multiplier a critical hit uses instead of the global ×1.75 (`Meteor Drop` doubles). */
    crit_multiplier?: number;
    /** Health the caster pays for a reckless action (`cataclysm`, `explosion`). */
    recoil?: AttackRecoilSpec;
    /** Splash a reckless action throws onto the caster's own allies. */
    friendly_fire?: AttackFriendlyFireSpec;
    /** A chance the blast clips the enemy rear line as well. */
    backlane_splash?: AttackBacklaneSplashSpec;
    /** Damage the caster takes back when the target's line has no room. */
    no_space_recoil?: { fraction: number };
    /** Serial chain lightning / forks. */
    chain?: AttackChainSpec;
    /** Low-accuracy shrapnel thrown after the main blast. */
    shrapnel?: AttackShrapnelSpec;
    /** Charges that build on the caster and make the next explosive unstable. */
    instability?: AttackInstabilitySpec;
    /** Flat damage dealt when a control effect is resisted (`Shock`). */
    control_immune_damage?: number;
    /** A secondary blast when the action defeats a target (`demolition`). */
    on_kill_detonation?: AttackOnKillDetonationSpec;
    /** Takes turns off the caster's own cooldowns when a target carries a status. */
    cooldown_reset?: { status: string; amount?: number };
    /** Adds the bearer's accumulated damage taken to the hit's power. */
    damage_taken_scaling?: { per_point: number; max?: number };
    /** Extra multiplier when the target is weak/resistant to the action's element. */
    element_effectiveness?: { weak: number; resist: number };
    /**
     * SFX track id played when the skill is used.
     *
     * When omitted, the presentation layer falls back to the element's sound.
     */
    sfx?: string;
    [key: string]: unknown;
}

/** A definition as stored in skills/skills.yaml. */
export interface SkillCatalog {
    skills: AttackSkill[];
}

/** Only gameplay fields are exposed to the game client. */
export type PublicAttack = Pick<AttackSkill,
    | 'id'
    | 'name'
    | 'description'
    | 'element_id'
    | 'learning_cost'
    | 'learning_requirements'
    | 'damage'
    | 'targeting'
    | 'hit_count'
    | 'scatter_targets'
    | 'scatter_hits'
    | 'can_hit_any_enemy'
    | 'ignore_position_penalty'
    | 'power'
    | 'accuracy'
    | 'costs'
    | 'effects'
    | 'collateral'
    | 'solar'
    | 'lunar'
    | 'only_during_day'
    | 'only_during_night'
    | 'crit_chance'
    | 'ignore_accuracy'
    | 'defense_pierce'
    | 'bonus_vs_elements'
    | 'bonus_vs_status'
    | 'bonus_per_charge'
    | 'bonus_vs_hp_below'
    | 'flee_below_hp'
    | 'guaranteed_crit_vs_status'
    | 'kind'
    | 'range'
    | 'damage_variance'
    | 'power_scaling'
    | 'crit_multiplier'
    | 'recoil'
    | 'friendly_fire'
    | 'backlane_splash'
    | 'no_space_recoil'
    | 'chain'
    | 'shrapnel'
    | 'instability'
    | 'control_immune_damage'
    | 'on_kill_detonation'
    | 'cooldown_reset'
    | 'damage_taken_scaling'
    | 'element_effectiveness'
    | 'sfx'
>;

export interface SkillTreeNode {
    attack_id: string;
    tree_id: string;
    element_id: string;
    required_attack_ids: string[];
    external_requirements: Array<{
        attack_id: string;
        tree_id: string;
        element_id: string;
    }>;
    learning_cost: LearningCost;
    skill: PublicAttack;
    children: string[];
}

export interface PublicSkillTree {
    id: string;
    element_id: string;
    name: string;
    root_attack_ids: string[];
    nodes: SkillTreeNode[];
}

/** Tree data as included in a whole-content snapshot: references only. */
export interface SkillTreeReference {
    id: string;
    element_id: string;
    name: string;
    nodes: Array<{
        attack_id: string;
    }>;
}

export interface AttackFilters {
    element_id?: string;
    tree_id?: string;
    damage_type?: string;
    order_by?: 'name' | 'id';
    direction?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
}
