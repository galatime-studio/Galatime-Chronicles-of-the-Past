import type { DialogueDelivery } from '../../../types/DialogueType';

/**
 * How the ways of speaking are drawn, kept out of the component so the rules
 * can be checked without a DOM.
 *
 * The wording never changes — only how it reads.
 */

/** The deliveries that say something about how a line reads. */
export type VocalDelivery = Exclude<DialogueDelivery, 'spoken'>;

/**
 * How one piece of a line is drawn when the line itself is spoken.
 *
 * A thought is dimmer and slanted, a whisper is smaller and slanted, and a
 * shout is bold and bright.
 */
export const DELIVERY_CLASSES: Record<VocalDelivery, string> = {
    thought: 'italic text-white/55',
    whisper: 'italic text-[0.75em] text-white',
    shout: 'font-bold text-white',
};

/**
 * How the line's own delivery is drawn around everything the box shows.
 *
 * `buildLineView` puts the node's delivery on the plain segments it converts,
 * but a `styled_text` — and a piece the author shouted or whispered on purpose —
 * keeps its own look. That is how colour, bold and shouting used to escape a
 * thought and come back at full strength. Drawing the line's delivery once,
 * around the whole page, means every segment inherits it and a segment's own
 * styling only ever *adds* emphasis on top of it.
 *
 * The thought is an `opacity` rather than a translucent white on purpose: a
 * segment that sets its own colour would beat a colour class outright, but it
 * cannot beat an opacity applied by its parent, so the hue survives and the
 * piece still reads soft and slightly transparent — which is the aspect a
 * thought has to keep.
 */
export const LINE_DELIVERY_CLASSES: Record<VocalDelivery, string> = {
    thought: 'italic opacity-[0.55]',
    whisper: 'italic text-[0.75em]',
    shout: 'font-bold',
};

/**
 * What a segment that speaks in its own voice still needs on top of the line.
 *
 * The line's delivery is already drawn around the page, so a segment that
 * speaks the same way adds nothing: drawing it twice would stack two dims on a
 * thought until the text all but disappeared. A segment that speaks
 * *differently* keeps its own emphasis — a shout inside a thought line stays
 * bold — while the thought's softness still holds it, because that softness
 * lives on the wrapper rather than in the colour the shout sets.
 */
export function segmentDeliveryClass(
    segmentDelivery: VocalDelivery,
    lineDelivery: DialogueDelivery,
): string {
    if (lineDelivery !== 'spoken' && lineDelivery === segmentDelivery) {
        return '';
    }

    return DELIVERY_CLASSES[segmentDelivery];
}
