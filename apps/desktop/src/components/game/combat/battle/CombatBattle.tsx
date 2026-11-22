/**
 * Generalized battle screen.
 *
 * The single component the game composes a fight with: the battlefield where the
 * characters stand, and below it the active character's HUD (vitals, four attack
 * slots and the extra movements). Everything it draws is derived from a
 * `CombatState` produced by the combat backend, so it is the seam between
 * `services/combatService` and the presentation components.
 *
 * Whose turn it is does not remove the action area: a player-owned unit gets the
 * usable actions, and during anybody else's turn the same HUD stays on screen with
 * the player's reserve unit, inert, so the battlefield never changes size.
 */

import { useMemo } from 'react';
import type { CombatAction, CombatUnit } from '../../../../types/CombatType';
import { effectiveTimePhase } from '../../../../services/combat/phaseOverride';
import type { CombatBattleProps } from './CombatBattle.types';
import { CombatFormationHUD } from '../formation/CombatFormationHUD';
import { CombatHUD } from '../hud/CombatHUD';
import {
    indexActionsById,
    selectTurnUnit,
    toAttackCards,
    toExtraMovements,
    toFormationSides,
    toHudStats,
} from './combatBattleView';

export type { CombatBattleProps } from './CombatBattle.types';
export type { CombatFormationSides, CombatSpriteResolver } from './combatBattleView';

export function CombatBattle({
    state,
    sequence,
    animationsEnabled = true,
    previews,
    pendingActionId = null,
    targetIds,
    targetPreviews,
    resolveSpriteUrl,
    onActionSelect,
    onExtraMovementSelect,
    onEntitySelect,
    tooltipVisible,
    gridConfig,
    leftSide,
    className = '',
}: CombatBattleProps) {
    const turnUnit = useMemo(() => selectTurnUnit(state), [state]);
    // While a step is being narrated the turn has not really moved on yet: the actor keeps
    // the marker and nobody is offered actions until the choreography finishes.
    const busy = sequence != null;
    // Only the player's own idle turn offers actions; an opponent's turn is watched.
    const playerTurn = !busy && turnUnit?.isPlayerControlled === true;
    // The HUD never goes away: during a turn the player does not own it keeps showing
    // that player's reserve unit, just with every action out of reach.
    const playerOwnsTurn = turnUnit?.isPlayerControlled === true;

    /**
     * The first living player-controlled unit, in turn order.
     *
     * Used as the HUD unit while the turn belongs to an opponent: there is nobody to
     * hand actions to, but the player's own vitals stay readable.
     */
    const reserveUnit = useMemo(() => {
        for (const id of state.order) {
            const unit = state.units.find((candidate) => candidate.id === id);
            if (unit?.isPlayerControlled && unit.status === 'alive') return unit;
        }
        return state.units.find((unit) => unit.isPlayerControlled && unit.status === 'alive') ?? null;
    }, [state]);

    /** The HUD shows the acting player unit; during an opponent's turn, the reserve unit. */
    const hudUnit = playerOwnsTurn ? turnUnit : reserveUnit;

    const sides = useMemo(() => {
        // The caller decides which semantic side stands on the left. Sprite facing
        // follows the drawn side, so tell the resolver where each unit is drawn
        // instead of assuming a canonical orientation and flipping the rest.
        const resolve = resolveSpriteUrl
            ? (unit: CombatUnit) => resolveSpriteUrl(
                unit,
                unit.side === leftSide ? 'left' : 'right',
            )
            : undefined;
        const formation = toFormationSides(state.units, resolve);

        return leftSide === 'allies'
            ? formation
            : { allies: formation.adversaries, adversaries: formation.allies };
    }, [state.units, resolveSpriteUrl, leftSide]);
    const stats = useMemo(() => toHudStats(hudUnit), [hudUnit]);
    // Cards are only usable on the player's own (idle) turn; while a step plays out they are
    // shown as out of reach, so the HUD can stay on screen without inviting a click.
    const attacks = useMemo(
        () => toAttackCards(hudUnit?.actions ?? [], previews, hudUnit).map((attack) => (
            playerTurn ? attack : { ...attack, disabled: true, disabledReason: undefined }
        )),
        [hudUnit, previews, playerTurn],
    );
    const extraMovements = useMemo(
        () => toExtraMovements(hudUnit?.actions ?? [], previews, hudUnit).map((movement) => (
            playerTurn ? movement : { ...movement, disabled: true, disabledReason: undefined }
        )),
        [hudUnit, previews, playerTurn],
    );
    const actionsById = useMemo(() => indexActionsById(hudUnit?.actions ?? []), [hudUnit]);

    /** Traces a clicked card back to the action it stands for. */
    const emitAction = (actionId: string, handler?: (action: CombatAction) => void) => {
        const action = actionsById.get(actionId);
        if (action) handler?.(action);
    };

    return (
        <section
            aria-label={state.encounterName}
            className={`flex h-full min-h-0 flex-col bg-galatime-background text-white ${className}`}
        >
            {/* Battlefield — where the characters stand */}
            <div className="min-h-0 flex-1">
                <CombatFormationHUD
                    allies={sides.allies}
                    adversaries={sides.adversaries}
                    activeUnitId={sequence?.actorId ?? turnUnit?.id}
                    targetableIds={playerTurn ? targetIds : undefined}
                    targetPreviews={targetPreviews}
                    sequence={sequence}
                    animationsEnabled={animationsEnabled}
                    hour={state.hour}
                    timePhase={effectiveTimePhase(state)}
                    onEntitySelect={(entity) => {
                        if (entity) onEntitySelect?.(entity.id);
                    }}
                    tooltipVisible={tooltipVisible}
                    className="h-full"
                />
            </div>

            {/* Combat HUD — the active character's vitals, attacks and movements.
                It stays on screen for the whole fight: on an opponent's turn it holds
                the player's reserve unit with every action inert. */}
            <div
                aria-label="Combat actions"
                className={`shrink-0 bg-galatime-background px-2 pb-2 pt-1 ${playerTurn ? '' : 'pointer-events-none'}`}
            >
                {hudUnit && (
                    <CombatHUD
                        unitId={hudUnit.id}
                        hp={stats.hp}
                        mana={stats.mana}
                        stamina={stats.stamina}
                        attacks={attacks}
                        extraMovements={extraMovements}
                        gridConfig={gridConfig}
                        selectedActionId={pendingActionId}
                        onAttackClick={(attack) => emitAction(String(attack.id), onActionSelect)}
                        onExtraMovementClick={(movement) => emitAction(movement.id, onExtraMovementSelect)}
                    />
                )}
            </div>
        </section>
    );
}

export default CombatBattle;
