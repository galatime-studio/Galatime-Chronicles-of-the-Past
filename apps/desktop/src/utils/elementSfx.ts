/**
 * Maps a combat element (and optional variant hint) to an SFX track id
 * registered in `data/audio/sfx.yaml`.
 */
const ELEMENT_SFX_MAP: Record<string, string> = {
    aqua: 'aqua_water',
    caeli: 'caeli',
    chaos: 'chaos_electricity',
    corporis: 'corporis',
    florere: 'florere',
    ignis: 'ignis',
    lapis: 'lapis',
    lux: 'lux',
    spatium: 'spatium',
    umbra: 'umbra',
    vetus: 'vetus',
    vis: 'vis',
};

const VARIANT_OVERRIDES: Record<string, Record<string, string>> = {
    aqua: { ice: 'aqua_ice', water: 'aqua_water' },
    chaos: { explosion: 'chaos_explosion', electricity: 'chaos_electricity' },
};

export function elementSfxId(elementId: string | null | undefined, hint?: string): string | null {
    if (!elementId) return null;
    const base = ELEMENT_SFX_MAP[elementId];
    if (!base) return null;
    if (hint && VARIANT_OVERRIDES[elementId]?.[hint]) {
        return VARIANT_OVERRIDES[elementId][hint];
    }
    const h = (hint ?? '').toLowerCase();
    if (elementId === 'aqua') {
        if (h.includes('ice') || h.includes('gelo') || h.includes('freeze')) return 'aqua_ice';
        if (h.includes('water') || h.includes('agua') || h.includes('água')) return 'aqua_water';
    }
    if (elementId === 'chaos') {
        if (h.includes('explosion') || h.includes('explode')) return 'chaos_explosion';
        if (h.includes('electric') || h.includes('eletric')) return 'chaos_electricity';
    }
    return base;
}