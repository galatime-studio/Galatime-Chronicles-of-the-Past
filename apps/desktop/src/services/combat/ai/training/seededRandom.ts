/** Reproducible, serialisable PRNG for scenario generation and combat A/B runs. */

import type { CombatRandom } from '../../../../types/CombatType';

export interface SeededCombatRandom extends CombatRandom {
    /** Internal state, suitable for restoring a counterfactual branch. */
    snapshot(): number;
    restore(state: number): void;
    /** Independent stream derived from the original seed; does not advance this stream. */
    fork(label: string): SeededCombatRandom;
}

/** Stable 32-bit hash; numeric seeds retain their exact value. */
export function hashAiSeed(seed: number | string): number {
    if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;

    const text = String(seed);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

/** Mulberry32: small, fast and sufficient for reproducible combat simulations. */
export function createSeededCombatRandom(seed: number | string): SeededCombatRandom {
    const initialSeed = hashAiSeed(seed);
    let state = initialSeed;

    const random = (() => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    }) as SeededCombatRandom;

    random.snapshot = () => state;
    random.restore = (nextState) => {
        if (!Number.isFinite(nextState)) throw new RangeError('RNG state must be finite.');
        state = nextState >>> 0;
    };
    random.fork = (label) => createSeededCombatRandom(`${initialSeed}:${label}`);

    return random;
}

/** Random integer in the inclusive authored band. */
export function randomInt(random: CombatRandom, min: number, max: number): number {
    const low = Math.ceil(Math.min(min, max));
    const high = Math.floor(Math.max(min, max));
    return low + Math.floor(random() * (high - low + 1));
}

/** Stable uniform pick; throws on an empty pool instead of returning undefined. */
export function randomPick<T>(random: CombatRandom, values: readonly T[]): T {
    if (values.length === 0) throw new RangeError('Cannot pick from an empty training pool.');
    return values[Math.min(values.length - 1, Math.floor(random() * values.length))];
}

/** Uniform sample without replacement, preserving no catalogue-order dependency. */
export function randomSample<T>(random: CombatRandom, values: readonly T[], count: number): T[] {
    const remaining = [...values];
    const sample: T[] = [];
    const target = Math.max(0, Math.min(count, values.length));

    while (sample.length < target) {
        const index = Math.floor(random() * remaining.length);
        sample.push(remaining.splice(index, 1)[0]);
    }

    return sample;
}
