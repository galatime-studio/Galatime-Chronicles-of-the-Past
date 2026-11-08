/**
 * Battlefield-wide celestial blocks (eclipses).
 *
 * A fight normally keeps the natural hour it opened at. An eclipse blocks its
 * celestial body for a few rounds: lunar blocks the moon (effective during the
 * night) and solar blocks the sun (effective during the day). Damage/effect
 * bonuses read the resulting {@link EffectiveCombatTimePhase}; rules that only
 * apply during the day/night read the natural {@link CombatState.timePhase}.
 */

import type {
    CombatCelestialBlock,
    CombatState,
    EffectiveCombatTimePhase,
} from '../../types/CombatType';

/**
 * The combat time state damage, effect magnitudes, previews and the HUD see.
 *
 * A block only takes effect when the natural phase matches the body it hides:
 * `solar` → `day_no_solar` during the day, `lunar` → `night_no_lunar` during
 * the night. Otherwise the natural phase is returned unchanged.
 */
export function effectiveTimePhase(
    state: Pick<CombatState, 'timePhase' | 'phaseOverride'>,
): EffectiveCombatTimePhase {
    const { phaseOverride, timePhase } = state;
    if (!phaseOverride) return timePhase;

    if (phaseOverride.blocked === 'solar' && timePhase === 'day') return 'day_no_solar';
    if (phaseOverride.blocked === 'lunar' && timePhase === 'night') return 'night_no_lunar';
    return timePhase;
}

/**
 * Blocks a celestial body for `rounds` rounds.
 *
 * The block is recorded even if the natural phase does not currently match; it
 * will take effect only while the matching natural phase holds. A second block
 * replaces the first (eclipses do not stack).
 */
export function setPhaseBlock(
    state: CombatState,
    blocked: CombatCelestialBlock,
    rounds: number,
    sourceId: string,
): void {
    state.phaseOverride = {
        blocked,
        rounds: Math.max(1, Math.round(rounds)),
        sourceId,
    };
}

/** Spends one round of an active block, clearing it when it runs out. */
export function tickPhaseOverride(state: CombatState): void {
    const override = state.phaseOverride;
    if (!override) return;

    const rounds = override.rounds - 1;
    state.phaseOverride = rounds > 0 ? { ...override, rounds } : null;
}
