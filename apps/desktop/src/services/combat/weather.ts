import type { CombatEvent, CombatSide, CombatState, CombatWeather } from '../../types/CombatType';
import { asRecord, readNumber } from '../../utils/combatUtils';
import type { AttackEffect } from '../../types/AttackDataType';
import { changeResource, readNumberRecord } from './effectResolver';

/** The side that enjoys the weather; the other side pays its chip damage. */
type WeatherSide = CombatSide;

/** The authored `weather` record of one effect. */
export interface WeatherAppSpec {
    rounds: number;
    chipDamage: number;
    elementEffectMultipliers: Record<string, number>;
}

/** Reads an effect's `weather` clause; authored values, no defaults imposed. */
export function readWeatherSpec(effect: AttackEffect | unknown): WeatherAppSpec | null {
    const record = asRecord(asRecord(effect)?.weather);
    if (!record) return null;

    const rounds = Math.max(0, Math.round(readNumber(record.rounds, 3)));
    const chipDamage = Math.max(0, readNumber(record.chip_damage, 0));
    const elementEffectMultipliers = readNumberRecord(record.element_effect_multipliers) ?? {};

    return { rounds, chipDamage, elementEffectMultipliers };
}

/**
 * Forces one battlefield-wide weather state (`Rain`, `Storm`).
 *
 * Weather replaces whichever state already holds — the last raised weather
 * wins. The skill's side enjoys it; the opposing side pays the chip.
 */
export function applyWeather(
    state: Pick<CombatState, 'weather'>,
    skillId: string,
    label: string,
    side: WeatherSide,
    spec: WeatherAppSpec,
): CombatEvent[] {
    const weather: CombatWeather = {
        id: skillId,
        label,
        side,
        rounds: Math.max(1, spec.rounds || 3),
        elementEffectMultipliers: spec.elementEffectMultipliers,
        chipDamage: spec.chipDamage,
    };
    state.weather = weather;

    return [{ type: 'weather_changed', id: weather.id, label: weather.label, rounds: weather.rounds }];
}

/**
 * Runs the weather one round forward at a round boundary.
 *
 * The opposing side pays the flat chip damage, the countdown falls, and the
 * sky clears when it reaches zero. The caller reaps any unit the chip fells.
 */
export function tickWeather(state: Pick<CombatState, 'units' | 'weather'>): CombatEvent[] {
    const weather = state.weather;
    if (!weather) return [];

    const events: CombatEvent[] = [];

    if ((weather.chipDamage ?? 0) > 0) {
        for (const unit of state.units) {
            if (unit.status !== 'alive' || unit.side === weather.side) continue;
            events.push(...changeResource(unit, 'hp', -weather.chipDamage));
        }
    }

    if (weather.rounds <= 1) {
        state.weather = null;
        events.push({ type: 'weather_ended', id: weather.id });
    } else {
        state.weather = { ...weather, rounds: weather.rounds - 1 };
    }

    return events;
}

/** The weather's multiplier for one action's element; texts ×1 when absent. */
export function weatherElementMultiplierFor(
    state: Pick<CombatState, 'weather'>,
    elementId: string | null | undefined,
): number {
    if (!state.weather || !elementId) return 1;
    return state.weather.elementEffectMultipliers[elementId] ?? 1;
}
