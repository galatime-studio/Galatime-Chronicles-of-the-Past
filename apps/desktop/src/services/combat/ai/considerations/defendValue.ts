/**
 * `defend` — the worth of bracing when the kit is running dry.
 *
 * The engine removes `DEFEND_DAMAGE_REDUCTION` of incoming damage while bracing,
 * so this scores the avoided portion of next round's threat as a fraction of the
 * unit's health. Bracing is also the decider's floor: it is always legal, so a
 * unit with nothing better to do can still move the fight on.
 *
 * Its *impact* is gated by resource pressure: a unit with healthy mana and
 * stamina is expected to spend the turn on its kit, not to turtle. As either
 * pool falls toward the rest threshold the avoided damage matters more, because
 * the unit cannot afford its real options.
 */

import { DEFEND_DAMAGE_REDUCTION } from '../../../../constants/CombatConstants';
import type { AiConsideration } from '../../../../types/AiType';
import { clamp } from '../../../../utils/combatUtils';
import { effectiveStats } from '../../effectResolver';
import { estimateThreatAgainst } from '../aiThreat';

/** Share of the avoided-damage value that survives while both pools are healthy. */
const HEALTHY_RESOURCE_DEFEND_FACTOR = 0.1;

export const defendValue: AiConsideration = {
    id: 'defend',
    evaluate(context, candidate) {
        if (candidate.action.kind !== 'defend') return 0;

        const { actor, thresholds } = context;
        const stats = effectiveStats(actor);
        if (stats.maxHp <= 0) return 0;

        const manaPressure = poolPressure(actor.currentMana, stats.maxMana, thresholds.restMana);
        const staminaPressure = poolPressure(actor.currentStamina, stats.maxStamina, thresholds.restStamina);
        const resourcePressure = Math.max(manaPressure, staminaPressure);

        const avoided = estimateThreatAgainst(context, actor) * DEFEND_DAMAGE_REDUCTION;
        const score = (avoided / stats.maxHp)
            * (HEALTHY_RESOURCE_DEFEND_FACTOR + (1 - HEALTHY_RESOURCE_DEFEND_FACTOR) * resourcePressure);

        return clamp(score, 0, 1);
    },
};

/** `0` while a pool is healthy, rising to `1` as it empties below its rest gate. */
export function poolPressure(current: number, max: number, threshold: number): number {
    if (max <= 0 || threshold <= 0) return 0;
    const fraction = clamp(current / max, 0, 1);
    return clamp((threshold - fraction) / threshold, 0, 1);
}
