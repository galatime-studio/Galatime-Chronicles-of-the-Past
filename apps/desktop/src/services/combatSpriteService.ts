import { getEntityImages } from './entityImageService';
import type { CombatUnit } from '../types/CombatType';
import type { CombatSpriteSelection } from '../components/game/combat/battle/combatBattleView';

/**
 * Sprite a combat unit is drawn with, resolved from the bundled sprite index.
 *
 * The battle is drawn side-view with both sides facing the centre. Characters use
 * sprites from their `combat/` subfolder, mobs use sprites from their root folder.
 * The entity ships one sprite per facing, so the resolver picks the sprite for the
 * side of the board the unit is drawn on: left units face right, right units face
 * left. `visualSide` is supplied when a mirrored board draws the semantic sides on
 * the opposite side.
 *
 * `mirrored` is only a fallback for an entity that is missing the facing it needs.
 */
export function resolveUnitSprite(
    unit: CombatUnit,
    visualSide?: 'left' | 'right',
): CombatSpriteSelection | undefined {
    const images = getEntityImages({ type: unit.entityType, id: unit.entityId, name: unit.name });
    const drawnOn = visualSide ?? (unit.side === 'allies' ? 'left' : 'right');
    const wanted = drawnOn === 'left' ? 'right' : 'left';
    const opposite = wanted === 'right' ? 'left' : 'right';

    const byFacing = images.find((image) => image.name.includes(wanted));
    if (byFacing) return { url: byFacing.url };

    const byOppositeFacing = images.find((image) => image.name.includes(opposite));
    if (byOppositeFacing) return { url: byOppositeFacing.url, mirrored: true };

    const fallback = images.find((image) => image.url.includes('/combat/'))?.url ?? images[0]?.url;
    return fallback ? { url: fallback } : undefined;
}
