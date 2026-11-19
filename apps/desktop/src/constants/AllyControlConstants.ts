/**
 * How much of the party the player commands in combat.
 *
 * Only asked for modes that have combat. The labels and descriptions live in the
 * `game` namespace because the same choices appear in the settings vocabulary.
 */
export const ALLY_CONTROLS = {
  alliesPlayer: {
    id: 'alliesPlayer',
    title: 'game.settings.allyControl.alliesPlayer.label',
    description: 'game.settings.allyControl.alliesPlayer.description',
  },
  player: {
    id: 'player',
    title: 'game.settings.allyControl.player.label',
    description: 'game.settings.allyControl.player.description',
  },
  playerOnly: {
    id: 'playerOnly',
    title: 'game.settings.allyControl.playerOnly.label',
    description: 'game.settings.allyControl.playerOnly.description',
  },
} as const;

export type AllyControl = keyof typeof ALLY_CONTROLS;
export type AllyControlItem = (typeof ALLY_CONTROLS)[AllyControl];

/** Display order: the most hands-on option first, the least hands-on last. */
export const ALLY_CONTROL_ORDER: readonly AllyControl[] = ['alliesPlayer', 'player', 'playerOnly'];

/** Narrows an untrusted value, such as one read from a save file or settings JSON. */
export function isAllyControl(value: unknown): value is AllyControl {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ALLY_CONTROLS, value);
}
