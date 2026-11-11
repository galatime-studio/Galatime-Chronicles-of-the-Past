/**
 * `resource_share` — the Vis recall family: pay mana to fill an ally's pool.
 *
 * Scores a `resource_transfer` candidate by how much of a recipient's pool it
 * would actually refill, mirroring `heal_ally`'s triage arithmetic with the
 * transferred resource in place of health. A group transfer sums across its
 * recipients, so helping the whole team counts like a full single mend.
 */

import { AI_HEAL_REFERENCE_FRACTION } from '../../../../constants/AiConstants';
import type { AiConsideration } from '../../../../types/AiType';
import type { CombatUnit } from '../../../../types/CombatType';
import { clamp } from '../../../../utils/combatUtils';
import { effectiveStats, readResourceTransferSpec } from '../../effectResolver';
import { candidateTargetUnits } from '../aiCandidates';

export const resourceShare: AiConsideration = {
    id: 'resource_share',
    evaluate(context, candidate) {
        const { actor } = context;

        let total = 0;
        for (const effect of candidate.action.effects) {
            const spec = readResourceTransferSpec(effect.resource_transfer);
            if (!spec) continue;

            for (const target of candidateTargetUnits(context, candidate)) {
                if (target.side !== actor.side || target.id === actor.id) continue;
                if (target.status !== 'alive') continue;
                total += transferScore(target, spec.resource, spec.amount);
            }
        }

        return clamp(total, 0, 1);
    },
};

/**
 * The `[0, 1]` value of moving `amount` of a resource into `target`'s pool:
 * the fraction of the pool it is missing, scaled by how completely the
 * transfer covers it. A full pool scores `0`.
 */
function transferScore(
    target: CombatUnit,
    resource: 'hp' | 'mana' | 'stamina',
    amount: number,
): number {
    const stats = effectiveStats(target);
    const max = resource === 'hp' ? stats.maxHp
        : resource === 'mana' ? stats.maxMana
            : stats.maxStamina;
    const current = resource === 'hp' ? target.currentHp
        : resource === 'mana' ? target.currentMana
            : target.currentStamina;
    if (max <= 0) return 0;

    const missing = max - current;
    if (missing <= 0) return 0;

    const received = Math.min(amount, missing);
    const coverage = clamp(received / (max * AI_HEAL_REFERENCE_FRACTION), 0, 1);
    return clamp(missing / max, 0, 1) * coverage;
}
