import { Fragment, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ALLY_CONTROLS } from '../../constants/AllyControlConstants';
import { DIFFICULTIES } from '../../constants/DifficultyConstants';
import { GAME_MODES } from '../../constants/GameModeConstants';
import { PAGE_ENTER_TRANSITION, PAGE_FADE_TRANSITION } from '../../constants/AnimationConstants';
import { BackButton } from '../../components/common/BackButton';
import CommonButton from '../../components/common/CommonButton';
import { CommonPopup } from '../../components/common/CommonPopup';
import { useGame } from '../../context/GameContext';
import { AddIcon, EditIcon, FolderIcon, TrashIcon } from '../../assets/GalatimeIcon';
import { createSave, deleteSave, readSave, revealSavesFolder, SAVE_SLOTS, type SaveData, type SaveSlot } from '../../services/saveService';
import { playSfx } from '../../controllers/audioController';
import { createNewGameDraft } from './new_game/newGameFlowModel';
import { NewGameFlow } from './new_game/NewGameFlow';
import { EditSaveScreen } from './new_game/EditSaveScreen';
import { SurvivalRunScreen } from './survival/SurvivalRunScreen';

/**
 * Reveal of the folder shortcut: it starts tucked behind the label (shifted left, shrunk and
 * fully transparent) and slides out to its right, using the signature fast-start/silky-settle
 * ease shared by the rest of the title-menu chrome.
 */
const FOLDER_REVEAL_TRANSITION = { duration: 0.24, ease: [0.16, 1, 0.3, 1] as const };

/**
 * Grace period before the shortcut retracts. Without it the icon snaps away the instant the
 * pointer leaves the label, which reads as a glitch when the cursor merely drifts off the
 * title on its way somewhere else.
 */
const FOLDER_HIDE_DELAY = 0.6;

/** Same motion as the reveal, held back by {@link FOLDER_HIDE_DELAY}. */
const FOLDER_HIDE_TRANSITION = { ...FOLDER_REVEAL_TRANSITION, delay: FOLDER_HIDE_DELAY };

const EMPTY_SLOTS: Record<SaveSlot, SaveData | null> = { 1: null, 2: null, 3: null, 4: null, 5: null };

const Diamond = () => (
    <span className="size-1 shrink-0 rotate-45 bg-white/40" aria-hidden="true" />
);

interface FlowState {
    slot: SaveSlot;
    /** The save being edited, or `null` when this flow is creating a new one. */
    save: SaveData | null;
}

/** A save opened for play; currently only Survival Mode has a run to open. */
interface RunState {
    slot: SaveSlot;
    save: SaveData;
}

export function NewGameScreen({ onBack }: { onBack: () => void }) {
    const { t } = useTranslation(['newGame', 'game', 'common']);
    const { gameState, setGameState } = useGame();
    const [saves, setSaves] = useState<Record<SaveSlot, SaveData | null>>(EMPTY_SLOTS);
    const [flow, setFlow] = useState<FlowState | null>(null);
    const [run, setRun] = useState<RunState | null>(null);
    const [deleteSlot, setDeleteSlot] = useState<SaveSlot | null>(null);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const revealed = hovered || focused;

    const openFolder = async () => {
        playSfx('click');
        await revealSavesFolder();
    };

    useEffect(() => {
        let active = true;
        void Promise.all(SAVE_SLOTS.map(async (slot) => [slot, await readSave(slot)] as const)).then((entries) => {
            if (!active) return;
            setSaves(Object.fromEntries(entries) as Record<SaveSlot, SaveData | null>);
        });
        return () => { active = false; };
    }, []);

    const removeSave = async () => {
        if (deleteSlot === null) return;
        const slot = deleteSlot;
        await deleteSave(slot);
        setSaves((previous) => ({ ...previous, [slot]: null }));
        setDeleteSlot(null);
    };

    /** Opens a run from a survival save; other modes have no gameplay screen yet. */
    const openRun = (slot: SaveSlot, save: SaveData) => {
        if (save.gameMode !== 'survival') return;
        playSfx('click');
        setRun({ slot, save });
    };

    /** Writes a run's progress back to its slot without leaving the run. */
    const saveRun = async (data: SaveData) => {
        if (!run) return;

        const slot = run.slot;
        await createSave(slot, data);
        setSaves((previous) => ({ ...previous, [slot]: data }));
        setRun({ slot, save: data });
    };

    /**
     * Writes the setup to the slot and applies it to the running settings.
     *
     * A newly created Survival save opens its run straight away, so its first
     * round can start without a detour through the slot list. Editing a save and
     * every other mode still return to the list.
     */
    const completeFlow = async (data: SaveData) => {
        if (!flow) return;

        const slot = flow.slot;
        const creating = flow.save === null;
        await createSave(slot, data);
        setSaves((previous) => ({ ...previous, [slot]: data }));
        setGameState((previous) => ({
            ...previous,
            settings: {
                ...previous.settings,
                saveName: data.name,
                gameMode: data.gameMode,
                difficulty: data.difficulty,
                allyControl: data.allyControl,
                fightingTooltipVisible: data.tooltips.fighting,
                actionsTooltipVisible: data.tooltips.actions,
                dialogueTooltipVisible: data.tooltips.dialogue,
                combatAnimations: data.combatAnimations,
                dialogueTextSpeed: data.dialogueTextSpeed,
                showNowPlayingMusic: data.showNowPlayingMusic,
            },
        }));
        setFlow(null);
        if (creating && data.gameMode === 'survival') {
            setRun({ slot, save: data });
        }
    };

    return (
        <motion.main
            className="relative h-dvh overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: PAGE_ENTER_TRANSITION }}
            exit={{ opacity: 0, transition: PAGE_FADE_TRANSITION }}
        >
            <AnimatePresence mode="wait" initial={false}>
                {run ? (
                    <SurvivalRunScreen
                        key={`survival-${run.slot}`}
                        save={run.save}
                        onSave={saveRun}
                        onExit={() => setRun(null)}
                    />
                ) : flow ? (
                    flow.save ? (
                        <EditSaveScreen
                            key="edit-save"
                            save={flow.save}
                            onSubmit={completeFlow}
                            onCancel={() => setFlow(null)}
                        />
                    ) : (
                        <NewGameFlow
                            key="new-game-flow"
                            initialDraft={createNewGameDraft(gameState.settings)}
                            onSubmit={completeFlow}
                            onCancel={() => setFlow(null)}
                        />
                    )
                ) : (
                    <motion.div
                        key="save-slots"
                        className="relative h-full overflow-y-auto overflow-x-hidden"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={PAGE_FADE_TRANSITION}
                    >
                        <div className="relative z-10 mx-auto flex min-h-full w-full max-w-7xl flex-col px-6 py-5 sm:px-10 sm:py-6">
                            <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center">
                                <div className="justify-self-start"><BackButton label={t('back')} onClick={onBack} /></div>
                                <div
                                    className="relative inline-flex items-center justify-center"
                                    onMouseEnter={() => setHovered(true)}
                                    onMouseLeave={() => setHovered(false)}
                                    onFocus={() => setFocused(true)}
                                    onBlur={() => setFocused(false)}
                                >
                                    <h1 className="relative z-10 pl-[0.18em] text-center text-3xl uppercase text-white sm:text-4xl">{t('newGame.title')}</h1>
                                    <div className="absolute left-full top-1/2 z-0 ml-1.5 -translate-y-1/2 text-3xl sm:text-4xl">
                                        <motion.button
                                            type="button"
                                            aria-label={t('newGame.openFolder')}
                                            title={t('newGame.openFolder')}
                                            onMouseEnter={() => playSfx('hover')}
                                            onClick={openFolder}
                                            initial={false}
                                            animate={revealed ? { opacity: 1, x: 0, scale: 1 } : { opacity: 0, x: -30, scale: 0.7 }}
                                            transition={revealed ? FOLDER_REVEAL_TRANSITION : FOLDER_HIDE_TRANSITION}
                                            className="flex items-center justify-center p-1 text-white/60 transition-colors duration-300 ease-out hover:text-white"
                                            style={{ pointerEvents: revealed ? 'auto' : 'none' }}
                                        >
                                            <FolderIcon />
                                        </motion.button>
                                    </div>
                                </div>
                                <span aria-hidden="true" />
                            </header>

                            <div className="flex flex-1 items-center justify-center py-8">
                                <div className="flex w-full max-w-5xl flex-col gap-2.5">
                                    {SAVE_SLOTS.map((slot) => {
                                        const save = saves[slot];
                                        const capabilities = save ? GAME_MODES[save.gameMode] : null;

                                        return (
                                            <motion.article
                                                key={slot}
                                                initial={{ opacity: 0, y: 10 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ delay: slot * 0.04, duration: 0.25 }}
                                                role={save?.gameMode === 'survival' ? 'button' : undefined}
                                                tabIndex={save?.gameMode === 'survival' ? 0 : undefined}
                                                aria-label={save?.gameMode === 'survival' ? t('newGame.openSave', { name: save.name }) : undefined}
                                                onClick={save?.gameMode === 'survival' ? () => openRun(slot, save) : undefined}
                                                onKeyDown={save?.gameMode === 'survival' ? (event) => {
                                                    if (event.target !== event.currentTarget) return;
                                                    if (event.key === 'Enter' || event.key === ' ') {
                                                        event.preventDefault();
                                                        openRun(slot, save);
                                                    }
                                                } : undefined}
                                                className={`flex w-full flex-col border-game border-white/15 bg-galatime-dark/60 py-2.5 px-4 transition-colors duration-300 hover:border-galatime-primary/70 sm:flex-row sm:items-center sm:gap-3 ${save?.gameMode === 'survival' ? 'cursor-pointer' : ''}`}
                                            >
                                                {save && capabilities ? (
                                                    <>
                                                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                                            <span className="text-xs tracking-wide text-galatime-warning/70">{t('newGame.slot', { slot })}</span>
                                                            <h2 className="text-lg font-semibold tracking-wide text-white sm:text-xl">{save.name}</h2>
                                                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-md text-white/50">
                                                                {([
                                                                    [t(GAME_MODES[save.gameMode].title), t('newGame.labels.mode')],
                                                                    [
                                                                        capabilities.hasCombat ? t(DIFFICULTIES[save.difficulty].title) : t('newGame.labels.notApplicable'),
                                                                        t('newGame.labels.difficulty'),
                                                                    ],
                                                                    [
                                                                        capabilities.configuresAllyControl ? t(ALLY_CONTROLS[save.allyControl].title) : t('newGame.labels.notApplicable'),
                                                                        t('newGame.labels.allies'),
                                                                    ],
                                                                ] as [string, string][]).map(([info, label], idx) => (
                                                                    <Fragment key={label}>
                                                                        {idx > 0 && <Diamond />}
                                                                        <span className="whitespace-nowrap">
                                                                            {label}: <span className="text-white/75">{info}</span>
                                                                        </span>
                                                                    </Fragment>
                                                                ))}
                                                            </div>
                                                        </div>
                                                        <div className="flex shrink-0 flex-row justify-end gap-2 border-t-game border-white/10 pt-2 sm:ml-5 sm:w-8 sm:flex-col sm:justify-center sm:border-l-game sm:border-t-0 sm:border-white/10 sm:pt-0 sm:pl-3">
                                                            <CommonButton
                                                                variant="ghost"
                                                                size="sm"
                                                                aria-label={t('newGame.edit')}
                                                                title={t('newGame.edit')}
                                                                onClick={(event) => event.stopPropagation()}
                                                                onPress={() => setFlow({ slot, save })}
                                                                className="h-7 w-7 border-game p-0 opacity-55 hover:opacity-100"
                                                                icon={<EditIcon className="h-3.5 w-3.5" />}
                                                            />
                                                            <CommonButton
                                                                variant="ghost"
                                                                size="sm"
                                                                aria-label={t('newGame.remove')}
                                                                title={t('newGame.remove')}
                                                                onClick={(event) => event.stopPropagation()}
                                                                onPress={() => setDeleteSlot(slot)}
                                                                className="h-7 w-7 border-game p-0"
                                                                icon={<TrashIcon className="h-3.5 w-3.5 text-galatime-error" />}
                                                            />
                                                        </div>
                                                    </>
                                                ) : (
                                                    <CommonButton
                                                        variant="ghost"
                                                        icon={<AddIcon className="h-7 w-7 text-galatime-primary" />}
                                                        className="group min-h-16 w-full flex-1 flex-row gap-3 border-0"
                                                        aria-label={t('newGame.create', { slot })}
                                                        onPress={() => setFlow({ slot, save: null })}
                                                    >
                                                        <span className="text-xs uppercase tracking-[0.22em]">{t('newGame.emptySlot', { slot })}</span>
                                                    </CommonButton>
                                                )}
                                            </motion.article>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            <CommonPopup
                open={deleteSlot !== null}
                variant="danger"
                title={t('newGame.removeTitle')}
                message={t('newGame.removeMessage')}
                onDismiss={() => setDeleteSlot(null)}
                cancelAction={{ label: t('cancel'), onPress: () => setDeleteSlot(null) }}
                confirmAction={{ label: t('confirm'), variant: 'danger', onPress: () => void removeSave() }}
            />
        </motion.main>
    );
}
