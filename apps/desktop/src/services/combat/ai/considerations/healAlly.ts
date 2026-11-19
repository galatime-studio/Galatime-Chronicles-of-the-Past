import {
    AI_HEAL_RESCUE_THRESHOLD,
    AI_HEAL_RESCUE_WEIGHT,
} from '../../../../constants/AiConstants';
import type { AiConsideration } from '../../../../types/AiType';
import { clamp } from '../../../../utils/combatUtils';
import { unitHpFraction } from '../../effectResolver';
import { candidateTargetUnits } from '../aiCandidates';
import { healScore } from '../aiHealing';

/**
 * How much the candidate would heal the actor's other allies.
 *
 * The scores sum across everyone the action reaches, so a team-wide mend is
 * worth what it heals across the whole party instead of only the single worst
 * ally. A heal on an ally below the rescue threshold is worth more than its raw
 * health: pulling a unit out of kill range keeps its whole contribution alive.
 * The result is still clamped, so one enormous heal cannot outrank everything
 * by an order of magnitude.
 */
export const healAlly: AiConsideration = {
    id: 'heal_ally',
    evaluate(context, candidate) {
        const { actor } = context;
        if (!candidate.action.heals) return 0;
        let total = 0;
        for (const target of candidateTargetUnits(context, candidate)) {
            if (target.side !== actor.side || target.id === actor.id) continue;
            const missing = 1 - unitHpFraction(target);
            const rescue = clamp(
                (missing - AI_HEAL_RESCUE_THRESHOLD) / (1 - AI_HEAL_RESCUE_THRESHOLD),
                0,
                1,
            );
            total += healScore(context, candidate.action, target) * (1 + AI_HEAL_RESCUE_WEIGHT * rescue);
        }
        return clamp(total, 0, 1);
    },
};
