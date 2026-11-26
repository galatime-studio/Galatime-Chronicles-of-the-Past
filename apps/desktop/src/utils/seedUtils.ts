/**
 * Chronicle seeds.
 *
 * A save owns one numeric seed for its whole lifetime. The player may type any
 * text into the setup: plain numbers round-trip exactly, while a word or a
 * sentence is hashed into the seed it stands for. Keeping the resolved number
 * on the save means the same seed always produces the same waves, shelves and
 * combat rolls, no matter how often the fight is reloaded.
 */

import { hashAiSeed } from '../services/combat/ai/training/seededRandom';

const UINT32_RANGE = 0x100000000;

/** A fresh unsigned 32-bit seed for a chronicle that did not choose one. */
export function createRandomSeed(): number {
    const buffer = new Uint32Array(1);

    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(buffer);
        return buffer[0];
    }

    return Math.floor(Math.random() * UINT32_RANGE) >>> 0;
}

/**
 * Resolves the text a player typed into the numeric seed the save stores.
 *
 * Numbers inside the unsigned 32-bit range are kept as they are, so a seed a
 * player shares as a number can be entered back unchanged; anything else is
 * hashed. Blank input draws a fresh seed instead of collapsing every such save
 * onto the same stream.
 */
export function resolveSeed(input: string): number {
    const text = input.trim();
    if (text.length === 0) return createRandomSeed();

    if (/^\d+$/.test(text)) {
        const numeric = Number(text);
        if (Number.isSafeInteger(numeric) && numeric >= 0 && numeric < UINT32_RANGE) {
            return numeric >>> 0;
        }
    }

    return hashAiSeed(text);
}
