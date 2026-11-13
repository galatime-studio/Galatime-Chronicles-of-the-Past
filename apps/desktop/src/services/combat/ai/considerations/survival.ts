/**
 * `survival` — the value of removing incoming danger.
 *
 * Two separate jobs, because they are worth different things:
 *
 * - Killing an enemy removes that enemy's whole threat contribution. That is
 *   permanent progress, so it is paid in full.
 * - Bracing removes the share of the next round the reduction protects. That is
 *   tempo spent, not progress made: at full health a brace changes nothing on
 *   the board while the enemy keeps acting, and an AI that braces whenever the
 *   incoming round is large will out-last every enemy without ever winning. The
 *   mitigation half is therefore gated on the bar already being spent and
 *   saturates below `AI_BRACE_HP_FRACTION` of health lost, where a brace is the
 *   play that keeps the unit alive.
 *
 * The result is measured in fractions of the unit's own health bar, divided by
 * the same `AI_DAMAGE_REFERENCE_FRACTION` that `expected_damage` uses for the
 * target's bar, so one attack and one round of mitigation are directly
 * comparable. Normalising by the threat instead would make bracing look like
 * `0.4` against any danger, which outscaled damage by an order of magnitude and
 * is what taught the AI to turtle.
 */

import { DEFEND_DAMAGE_REDUCTION } from '../../../../constants/CombatConstants';
import {
    AI_BRACE_HP_FRACTION,
    AI_BRACE_SPECULATION,
    AI_DAMAGE_REFERENCE_FRACTION,
    AI_THREAT_REALISM_DISCOUNT,
    AI_WOUNDED_SURVIVAL_URGENCY,
} from '../../../../constants/AiConstants';
import type { AiConsideration } from '../../../../types/AiType';
import type { CombatUnit } from '../../../../types/CombatType';
import { clamp } from '../../../../utils/combatUtils';
import { effectiveStats, unitHpFraction } from '../../effectResolver';
import { candidateTargetUnits } from '../aiCandidates';
import { expectedDamageFor } from '../aiImpacts';
import { estimateThreatAgainst, threatFrom } from '../aiThreat';

export const survival: AiConsideration = {
    id: 'survival',
    evaluate(context, candidate) {
        const { actor } = context;
        const maxHp = effectiveStats(actor).maxHp;
        if (maxHp <= 0) return 0;

        const threat = estimateThreatAgainst(context, actor);
        if (threat <= 0) return 0;
        // Both the mitigation and the "would this round kill me" test read the
        // realistic number, not the upper bound: judging lethality off the bound
        // made a unit brace at full value from half health onwards.
        const incoming = realisticThreat(threat);

        let killed = 0;
        let mitigated = 0;
        if (candidate.action.dealsDamage) {
            for (const target of candidateTargetUnits(context, candidate)) {
                if (target.side === actor.side) continue;
                if (expectedDamageFor(context, candidate.action, target) >= target.currentHp) {
                    killed += threatFrom(context, target, actor);
                }
            }
        } else if (candidate.action.kind === 'defend') {
            mitigated = incoming * DEFEND_DAMAGE_REDUCTION;
        }

        const removed = clamp(killed / maxHp / AI_DAMAGE_REFERENCE_FRACTION, 0, 1);
        const braced = clamp(mitigated / maxHp / AI_DAMAGE_REFERENCE_FRACTION, 0, 1);
        return clamp(removed + braced * braceUrgency(actor, incoming), 0, 1);
    },
};

/**
 * What the other side is actually landing, as opposed to what it could land.
 *
 * `estimateThreatAgainst` is an upper bound: it gives every enemy its best hit on
 * every turn it gets, while enemies also buff, rest and shuffle. Pricing a brace
 * off the bound made a 40% reduction look like a fifth of a health bar and bracing
 * outscored attacking in every fight with more than one enemy. Half of the bound
 * is the opening assumption.
 *
 * The log is deliberately not used here: the damage a side has taken is highest on
 * the side that is already losing, so feeding it back into the brace value turned a
 * bad round into a reason to brace again, and the losing side defended itself to
 * death.
 */
function realisticThreat(estimate: number): number {
    return estimate * AI_THREAT_REALISM_DISCOUNT;
}

/**
 * How much a brace is worth right now, in `[0, AI_WOUNDED_SURVIVAL_URGENCY]`.
 *
 * A round that would kill the unit makes bracing the best action on the board, so
 * it pays in full. Anything else is speculation: the enemy keeps acting next round
 * and nothing on the board changed, so the mitigation is discounted hard
 * (`AI_BRACE_SPECULATION`). Without that split a unit that can only take two turns
 * per round against two enemies taking six will brace forever, because 40% of six
 * attacks always looks bigger than one of its own.
 */
function braceUrgency(actor: CombatUnit, threat: number): number {
    const lethal = threat >= actor.currentHp;
    const missing = 1 - clamp(unitHpFraction(actor), 0, 1);
    const wounded = clamp(missing / AI_BRACE_HP_FRACTION, 0, 1);
    return lethal ? AI_WOUNDED_SURVIVAL_URGENCY : wounded * AI_BRACE_SPECULATION;
}
