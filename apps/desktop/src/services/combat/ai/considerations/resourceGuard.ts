/**
 * `resource_guard` — whether acting now still leaves a kit to act with later.
 *
 * The score reads the headroom each spent pool keeps above the profile's guard
 * floor: a cheap cast at a healthy pool scores `1`, the same cast near empty
 * decays to `0`, and a cast that would break the floor scores `0`.
 *
 * Free actions score `0` on purpose. They spend nothing, so they protect
 * nothing, and returning `1` for them handed every `defend`, `rest` and
 * `switch_line` a flat bonus across the board — the largest single reason the
 * Utility AI turtled. The consideration is about spending well, not about
 * standing still.
 */

import type { AiConsideration } from '../../../../types/AiType';
import { clamp } from '../../../../utils/combatUtils';
import { effectiveStats } from '../../effectResolver';
import { effectiveActionCost } from '../../weaponEffects';

/** Share of the usable pool (everything above the guard floor) left after paying. */
function headroom(pool: number, cost: number, max: number, guard: number): number {
    const floor = max * guard;
    const usable = Math.max(1, max - floor);
    return clamp((pool - cost - floor) / usable, 0, 1);
}

export const resourceGuard: AiConsideration = {
    id: 'resource_guard',
    evaluate(context, candidate) {
        const { actor, thresholds } = context;
        const costs = effectiveActionCost(actor, candidate.action);

        const stats = effectiveStats(actor);
        const shares: number[] = [];

        if (costs.mana > 0 && stats.maxMana > 0) {
            shares.push(headroom(actor.currentMana, costs.mana, stats.maxMana, thresholds.guardMana));
        }
        if (costs.stamina > 0 && stats.maxStamina > 0) {
            shares.push(headroom(actor.currentStamina, costs.stamina, stats.maxStamina, thresholds.guardStamina));
        }

        if (shares.length === 0) return 0;

        return shares.reduce((total, share) => total + share, 0) / shares.length;
    },
};
