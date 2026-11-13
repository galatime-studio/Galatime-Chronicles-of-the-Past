/**
 * `survival` — the value of removing incoming danger.
 *
 * The threat the unit faces next round, made real: a candidate that kills an
 * enemy removes that enemy's whole threat contribution, and bracing removes the
 * share the reduction protects.
 *
 * The result is measured in *fractions of the unit's own health bar*, the same
 * unit `expected_damage` uses for the target's bar, so one attack and one round
 * of mitigation are directly comparable. Normalising by the threat instead would
 * make bracing look like `0.4` against any danger, which outscaled damage by an
 * order of magnitude and is what taught the AI to turtle. A wounded unit still
 * cares more, but only by the urgency multiplier.
 */

import { DEFEND_DAMAGE_REDUCTION } from '../../../../constants/CombatConstants';
import { AI_WOUNDED_SURVIVAL_URGENCY } from '../../../../constants/AiConstants';
import type { AiConsideration } from '../../../../types/AiType';
import { clamp } from '../../../../utils/combatUtils';
import { effectiveStats, unitHpFraction } from '../../effectResolver';
import { candidateTargetUnits } from '../aiCandidates';
import { expectedDamageFor } from '../aiImpacts';
import { estimateThreatAgainst, threatFrom } from '../aiThreat';

export const survival: AiConsideration = {
    id: 'survival',
    evaluate(context, candidate) {
        const { actor, thresholds } = context;
        const maxHp = effectiveStats(actor).maxHp;
        if (maxHp <= 0) return 0;

        const threat = estimateThreatAgainst(context, actor);
        if (threat <= 0) return 0;

        let removed = 0;
        if (candidate.action.dealsDamage) {
            for (const target of candidateTargetUnits(context, candidate)) {
                if (target.side === actor.side) continue;
                if (expectedDamageFor(context, candidate.action, target) >= target.currentHp) {
                    removed += threatFrom(context, target, actor);
                }
            }
        } else if (candidate.action.kind === 'defend') {
            removed = threat * DEFEND_DAMAGE_REDUCTION;
        }

        if (removed <= 0) return 0;

        const protection = clamp(removed / maxHp, 0, 1);
        const wounded = unitHpFraction(actor) < thresholds.wounded;

        return clamp(protection * (wounded ? AI_WOUNDED_SURVIVAL_URGENCY : 1), 0, 1);
    },
};
