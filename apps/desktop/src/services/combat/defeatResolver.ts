/**
 * Reaping the defeated.
 *
 * Marking a unit defeated is not just bookkeeping: its `on_death` abilities run
 * there (a slime bursts into two slimes). That can cascade — a reflection fired
 * from an `after_damage` ability may drop the attacker, and a split adds units
 * that must not be reaped by the pass that created them — so the sweep loops
 * instead of running once.
 *
 * It lives in its own module because two very different callers need it: the
 * action resolver (a hit just landed) and the turn loop (a status killed its host
 * as its turn began).
 */

import type { CombatEvent, CombatRandom, CombatState, CombatUnit } from '../../types/CombatType';
import { passiveTriggerContext } from './abilityContext';
import { resolveAbilityEvent } from './abilityTriggers';
import { changeResource, effectiveStats, removeEffect } from './effectResolver';
import { deployHoldLanes } from './holdLanes';
import { promoteRearLines } from './lanePromotion';

/** Passes allowed while reaping: a reflection or a split can kill again. */
const MAX_REAP_PASSES = 8;

/**
 * Marks every unit at zero HP as defeated and fires its `on_death` abilities.
 *
 * Death clears the unit's effects, bracing and immunities, so nothing lingers on
 * a corpse. A unit brought in by a split is alive, so the same sweep cannot reap
 * it again.
 */
export function reapDefeated(state: CombatState, events: CombatEvent[], random: CombatRandom): void {
    let reaped = false;

    for (let pass = 0; pass < MAX_REAP_PASSES; pass += 1) {
        const fallen = state.units.filter((unit) => unit.status === 'alive' && unit.currentHp <= 0);
        if (fallen.length === 0) break;

        const defeatedNow: CombatUnit[] = [];

        for (const unit of fallen) {
            // A rescue rune answers the first defeat and leaves its bearer at 1 HP.
            if (unit.flags.rescueIgnored !== true && tryRescueRune(unit, events)) {
                continue;
            }
            delete unit.flags.rescueIgnored;

            // A resurrection link drags the linked ally down with its caster.
            for (const linked of state.units) {
                if (linked.status !== 'alive' || linked.id === unit.id) continue;
                if (!linked.effects.some((effect) => effect.fateLink?.casterId === unit.id)) continue;
                linked.flags.rescueIgnored = true;
                linked.currentHp = 0;
            }

            unit.status = 'defeated';
            unit.currentHp = 0;
            unit.effects = [];
            unit.defending = false;
            unit.immunities = [];
            unit.lockedTargetId = null;
            unit.lockedByEffectId = null;
            events.push({ type: 'unit_defeated', unitId: unit.id });
            defeatedNow.push(unit);
        }

        if (defeatedNow.length === 0) break;
        reaped = true;

        // A `heal_on_kill` status (Blood Moon) pays every holder for each death
        // on the battlefield, whoever landed the blow.
        for (const unit of defeatedNow) payKillHeals(state, unit.id, events);

        for (const unit of defeatedNow) {
            events.push(...resolveAbilityEvent(state, unit, 'on_death', passiveTriggerContext(random, state.units)));
        }
    }

    // A death can empty a side's front line, and an empty front line cannot hold
    // the fight: the rear steps up as part of the same sweep.
    if (reaped) promoteRearLines(state, events);

    // A wave waiting off the field enters when the rear line empties out. It is
    // checked even without a death: a rear unit may have stepped forward on its
    // own, and the next on-hold lane is due either way.
    deployHoldLanes(state, events);
}

/** Consumes a rescue rune and leaves its bearer standing at 1 HP. */
function tryRescueRune(unit: CombatUnit, events: CombatEvent[]): boolean {
    const rune = unit.effects.find((effect) => effect.rescueRune);
    if (!rune?.rescueRune) return false;

    unit.currentHp = 0;
    const stats = effectiveStats(unit);

    events.push(...removeEffect(unit, rune));
    events.push(...changeResource(unit, 'hp', 1));
    events.push(...changeResource(
        unit,
        'mana',
        Math.round(stats.maxMana * rune.rescueRune.manaPercent / 100),
    ));
    events.push(...changeResource(
        unit,
        'stamina',
        Math.round(stats.maxStamina * rune.rescueRune.staminaPercent / 100),
    ));

    return true;
}

/**
 * Heals every living holder of a `heal_on_kill` status for one death.
 *
 * The heal is `flat + percent × maxHp`; the fallen unit is already marked
 * defeated and stripped of its effects, so a corpse cannot heal itself.
 */
function payKillHeals(state: CombatState, fallenId: string, events: CombatEvent[]): void {
    for (const holder of state.units) {
        if (holder.status !== 'alive' || holder.id === fallenId) continue;

        for (const effect of holder.effects) {
            const heal = effect.healOnKill;
            if (!heal) continue;

            const amount = Math.round(heal.flat + effectiveStats(holder).maxHp * heal.percent);
            if (amount > 0) events.push(...changeResource(holder, 'hp', amount));
        }
    }
}

