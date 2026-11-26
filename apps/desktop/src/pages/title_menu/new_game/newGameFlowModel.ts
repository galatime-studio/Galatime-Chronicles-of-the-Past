import type { GameSettings } from '../../../context/GameContext';
import type { SaveData } from '../../../services/saveService';
import type { AllyControl } from '../../../constants/AllyControlConstants';
import { DIALOGUE_DEFAULT_TEXT_SPEED, flipDialogueTextSpeed } from '../../../constants/DialogueConstants';
import { createDefaultSurvivalRun } from '../../../constants/SurvivalConstants';
import type { Difficulty } from '../../../constants/DifficultyConstants';
import { GAME_MODES, type GameMode } from '../../../constants/GameModeConstants';
import { createRandomSeed, resolveSeed } from '../../../utils/seedUtils';

/** The answers the New Game wizard collects. */
export interface NewGameDraft {
  saveName: string;
  /** The seed exactly as typed; `toSaveData` resolves it to the stored number. */
  seedInput: string;
  gameMode: GameMode;
  difficulty: Difficulty;
  allyControl: AllyControl;
  fightingTooltipVisible: boolean;
  actionsTooltipVisible: boolean;
  dialogueTooltipVisible: boolean;
  combatAnimations: boolean;
  dialogueTextSpeed: number;
  showNowPlayingMusic: boolean;
}

/** The parts of the current settings a new chronicle starts from. */
export type NewGameDefaults = Pick<
  GameSettings,
  | 'difficulty'
  | 'allyControl'
  | 'fightingTooltipVisible'
  | 'actionsTooltipVisible'
  | 'dialogueTooltipVisible'
  | 'combatAnimations'
  | 'dialogueTextSpeed'
  | 'showNowPlayingMusic'
>;

export type NewGameStepId =
  | 'mode'
  | 'difficulty'
  | 'seed'
  | 'tooltips'
  | 'allies'
  | 'presentation'
  | 'name';

/**
 * The steps a mode actually needs.
 *
 * The mode is always asked first, then only the questions its capabilities make
 * meaningful: Story has no combat, so no difficulty or combat animations;
 * Survival has no dialogue, so no text speed or dialogue hint; and a mode
 * without exploration has no interactable objects to point out. Ally control is
 * asked whenever the mode configures it, even if no allies exist yet.
 */
export function getNewGameSteps(mode: GameMode): readonly NewGameStepId[] {
  const capabilities = GAME_MODES[mode];
  const steps: NewGameStepId[] = ['mode'];

  if (capabilities.hasCombat) steps.push('difficulty');
  // Every mode owns a seed, even the ones without randomness yet, so future
  // systems can derive from it without migrating saves.
  steps.push('seed');
  steps.push('tooltips');
  if (capabilities.configuresAllyControl) steps.push('allies');
  steps.push('presentation');
  steps.push('name');

  return steps;
}

export function createNewGameDraft(defaults: NewGameDefaults): NewGameDraft {
  return {
    saveName: '',
    // Prefilled so the wizard already answers the question; the player may
    // replace it with a number or any words they prefer.
    seedInput: String(createRandomSeed()),
    // A new chronicle always starts on Normal; only an edit reopens a different mode.
    gameMode: 'normal',
    difficulty: defaults.difficulty,
    allyControl: defaults.allyControl,
    fightingTooltipVisible: defaults.fightingTooltipVisible,
    actionsTooltipVisible: defaults.actionsTooltipVisible,
    dialogueTooltipVisible: defaults.dialogueTooltipVisible,
    combatAnimations: defaults.combatAnimations,
    dialogueTextSpeed: defaults.dialogueTextSpeed,
    showNowPlayingMusic: defaults.showNowPlayingMusic,
  };
}

export function createDraftFromSave(save: SaveData): NewGameDraft {
  return withGameMode(
    {
      saveName: save.name,
      // The stored seed is already resolved; editing never changes it.
      seedInput: String(save.seed),
      gameMode: save.gameMode,
      difficulty: save.difficulty,
      allyControl: save.allyControl,
      fightingTooltipVisible: save.tooltips.fighting,
      actionsTooltipVisible: save.tooltips.actions,
      dialogueTooltipVisible: save.tooltips.dialogue,
      combatAnimations: save.combatAnimations,
      dialogueTextSpeed: save.dialogueTextSpeed,
      showNowPlayingMusic: save.showNowPlayingMusic,
    },
    save.gameMode,
  );
}

/**
 * Changes the mode and clears the answers the new mode will never ask.
 *
 * Without this, switching Normal -> Story and back could silently carry a
 * difficulty the player never chose for the Story run into a combat save.
 */
export function withGameMode(draft: NewGameDraft, mode: GameMode): NewGameDraft {
  const capabilities = GAME_MODES[mode];

  return {
    ...draft,
    gameMode: mode,
    difficulty: capabilities.hasCombat ? draft.difficulty : 'normal',
    allyControl: capabilities.configuresAllyControl ? draft.allyControl : 'player',
    combatAnimations: capabilities.hasCombat ? draft.combatAnimations : true,
    dialogueTextSpeed: capabilities.hasDialogue ? draft.dialogueTextSpeed : DIALOGUE_DEFAULT_TEXT_SPEED,
    fightingTooltipVisible: capabilities.hasCombat ? draft.fightingTooltipVisible : true,
    actionsTooltipVisible: capabilities.hasExploration ? draft.actionsTooltipVisible : true,
    dialogueTooltipVisible: capabilities.hasDialogue ? draft.dialogueTooltipVisible : true,
  };
}

/** Whether the player may leave the given step. Only the name is required. */
export function canAdvanceNewGameStep(step: NewGameStepId, draft: NewGameDraft): boolean {
  return step !== 'name' || draft.saveName.trim().length > 0;
}

/** The three bands the text-speed slider is labelled with in the review step. */
export type DialogueSpeedBand = 'fast' | 'normal' | 'slow';

export function getDialogueSpeedBand(msPerChar: number): DialogueSpeedBand {
  if (msPerChar <= 20) return 'fast';
  if (msPerChar <= 40) return 'normal';
  return 'slow';
}

/**
 * Converts the draft into the record written to the slot.
 *
 * `previous` supplies the original `createdAt`, so editing a save keeps its
 * place in time instead of pretending it was created again.
 */
export function toSaveData(draft: NewGameDraft, previous?: SaveData | null): SaveData {
  return {
    version: 1,
    name: draft.saveName.trim(),
    // Editing keeps the author's seed: letting it change mid-chronicle would
    // reroll the current round's shelves and waves.
    seed: previous?.seed ?? resolveSeed(draft.seedInput),
    gameMode: draft.gameMode,
    difficulty: draft.difficulty,
    allyControl: draft.allyControl,
    tooltips: {
      fighting: draft.fightingTooltipVisible,
      actions: draft.actionsTooltipVisible,
      dialogue: draft.dialogueTooltipVisible,
    },
    combatAnimations: draft.combatAnimations,
    dialogueTextSpeed: draft.dialogueTextSpeed,
    showNowPlayingMusic: draft.showNowPlayingMusic,
    survival: previous?.survival ?? createDefaultSurvivalRun(),
    createdAt: previous?.createdAt || new Date().toISOString(),
  };
}

/** A slider-space value (low = slow, high = fast) for the stored milliseconds. */
export function toSliderTextSpeed(msPerChar: number): number {
  return flipDialogueTextSpeed(msPerChar);
}

/** The stored milliseconds from a slider-space value. */
export function fromSliderTextSpeed(sliderValue: number): number {
  return flipDialogueTextSpeed(sliderValue);
}
