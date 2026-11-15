/**
 * Pre-damage interception.
 *
 * A `force_miss` ability is the one `before_damage` reaction that does not fold
 * into the damage number: it voids the blow before any roll happens, so it has
 * to run exactly once, on the real hit, and it is allowed to write state (mark
 * `once`/cooldown, charge the bearer a turn). That is why it lives here rather
 * than in `abilityModifiers`, whose folds stay pure for the HUD preview.
 */

import type {
    CombatAction,
    CombatEvent,
    CombatRandom,
    CombatUnit,
} from '../../types/CombatType';
import { readBoolean } from '../../utils/combatUtils';
import { evaluateAbilityCondition } from './abilityConditions';
import type { AbilityTriggerContext } from './abilityContext';

export interface ForcedMiss {
    /** The hit is voided: the caller reports a miss instead of resolving damage. */
    forced: boolean;
    /** `ability_triggered`, when an ability paid to stop the blow. */
    events: CombatEvent[];
}

/**
 * Fires the defender's first `force_miss` reaction that accepts this action.
 *
 * The check runs on the unit the blow would actually land on (a cover is
 * already resolved by the caller). Guaranteed-hit actions and friendly fire are
 * left alone: there is no attack to slip away from.
 *
 * An ability that fires may charge its bearer a turn
 * (`parameters.consume_next_turn`), expressed through the same `skipTurn` flag
 * the turn loop already consumes.
 */
export function resolveForcedMiss(
    defender: CombatUnit,
    action: CombatAction,
    random: CombatRandom,
    units: readonly CombatUnit[],
    attacker: CombatUnit | null,
): ForcedMiss {
    const none: ForcedMiss = { forced: false, events: [] };
    if (!action.dealsDamage || action.ignoreAccuracy) return none;
    if (defender.status !== 'alive') return none;
    // A stray friendly shot is not worth spending a turn on.
    if (attacker && attacker.side === defender.side) return none;

    for (const ability of defender.abilities) {
        const { definition } = ability;
        if (definition.trigger.event !== 'before_damage') continue;
        if (definition.action.type !== 'force_miss') continue;
        if (definition.trigger.once && ability.triggered) continue;
        if (ability.cooldownRemaining > 0) continue;

        const context: AbilityTriggerContext = {
            source: attacker,
            target: defender,
            damageType: action.damageType,
            elementId: action.elementId,
            damage: 0,
            units,
            random,
            range: action.range,
        };
        if (!evaluateAbilityCondition(definition.condition, defender, context)) continue;

        const chance = definition.action.chance ?? 1;
        if (chance < 1 && random() >= chance) continue;

        const events: CombatEvent[] = [{
            type: 'ability_triggered',
            unitId: defender.id,
            abilityId: definition.id,
            abilityName: definition.name,
            targetIds: [defender.id],
        }];

        if (definition.trigger.once) ability.triggered = true;
        const cooldown = definition.trigger.cooldown?.turns ?? 0;
        if (cooldown > 0) ability.cooldownRemaining = cooldown;

        if (readBoolean(definition.action.parameters?.consume_next_turn, false)) {
            defender.flags.skipTurn = true;
        }

        return { forced: true, events };
    }

    return none;
}
