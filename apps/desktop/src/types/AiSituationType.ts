/**
 * The situational snapshot a decision reads before scoring.
 *
 * This is the AI's situational memory: every live buff, debuff and status on
 * every unit, every pool (health, mana, stamina), the last stretch of the battle
 * log, and a read of how long the fight is still expected to last. The decider
 * builds it once per decision and the considerations and weight modulation
 * consume it, so an action can be valued against the fight that is actually
 * happening instead of a static score table.
 *
 * The snapshot is read-only and derived. Nothing here is persisted, and nothing
 * here mutates the combat state.
 */

import type { CombatEffectPolarity, CombatLine, CombatSide } from './CombatType';

/** One live effect, reduced to what the weights need to see. */
export interface AiSituationEffect {
    effectId: string;
    /** Id of the action that applied the effect. */
    sourceId: string;
    /** Normalised status name, or `null` for a payload-only effect. */
    status: string | null;
    elementId: string | null;
    polarity: CombatEffectPolarity;
    stacks: number;
    /** Turns left; `null` = until the fight ends. */
    turns: number | null;
    /** Raw health the effect burns from its bearer each turn. */
    damagePerTurn: number;
    /** Raw health the effect restores to its bearer each turn. */
    regenPerTurn: number;
    /** Shield as a fraction of the bearer's max health. */
    shieldFraction: number;
    /** `1` blocks every action, `0.5` only skills, `0` leaves the bearer free. */
    control: number;
    /** The bearer may change lanes without paying stamina. */
    laneChangeFree: boolean;
    /** The effect answers attacks with a counter. */
    counter: boolean;
    /** Absolute stat points the effect adds. */
    buffMagnitude: number;
    /** Absolute stat points the effect removes. */
    debuffMagnitude: number;
}

/** One unit as the situational model sees it. */
export interface AiSituationUnit {
    id: string;
    side: CombatSide;
    line: CombatLine;
    slot: number;
    isActor: boolean;
    isAlive: boolean;
    hp: number;
    maxHp: number;
    hpFraction: number;
    mana: number;
    maxMana: number;
    manaFraction: number;
    stamina: number;
    maxStamina: number;
    staminaFraction: number;
    /** Expected damage this unit takes per round, as a fraction of its max health. */
    threatFraction: number;
    /** Total shield as a fraction of max health. */
    shieldFraction: number;
    /** Damage-per-turn the unit suffers, as a fraction of max health. */
    damageOverTimeFraction: number;
    /** Health the unit regains per turn, as a fraction of max health. */
    healingOverTimeFraction: number;
    control: number;
    /** Every live effect, buffs and debuffs alike. */
    effects: AiSituationEffect[];
    /** Normalised status names, duplicates collapsed. */
    statuses: string[];
    /** Actions currently on cooldown. */
    cooldownCount: number;
    actionCount: number;
}

/**
 * The recent battle log, folded into per-side pressure.
 *
 * Fractions are normalised by the victim's max health, so a big hit on a
 * squishy unit and a big hit on a tank read differently.
 */
export interface AiSituationHistory {
    /** Events the snapshot read. */
    window: number;
    /** Full rounds the window covers. */
    rounds: number;
    actions: number;
    allyActions: number;
    enemyActions: number;
    /** Raw damage each side landed inside the window. */
    allyDamage: number;
    enemyDamage: number;
    allyDamageFraction: number;
    enemyDamageFraction: number;
    /** Healing the actor's side received, as a fraction of max health. */
    allyHealingFraction: number;
    /** Statuses each side applied. */
    allyStatuses: number;
    enemyStatuses: number;
    /** Application attempts each side had resisted. */
    allyStatusesResisted: number;
    enemyStatusesResisted: number;
    allyDefeats: number;
    enemyDefeats: number;
    /** Stamina, mana and health the actor's side paid out. */
    allyResourceSpent: number;
    enemyResourceSpent: number;
    itemsUsed: number;
    fleesAttempted: number;
    /** The actor's most recent action id, when it acted inside the window. */
    lastActorActionId: string | null;
    /** Consecutive repeats of `lastActorActionId` by the actor. */
    repeatedActorActions: number;
}

/**
 * How long the fight still looks like lasting.
 *
 * `roundsToFinish` is the smaller of the two sides' break-even times, so it
 * answers "how many rounds until *someone* falls". `setupWindow` rescales it
 * against {@link AI_FUTURE_REFERENCE_ROUNDS} so a consideration can read it as
 * "is there time to set something up?".
 */
export interface AiSituationHorizon {
    roundsToFinish: number;
    /** `1` = a fight of the reference length; higher means more time to build. */
    setupWindow: number;
    /** Expected damage the actor's side lands per round. */
    allyDamagePerRound: number;
    /** Expected damage the other side lands per round. */
    enemyDamagePerRound: number;
    /** `true` when the estimate blended observed damage from the log. */
    observed: boolean;
}

/** The pressures the weight modulation reads. */
export interface AiSituationPressure {
    /** How hurt the actor is, `0` full .. `1` dead. */
    ownHp: number;
    /** Average health missing across the actor's living side. */
    allyHp: number;
    /** How much of the other side's health pool has already been removed. */
    enemyHp: number;
    /** Expected incoming damage per round, relative to the actor's max health. */
    threat: number;
    mana: number;
    stamina: number;
    allyMana: number;
    allyStamina: number;
    enemyMana: number;
    enemyStamina: number;
    /** Living enemies minus living allies, normalised by the ally count. */
    outnumbered: number;
}

/** Everything one decision knows about the fight around it. */
export interface AiSituation {
    round: number;
    actorId: string;
    actorSide: CombatSide;
    actor: AiSituationUnit;
    allies: AiSituationUnit[];
    enemies: AiSituationUnit[];
    history: AiSituationHistory;
    horizon: AiSituationHorizon;
    pressure: AiSituationPressure;
    /** Active battlefield weather, when any. */
    weather: {
        id: string;
        label: string;
        side: CombatSide;
        rounds: number;
        chipDamage: number;
    } | null;
}
