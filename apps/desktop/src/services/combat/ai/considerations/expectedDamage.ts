/**
 * `expected_damage` — how much of the target's health the candidate removes.
 *
 * The workhorse: the damage chain's deterministic expectation, normalised by the
 * target's max HP and by `AI_DAMAGE_REFERENCE_FRACTION`, so a hit that removes a
 * tenth of the bar reads as a full hit. Damage has to share its denominator with
 * the other health-denominated considerations; before it divided by the raw bar
 * alone and every attack scored around 0.01 while a single buff scored 0.6.
 *
 * A multi-target action sums its targets but with a ceiling, so a huge AoE cannot
 * dwarf a decisive single-target strike. That ceiling applies only when the action
 * really spreads: dividing a lone hit by it made every strike look two thirds of
 * its worth next to a brace, and the tie against `defend` is what kept a unit
 * bracing while its enemy healed back to full.
 *
 * Friendly fire is signed out, not just discounted by the target bias: an AoE
 * that clips the caster's own line has to earn back that damage, and a
 * single-target blow aimed at an ally scores nothing.
 */

import { AI_AOE_DAMAGE_CAP, AI_DAMAGE_REFERENCE_FRACTION } from '../../../../constants/AiConstants';
import type { AiConsideration } from '../../../../types/AiType';
import { clamp } from '../../../../utils/combatUtils';
import { effectiveStats } from '../../effectResolver';
import { candidateTargetUnits } from '../aiCandidates';
import { expectedDamageFor } from '../aiImpacts';

export const expectedDamage: AiConsideration = {
    id: 'expected_damage',
    evaluate(context, candidate) {
        const { action } = candidate;
        if (!action.dealsDamage) return 0;

        const targets = candidateTargetUnits(context, candidate);
        if (targets.length === 0) return 0;

        let fraction = 0;
        for (const target of targets) {
            const maxHp = effectiveStats(target).maxHp;
            if (maxHp <= 0) continue;

            const hit = expectedDamageFor(context, action, target) / maxHp;
            fraction += target.side === context.actor.side ? -hit : hit;
        }

        const decisive = fraction / AI_DAMAGE_REFERENCE_FRACTION;
        const spread = targets.filter((target) => target.side !== context.actor.side).length > 1;
        const ceiling = spread ? AI_AOE_DAMAGE_CAP : 1;
        return clamp(decisive, 0, ceiling) / ceiling;
    },
};
