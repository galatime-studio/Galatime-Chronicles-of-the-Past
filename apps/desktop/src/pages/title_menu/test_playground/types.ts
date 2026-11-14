import type { CharacterData, MobData } from '../../../types/EntityDataType';

export type PlaygroundTab = 'music' | 'entities' | 'dialogue' | 'combat' | 'objectives' | 'movement' | 'elements' | 'items';

/** A selectable entity shown in the playground's entity sidebar/tab. */
export type EntityItem = {
    id: string;
    name: string;
    type: 'character' | 'mob';
    data: CharacterData | MobData;
};
