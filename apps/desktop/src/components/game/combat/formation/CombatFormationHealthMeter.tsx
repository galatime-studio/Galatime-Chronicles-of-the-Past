import CombatStatsBar from '../hud/CombatStatsBar';

interface CombatFormationHealthMeterProps {
    entityName: string;
    current: number;
    max: number;
    /** Health the pending action would take, previewed as a pulsing band. */
    previewDamage?: number;
    /** Health the pending action would give back, previewed as a pulsing band. */
    previewHeal?: number;
}

/**
 * Health under a formation sprite.
 *
 * The same bar the combat HUD uses, so health drains in red and fills in green
 * with exactly the animations the player's own bars play, preview included.
 */
export function CombatFormationHealthMeter({
    entityName,
    current,
    max,
    previewDamage = 0,
    previewHeal = 0,
}: CombatFormationHealthMeterProps) {
    if (!Number.isFinite(current) || current < 0 || !Number.isFinite(max) || max <= 0) {
        return null;
    }

    const value = Math.min(current, max);

    return (
        <div
            role="meter"
            aria-label={`${entityName} HP`}
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={value}
            aria-valuetext={`${value} / ${max} HP`}
            className="mt-0.5 w-5 sm:w-10"
        >
            <CombatStatsBar
                current={current}
                max={max}
                showTitle={false}
                orientation="ltr"
                previewDeplete={previewDamage}
                previewRestore={previewHeal}
            />
        </div>
    );
}
