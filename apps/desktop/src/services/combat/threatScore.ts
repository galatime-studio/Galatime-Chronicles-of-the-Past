import { attackDefenseFactor } from './damageCalculator';

/** Defence an attacker's pressure is measured against. */
export const THREAT_PRESSURE_REFERENCE_DEFENSE = 50;

/** Attack a body's durability is measured against. */
export const THREAT_DURABILITY_REFERENCE_ATTACK = 80;

/** The combat stat block a threat score reads. */
export interface ThreatProfile {
    hp: number;
    physicalAttack: number;
    magicalAttack: number;
    physicalDefense: number;
    magicalDefense: number;
}

/**
 * How much pressure a body applies before it dies.
 *
 * Both terms ride the engine's own mitigation ratio (`attackDefenseFactor`, see
 * `combat-damage-formula`), so the score reads like the combat it describes:
 * the strongest attack against a reference defence, multiplied by the HP the
 * reference attack has to chew through the weakest defence.
 *
 * Survival uses it to price wave slots; progression uses the same reading so XP
 * is proportional to the body the player actually defeated.
 */
export function threatScore({
    hp,
    physicalAttack,
    magicalAttack,
    physicalDefense,
    magicalDefense,
}: ThreatProfile): number {
    const pressure = attackDefenseFactor(
        Math.max(physicalAttack, magicalAttack),
        THREAT_PRESSURE_REFERENCE_DEFENSE,
    );
    const durability = hp / attackDefenseFactor(
        THREAT_DURABILITY_REFERENCE_ATTACK,
        Math.min(physicalDefense, magicalDefense),
    );

    return pressure * durability;
}
