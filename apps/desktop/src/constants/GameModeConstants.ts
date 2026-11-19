/**
 * The three ways a chronicle can be played.
 *
 * The mode is chosen when a save is created and shapes the whole New Game setup:
 * the capabilities below decide which questions are worth asking at all. A mode
 * without combat must not ask for a difficulty or combat animations, and a mode
 * without dialogue must not ask for a text speed.
 *
 * Keep the capabilities and the questions in sync through `newGameFlowModel`, which
 * derives the step list from this table instead of hard-coding one per mode.
 */
export const GAME_MODES = {
  story: {
    id: 'story',
    title: 'newGame.modes.story.title',
    description: 'newGame.modes.story.description',
    hasCombat: false,
    hasDialogue: true,
    hasExploration: true,
    hasAllies: false,
  },
  normal: {
    id: 'normal',
    title: 'newGame.modes.normal.title',
    description: 'newGame.modes.normal.description',
    hasCombat: true,
    hasDialogue: true,
    hasExploration: true,
    hasAllies: true,
  },
  survival: {
    id: 'survival',
    title: 'newGame.modes.survival.title',
    description: 'newGame.modes.survival.description',
    hasCombat: true,
    hasDialogue: false,
    hasExploration: false,
    hasAllies: true,
  },
} as const;

export type GameMode = keyof typeof GAME_MODES;
export type GameModeItem = (typeof GAME_MODES)[GameMode];

/** Display order of the modes, from the most narrative to the most combat-focused. */
export const GAME_MODE_ORDER: readonly GameMode[] = ['story', 'normal', 'survival'];

/** Narrows an untrusted value, such as one read from a save file or settings JSON. */
export function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GAME_MODES, value);
}
