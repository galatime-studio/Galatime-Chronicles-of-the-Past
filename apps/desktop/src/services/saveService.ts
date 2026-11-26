import { invoke } from '@tauri-apps/api/core';
import { clampDialogueTextSpeed, DIALOGUE_DEFAULT_TEXT_SPEED } from '../constants/DialogueConstants';
import { isAllyControl, type AllyControl } from '../constants/AllyControlConstants';
import { isDifficulty, type Difficulty } from '../constants/DifficultyConstants';
import { isGameMode, type GameMode } from '../constants/GameModeConstants';
import { normalizeSurvivalRun } from '../constants/SurvivalConstants';
import type { SurvivalRun } from '../types/SurvivalType';
import { resolveSeed } from '../utils/seedUtils';

export const SAVE_SLOTS = [1, 2, 3, 4, 5] as const;
export type SaveSlot = (typeof SAVE_SLOTS)[number];

/** Bump only when the shape below changes incompatibly. */
export const SAVE_VERSION = 1;

/** Which hints the player asked the chronicle to draw. */
export interface SaveTooltipSettings {
  fighting: boolean;
  actions: boolean;
  dialogue: boolean;
}

/**
 * Everything the New Game wizard asks the player.
 *
 * This is the save-level record, kept apart from `GameSettings` (which also holds
 * machine-wide choices such as volume, language and key bindings). Creating or
 * editing a save applies the answers here to the running settings so the setup
 * matters before there is a gameplay screen.
 */
export interface SaveData {
  version: number;
  name: string;
  /** Fixed at creation; every random draw in the chronicle derives from it. */
  seed: number;
  gameMode: GameMode;
  difficulty: Difficulty;
  allyControl: AllyControl;
  tooltips: SaveTooltipSettings;
  combatAnimations: boolean;
  dialogueTextSpeed: number;
  showNowPlayingMusic: boolean;
  /** Survival Mode's carried state; unused by the other modes. */
  survival: SurvivalRun;
  /** ISO timestamp of the first creation; preserved when the save is edited. */
  createdAt: string;
}

const localKey = (slot: SaveSlot) => `galatime.save.${slot}`;

function readLocalSave(slot: SaveSlot): string | null {
  try {
    return window.localStorage.getItem(localKey(slot));
  } catch {
    return null;
  }
}

/** Reads the raw JSON of a slot from the shell, falling back to browser storage. */
async function readSaveContents(slot: SaveSlot): Promise<string | null> {
  try {
    return await invoke<string | null>('read_save', { slot });
  } catch {
    return readLocalSave(slot);
  }
}

/**
 * Normalises anything found in a save slot.
 *
 * Older builds wrote only `{ name, elements, money, mainObjective }`; those
 * saves must stay visible in the list instead of disappearing. Missing values
 * resolve to the same defaults the wizard starts from.
 */
function normalizeSaveData(raw: unknown): SaveData | null {
  if (!raw || typeof raw !== 'object') return null;

  const data = raw as Partial<SaveData>;
  if (typeof data.name !== 'string') return null;

  const textSpeed = typeof data.dialogueTextSpeed === 'number' && Number.isFinite(data.dialogueTextSpeed)
    ? clampDialogueTextSpeed(data.dialogueTextSpeed)
    : DIALOGUE_DEFAULT_TEXT_SPEED;
  // Saves written before seeds existed derive one from what they already say,
  // so repeated reads agree instead of giving every visit a different run.
  const seed = typeof data.seed === 'number' && Number.isFinite(data.seed)
    ? data.seed >>> 0
    : resolveSeed(`${data.name}:${typeof data.createdAt === 'string' ? data.createdAt : ''}`);

  return {
    version: SAVE_VERSION,
    name: data.name,
    seed,
    gameMode: isGameMode(data.gameMode) ? data.gameMode : 'normal',
    difficulty: isDifficulty(data.difficulty) ? data.difficulty : 'normal',
    allyControl: isAllyControl(data.allyControl) ? data.allyControl : 'player',
    tooltips: {
      fighting: data.tooltips?.fighting !== false,
      actions: data.tooltips?.actions !== false,
      dialogue: data.tooltips?.dialogue !== false,
    },
    combatAnimations: data.combatAnimations !== false,
    dialogueTextSpeed: textSpeed,
    showNowPlayingMusic: data.showNowPlayingMusic !== false,
    survival: normalizeSurvivalRun(data.survival),
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
  };
}

/**
 * Reads and normalises a slot.
 *
 * Returns `null` for an empty slot or for contents that cannot be understood.
 */
export async function readSave(slot: SaveSlot): Promise<SaveData | null> {
  const contents = await readSaveContents(slot);
  if (contents === null) return null;

  try {
    return normalizeSaveData(JSON.parse(contents));
  } catch {
    return null;
  }
}

export async function createSave(slot: SaveSlot, data: SaveData): Promise<void> {
  const contents = JSON.stringify(data);
  try {
    await invoke('write_save', { slot, contents });
    return;
  } catch {
    try {
      window.localStorage.setItem(localKey(slot), contents);
    } catch {
      // Browser storage can be unavailable in restricted preview contexts.
    }
  }
}

export async function deleteSave(slot: SaveSlot): Promise<void> {
  try {
    await invoke('delete_save', { slot });
    return;
  } catch {
    try {
      window.localStorage.removeItem(localKey(slot));
    } catch {
      // Browser storage can be unavailable in restricted preview contexts.
    }
  }
}

/**
 * Opens the OS file explorer at the folder that stores the save files.
 * Returns `false` when there is no Tauri bridge (Vite/browser mode).
 */
export async function revealSavesFolder(): Promise<boolean> {
  try {
    await invoke('reveal_saves_folder');
    return true;
  } catch {
    return false;
  }
}
