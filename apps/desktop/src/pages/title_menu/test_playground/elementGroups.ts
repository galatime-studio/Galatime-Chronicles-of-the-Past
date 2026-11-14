import type { ElementData } from '../../../types/ElementDataType';

/**
 * One band of elements that share a kind.
 */
export interface ElementGroup {
    /** The kind as the catalogue spells it (`natural`, `corrupted`, …). */
    type: string;
    /** The label the band is shown under. */
    label: string;
    elements: ElementData[];
}

/**
 * Turns a kind into a readable label.
 *
 * The catalogue may grow kinds the game has no word for yet; the raw key spelled
 * out still reads better than an empty band.
 */
export function humanizeElementType(type: string): string {
    const words = type.replace(/[_-]+/g, ' ').trim();
    if (!words) return type;
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Groups the elements by kind, in the order the catalogue lists them.
 *
 * Nothing here knows the kinds: a kind the game invents later shows up as a band
 * of its own, without a line of code changing.
 */
export function groupElementsByType(
    elements: readonly ElementData[],
    labelFor: (type: string) => string,
): ElementGroup[] {
    const bands = new Map<string, ElementData[]>();

    for (const element of elements) {
        const band = bands.get(element.type);
        if (band) band.push(element);
        else bands.set(element.type, [element]);
    }

    return [...bands.entries()].map(([type, band]) => ({
        type,
        label: labelFor(type),
        // Inside a band the name is what tells two elements apart.
        elements: [...band].sort((left, right) => left.name.localeCompare(right.name)),
    }));
}
