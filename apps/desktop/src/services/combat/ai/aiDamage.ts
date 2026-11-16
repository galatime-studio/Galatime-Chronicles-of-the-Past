/**
 * Sustained-damage read of the fight.
 *
 * `threat` prices what an enemy can do next round; this prices what it has
 * already done. Neither current HP (`weakest`) nor a per-hit estimate can see a
 * rear support that has spent the fight quietly dealing the largest share of
 * its side's damage, so it never becomes a target worth crossing the line for.
 *
 * The source is `state.damageDealt`, the untrimmed ledger written as each
 * `attack_resolved` lands. The visible log is capped at 200 events and forgets
 * the opening of a long fight, which made an earlier log-scanning version
 * report only the last few rounds as "cumulative".
 *
 * The score is a share of the target's own side, which keeps a 700 HP
 * skirmisher and a 1010 HP support comparable and stays in `0 … 1`. The ledger
 * is memoised per decision context, exactly like `threat`.
 */

import type { AiDecisionContext } from '../../../types/AiType';
import { clamp } from '../../../utils/combatUtils';

interface DamageLedger {
    /** Damage each unit has dealt this fight. */
    byUnit: Map<string, number>;
    /** Total damage each side has dealt this fight. */
    bySide: Map<string, number>;
}

const damageCache = new WeakMap<AiDecisionContext, DamageLedger>();

/**
 * Reads the cumulative ledger once per decision context.
 *
 * States built by hand (older tests, fixtures) may not carry `damageDealt`; for
 * those the visible log is the only evidence available, so it is scanned as a
 * best-effort fallback rather than reporting a fully cold fight.
 */
function damageLedger(context: AiDecisionContext): DamageLedger {
    const cached = damageCache.get(context);
    if (cached) return cached;

    const byUnit = new Map<string, number>();
    const recorded = context.state.damageDealt;
    if (recorded) {
        for (const [unitId, total] of Object.entries(recorded)) {
            if (Number.isFinite(total) && total > 0) byUnit.set(unitId, total);
        }
    } else {
        for (const event of context.state.log) {
            if (event.type !== 'attack_resolved') continue;
            const { attackerId, finalDamage } = event.resolution;
            if (!Number.isFinite(finalDamage) || finalDamage <= 0) continue;
            byUnit.set(attackerId, (byUnit.get(attackerId) ?? 0) + finalDamage);
        }
    }

    const bySide = new Map<string, number>();
    for (const unit of context.state.units) {
        const dealt = byUnit.get(unit.id);
        if (!dealt) continue;
        bySide.set(unit.side, (bySide.get(unit.side) ?? 0) + dealt);
    }

    const ledger = { byUnit, bySide };
    damageCache.set(context, ledger);
    return ledger;
}

/**
 * Share of its own side's damage the target has dealt this fight, in `[0, 1]`.
 *
 * A unit that has not acted yet scores `0`, so the first round of a fight has
 * no damage preference at all — the profile's other preferences decide it.
 */
export function damageShareOfSide(
    context: AiDecisionContext,
    target: { id: string; side: string },
): number {
    const { byUnit, bySide } = damageLedger(context);
    const dealt = byUnit.get(target.id) ?? 0;
    const total = bySide.get(target.side) ?? 0;
    return total > 0 ? clamp(dealt / total, 0, 1) : 0;
}
