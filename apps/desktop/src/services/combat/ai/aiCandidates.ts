/**
 * Turning legal actions into the candidates the decider scores.
 *
 * The service already validated every rule (cost, cooldown, reach, line,
 * targeting), so this only has to expand a preview into *(action × target)*
 * pairs. `inventory` is expanded into one candidate per usable item and target;
 * an inventory with no usable item contributes nothing.
 *
 * `flee` is a normal candidate when the unit carries it. The action is only
 * attached to units that may actually run, and its preview stays unusable while
 * the unit is above its panic gate, so most enemies never see it.
 */

import type { AiCandidate, AiDecisionContext } from '../../../types/AiType';
import type { CombatAction, CombatUnit } from '../../../types/CombatType';
import type { ItemDefinition, ItemTargetRule } from '../../../types/InventoryType';
import { getUsableCombatItems } from '../../inventory/inventoryCombatService';
import {
    isSingleTargetRule,
    legalItemTargetIds,
    resolveItemTargets,
} from '../../inventory/itemTargetResolver';

/** Actions the AI must never pick, because they cannot resolve. */
const EXCLUDED_KINDS: ReadonlySet<string> = new Set();

/**
 * Targeting rules that require the request to name an aim.
 *
 * Keep this in sync with `validateTargetRule`: both single-target and lane
 * scopes resolve `target_required` without a `targetId`.
 */
export function actionRequiresExplicitTarget(action: CombatAction): boolean {
    return action.targeting === 'any_one' || action.targeting === 'enemies_lane';
}

/**
 * Every legal move for the actor, one candidate per target of a single-target
 * action and one candidate (carrying its whole target list) for the rest.
 */
export function buildAiCandidates(context: AiDecisionContext): AiCandidate[] {
    const { actor, previews } = context;
    const candidates: AiCandidate[] = [];
    const inventoryAction = previews.find(
        (preview) => preview.usable && preview.action.kind === 'inventory',
    )?.action;

    if (inventoryAction) {
        candidates.push(...buildItemCandidates(context, inventoryAction));
    }

    for (const preview of previews) {
        if (!preview.usable) continue;

        const { action } = preview;
        if (EXCLUDED_KINDS.has(action.kind) || action.kind === 'inventory') continue;

        if (actionRequiresExplicitTarget(action)) {
            for (const targetId of preview.targetIds) {
                const targetIds = action.targeting === 'enemies_lane'
                    ? laneTargetIds(context, preview.targetIds, targetId)
                    : [targetId];
                candidates.push({
                    action,
                    key: `${action.id}:${targetId}`,
                    targetId,
                    targetIds,
                });
            }
            continue;
        }

        // `self` targets resolve to the actor; the team scopes carry their list.
        const targetIds = action.targeting === 'self' ? [actor.id] : [...preview.targetIds];
        candidates.push({ action, key: action.id, targetId: null, targetIds });
    }

    return candidates;
}

/** One candidate per usable item, split by explicit target when required. */
function buildItemCandidates(
    context: AiDecisionContext,
    inventoryAction: CombatAction,
): AiCandidate[] {
    const { actor } = context;
    const inventory = (context.inventory ?? {}) as Record<string, number>;
    const candidates: AiCandidate[] = [];

    for (const { itemId, item } of getUsableCombatItems(inventory)) {
        if (item.effects.length === 0) continue;

        const rules = itemTargetRules(item);
        const singleRules = rules.filter(isSingleTargetRule);
        const targetIds = uniqueIds(singleRules.flatMap(
            (rule) => legalItemTargetIds(context.state, actor, rule),
        ));

        if (targetIds.length > 0) {
            for (const targetId of targetIds) {
                const target = context.state.units.find((unit) => unit.id === targetId) ?? null;
                const affected = uniqueIds(rules.flatMap(
                    (rule) => resolveItemTargets(context.state, actor, rule, target)
                        .map((unit) => unit.id),
                ));
                candidates.push({
                    action: inventoryAction,
                    key: `inventory:${itemId}:${targetId}`,
                    targetId,
                    targetIds: affected,
                    itemId,
                });
            }
            continue;
        }

        const affected = uniqueIds(rules.flatMap(
            (rule) => resolveItemTargets(context.state, actor, rule, null)
                .map((unit) => unit.id),
        ));
        if (affected.length === 0) continue;

        candidates.push({
            action: inventoryAction,
            key: `inventory:${itemId}`,
            targetId: null,
            targetIds: affected,
            itemId,
        });
    }

    return candidates;
}

/** Every distinct targeting rule an item can resolve to. */
function itemTargetRules(item: ItemDefinition): ItemTargetRule[] {
    return [...new Set<ItemTargetRule>([
        item.target,
        ...item.effects.map((effect) => effect.target ?? item.target),
    ])];
}

function uniqueIds(ids: readonly string[]): string[] {
    return [...new Set(ids)];
}

/**
 * The units a lane-scoped action actually hits when aimed at `aimId`.
 *
 * `legalTargetIds` only exposes the aim pool; resolution crashes over the aim's
 * whole line, so the candidate carries that line to score the real coverage.
 */
function laneTargetIds(
    context: AiDecisionContext,
    legalTargetIds: readonly string[],
    aimId: string,
): string[] {
    const aim = context.state.units.find((unit) => unit.id === aimId);
    if (!aim) return [aimId];

    const byId = new Map(context.state.units.map((unit) => [unit.id, unit]));
    const lane = legalTargetIds.filter((id) => {
        const unit = byId.get(id);
        return unit !== undefined && unit.side === aim.side && unit.line === aim.line;
    });

    return lane.length > 0 ? lane : [aimId];
}

/** The live units a candidate would land on. */
export function candidateTargetUnits(
    context: AiDecisionContext,
    candidate: AiCandidate,
): CombatUnit[] {
    const byId = new Map(context.state.units.map((unit) => [unit.id, unit]));
    return candidate.targetIds
        .map((id) => byId.get(id))
        .filter((unit): unit is CombatUnit => unit !== undefined);
}
