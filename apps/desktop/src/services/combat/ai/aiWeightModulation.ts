/**
 * Turns the situational snapshot into a multiplier per consideration.
 *
 * The 14 authored weights stay the unit's temperament - a brute is still a
 * brute - but the *emphasis* moves with the fight. A wounded unit leans on
 * survival and healing; a fight with rounds left leans on setups; a fight about
 * to end leans on finishing. The rules are deliberately multiplicative:
 *
 * - a weight of `0` stays `0`, so an authored refusal (`defend: 0` on a brute)
 *   is never overridden by the situation;
 * - every factor is bounded, so no rule can drown the profile;
 * - the product is clamped to the training bounds, keeping the runtime weight
 *   space the same one the optimizer searches.
 *
 * This module is pure: no state, no randomness, no logging.
 */

import {
    AI_FUTURE_REFERENCE_ROUNDS,
    AI_MODULATION_MAX,
    AI_MODULATION_MIN,
    AI_MODULATION_NOTE_THRESHOLD,
} from '../../../constants/AiConstants';
import { AI_WEIGHT_MAX, AI_WEIGHT_MIN } from '../../../constants/AiTrainingConstants';
import type { AiConsiderationId } from '../../../types/AiType';
import type { AiSituation } from '../../../types/AiSituationType';
import { clamp } from '../../../utils/combatUtils';

/** The modulated weights, the factors that produced them, and why. */
export interface AiWeightModulation {
    /** The weights the decider actually scores with. */
    weights: Record<AiConsiderationId, number>;
    /** Multiplier applied to each authored weight; `1` = unchanged. */
    factors: Record<AiConsiderationId, number>;
    /** One line per factor that moved meaningfully. */
    notes: string[];
}

/** Scales `base` by the current situation. */
export function modulateAiWeights(
    base: Readonly<Record<AiConsiderationId, number>>,
    situation: AiSituation,
): AiWeightModulation {
    const factors = buildFactors(situation);
    const weights = {} as Record<AiConsiderationId, number>;
    const notes: string[] = [];

    for (const id of Object.keys(base) as AiConsiderationId[]) {
        const factor = clamp(factors[id] ?? 1, AI_MODULATION_MIN, AI_MODULATION_MAX);
        const authored = base[id] ?? 0;
        factors[id] = factor;
        weights[id] = authored === 0
            ? 0
            : clamp(authored * factor, AI_WEIGHT_MIN, AI_WEIGHT_MAX);

        if (Math.abs(factor - 1) >= AI_MODULATION_NOTE_THRESHOLD && authored !== 0) {
            const percent = Math.round((factor - 1) * 100);
            notes.push(`${id} ${percent >= 0 ? '+' : ''}${percent}%`);
        }
    }

    return { weights, factors, notes };
}

/**
 * One multiplier per consideration.
 *
 * The reads are intentionally shallow - a few aggregated pressures instead of a
 * rule per status - so the modulation stays explainable and the same rules keep
 * working for every element.
 */
function buildFactors(situation: AiSituation): Record<AiConsiderationId, number> {
    const { pressure, horizon, history } = situation;

    /** `0` = untouched enemy pool, `1` = the other side is one hit from gone. */
    const lateGame = clamp(pressure.enemyHp, 0, 1);
    const earlyGame = 1 - lateGame;
    const ownHp = clamp(pressure.ownHp, 0, 1);
    const allyHp = clamp(pressure.allyHp, 0, 1);
    const threat = clamp(pressure.threat, 0, 1);
    const outnumbered = clamp(pressure.outnumbered, 0, 1);

    /** Own pools, weighted toward the actor: it is the one that has to act. */
    const resource = clamp(
        Math.max(pressure.mana, pressure.stamina) * 0.75
        + Math.max(pressure.allyMana, pressure.allyStamina) * 0.25,
        0,
        1,
    );

    /** Share of the actor's side's status attempts the other side shrugged off. */
    const resisted = history.allyStatusesResisted;
    const attempted = resisted + history.allyStatuses;
    const resistance = attempted > 0 ? clamp(resisted / attempted, 0, 1) : 0;

    /** `0` = the fight ends immediately, `1` = plenty of rounds to build. */
    const timeToPlan = clamp(
        horizon.roundsToFinish / (AI_FUTURE_REFERENCE_ROUNDS * 2),
        0,
        1,
    );

    return {
        // Damage is always good; it is worth more when a kill ends the fight.
        expected_damage: 1 + 0.35 * lateGame,
        kill_secure: 1 + 0.6 * lateGame,

        // Elemental advantage pays off over several hits, so it needs a fight.
        element_edge: 1 + 0.2 * earlyGame,

        // Setups are the future: worth more with time and when they land.
        effect_value: (1 - 0.45 * lateGame + 0.5 * timeToPlan) * (1 - 0.5 * resistance),

        survival: 1 + 1.1 * ownHp + 0.5 * threat + 0.35 * outnumbered,
        flee: 1,
        heal_ally: 1 + 0.9 * allyHp + 0.3 * outnumbered,
        heal_self: 1 + 0.9 * ownHp,
        defend: 1 + 0.9 * threat + 0.25 * outnumbered,
        rest: 1 + 1.4 * resource,
        reposition: 1 + 0.35 * earlyGame,
        resource_guard: 1 + 1.1 * resource,
        resource_share: 1 + 0.8 * clamp(Math.max(pressure.allyMana, pressure.allyStamina), 0, 1),

        // A potion is a stopgap: it matters most when the actor is nearly out.
        item: 1 + 0.8 * ownHp,
    };
}
