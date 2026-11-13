/**
 * `item` — using a combat item from the inventory.
 *
 * `inventory` is now a real candidate source: one candidate exists per usable
 * item and legal target. This consideration is deliberately conservative about
 * healing: a potion at full health is worth nothing, so the AI does not burn
 * its stock before it is needed.
 */

import { AI_EFFECT_REFERENCE, AI_HEAL_REFERENCE_FRACTION } from '../../../../constants/AiConstants';
import type { AiConsideration } from '../../../../types/AiType';
import type { CombatUnit } from '../../../../types/CombatType';
import type { ItemEffect, ItemResourceId } from '../../../../types/InventoryType';
import { clamp } from '../../../../utils/combatUtils';
import { effectiveStats } from '../../effectResolver';
import { getItemDefinition } from '../../../inventory/itemService';
import { resolveItemTargets } from '../../../inventory/itemTargetResolver';

export const itemValue: AiConsideration = {
    id: 'item',
    evaluate(context, candidate) {
        if (!candidate.itemId || candidate.action.kind !== 'inventory') return 0;

        const item = getItemDefinition(candidate.itemId);
        if (!item) return 0;

        const explicitTarget = candidate.targetId
            ? context.state.units.find((unit) => unit.id === candidate.targetId) ?? null
            : null;

        let total = 0;
        for (const effect of item.effects) {
            const rule = effect.target ?? item.target;
            const targets = resolveItemTargets(context.state, context.actor, rule, explicitTarget);
            for (const target of targets) {
                total += scoreEffect(context.actor, target, effect);
            }
        }

        return clamp(total, 0, 1);
    },
};

/** Scores one item effect on one resolved target. */
function scoreEffect(actor: CombatUnit, target: CombatUnit, effect: ItemEffect): number {
    switch (effect.type) {
        case 'restore': {
            const amount = effect.amountMax === undefined
                ? effect.amount
                : (effect.amount + effect.amountMax) / 2;
            return restoreValue(actor, target, effect.resource, amount);
        }
        case 'restore_percent': {
            const max = poolMax(target, effect.resource);
            return restoreValue(actor, target, effect.resource, max * effect.amountPercent / 100);
        }
        case 'damage': {
            const maxHp = Math.max(1, effectiveStats(target).maxHp);
            const value = clamp(effect.amount / maxHp, 0, 1);
            return target.side === actor.side ? -value : value;
        }
        case 'drain': {
            const maxHp = Math.max(1, effectiveStats(target).maxHp);
            const damage = clamp(effect.amount / maxHp, 0, 1);
            if (target.side === actor.side) return -damage;
            const actorMax = Math.max(1, effectiveStats(actor).maxHp);
            const actorMissing = 1 - actor.currentHp / actorMax;
            const heal = (effect.amount * (effect.drainPercent ?? 100) / 100) / actorMax;
            return damage + clamp(heal, 0, 1) * (0.25 + 0.75 * clamp(actorMissing, 0, 1));
        }
        case 'status': {
            const turns = effect.turns ?? 3;
            const maxHp = Math.max(1, effectiveStats(target).maxHp);
            const dot = (effect.damagePerTurn ?? 0) * turns / maxHp;
            const buff = statMagnitude(effect.buff);
            const debuff = statMagnitude(effect.debuff);
            const ally = target.side === actor.side;
            const favorable = ally ? buff : debuff;
            const unfavorable = ally ? debuff : buff;
            return clamp(favorable - unfavorable + (ally ? -dot : dot), 0, 1);
        }
        case 'revive': {
            if (target.status === 'alive') return 0;
            return clamp(0.7 + effect.amountPercent / 100 * 0.3, 0, 1);
        }
        case 'cleanse': {
            const negative = target.effects.filter((entry) => entry.polarity === 'negative').length;
            return clamp(negative / 3 * 0.4, 0, 1);
        }
        case 'mystery':
            return 0.15;
        default:
            return 0;
    }
}

/** Missing-pool-aware restore value; a full pool receives nothing. */
function restoreValue(
    actor: CombatUnit,
    target: CombatUnit,
    resource: ItemResourceId,
    amount: number,
): number {
    const max = poolMax(target, resource);
    const current = poolCurrent(target, resource);
    if (max <= 0 || amount <= 0 || current >= max) return 0;

    const missing = 1 - current / max;
    const healed = Math.min(amount, max - current);
    const reference = Math.max(1, max * AI_HEAL_REFERENCE_FRACTION);
    const value = clamp(healed / reference, 0, 1) * (0.25 + 0.75 * clamp(missing, 0, 1));
    return target.side === actor.side ? value : -value;
}

function poolMax(target: CombatUnit, resource: ItemResourceId): number {
    const stats = effectiveStats(target);
    if (resource === 'hp') return Math.max(1, stats.maxHp);
    if (resource === 'mana') return Math.max(1, stats.maxMana);
    return Math.max(1, stats.maxStamina);
}

function poolCurrent(target: CombatUnit, resource: ItemResourceId): number {
    if (resource === 'hp') return target.currentHp;
    if (resource === 'mana') return target.currentMana;
    return target.currentStamina;
}

/** Flat stat change as a fraction of one "full" authored effect. */
function statMagnitude(delta: Record<string, number> | null | undefined): number {
    if (!delta) return 0;
    let total = 0;
    for (const value of Object.values(delta)) total += Math.abs(value);
    return clamp(total / AI_EFFECT_REFERENCE, 0, 1);
}
