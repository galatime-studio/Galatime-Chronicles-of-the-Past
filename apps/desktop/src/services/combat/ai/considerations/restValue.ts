/**
 * `rest` — recovering the resource that gates the kit.
 *
 * Only scores when a pool is genuinely low: above its `rest` threshold the unit
 * should spend the turn on an action, not idle. The ramp is quadratic, so a pool
 * barely below the gate is a weak reason to rest while an almost-empty pool is a
 * near-maximal one. A rest that would re-enable a skill the unit cannot currently
 * afford earns a bonus, so a caster tops its mana back up instead of throwing a
 * weak spell.
 */

import type { AiConsideration } from '../../../../types/AiType';
import { clamp } from '../../../../utils/combatUtils';
import { effectiveStats } from '../../effectResolver';
import { idleRegenAmount } from '../../resourceRegen';
import { effectiveActionCost } from '../../weaponEffects';

/** Bonus when the rest unlocks a skill the unit cannot afford right now. */
const UNLOCK_BONUS = 0.3;

export const restValue: AiConsideration = {
    id: 'rest',
    evaluate(context, candidate) {
        if (candidate.action.kind !== 'rest') return 0;

        const { actor, thresholds } = context;
        const stats = effectiveStats(actor);

        const manaFraction = stats.maxMana > 0 ? actor.currentMana / stats.maxMana : 1;
        const staminaFraction = stats.maxStamina > 0 ? actor.currentStamina / stats.maxStamina : 1;

        const manaPressure = pressure(manaFraction, thresholds.restMana);
        const staminaPressure = pressure(staminaFraction, thresholds.restStamina);
        const resourcePressure = Math.max(manaPressure, staminaPressure);
        if (resourcePressure <= 0) return 0;

        // Quadratic: the closer the pool is to empty, the more the turn is worth.
        let score = resourcePressure * resourcePressure;

        // The resolver advances the streak by one and pays the step it reaches.
        const manaRestore = stats.maxMana > 0
            ? idleRegenAmount(stats.maxMana, actor.resourceIdleTurns.mana + 1)
            : 0;
        const staminaRestore = stats.maxStamina > 0
            ? idleRegenAmount(stats.maxStamina, actor.resourceIdleTurns.stamina + 1)
            : 0;

        const unlocks = actor.actions.some((action) => {
            if (action.kind !== 'skill' || !action.dealsDamage) return false;
            const cost = effectiveActionCost(actor, action);
            const blockedNow = cost.mana > actor.currentMana || cost.stamina > actor.currentStamina;
            const affordableAfter = cost.mana <= actor.currentMana + manaRestore
                && cost.stamina <= actor.currentStamina + staminaRestore;
            return blockedNow && affordableAfter;
        });

        if (unlocks) score += UNLOCK_BONUS;
        return clamp(score, 0, 1);
    },
};

/** `0` while a pool is at or above its rest gate, rising to `1` as it empties. */
function pressure(fraction: number, threshold: number): number {
    if (threshold <= 0) return 0;
    return clamp((threshold - fraction) / threshold, 0, 1);
}
