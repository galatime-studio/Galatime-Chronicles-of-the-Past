import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, type Variants } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { BackButton } from '../../../components/common/BackButton';
import CommonButton from '../../../components/common/CommonButton';
import CommonInput from '../../../components/common/CommonInput';
import CommonSelector from '../../../components/common/CommonSelector';
import CommonSlider from '../../../components/common/CommonSlider';
import CommonSwitch from '../../../components/common/CommonSwitch';
import { PAGE_FADE_TRANSITION } from '../../../constants/AnimationConstants';
import {
    DIALOGUE_TEXT_SPEED_MAX,
    DIALOGUE_TEXT_SPEED_MIN,
} from '../../../constants/DialogueConstants';
import { isAllyControl } from '../../../constants/AllyControlConstants';
import {
    isDifficulty,
} from '../../../constants/DifficultyConstants';
import {
    GAME_MODE_ORDER,
    GAME_MODES,
    isGameMode,
    type GameMode,
} from '../../../constants/GameModeConstants';
import { playSfx } from '../../../controllers/audioController';
import { usePrefersReducedMotion } from '../../../hooks/usePrefersReducedMotion';
import type { SaveData } from '../../../services/saveService';
import {
    canAdvanceNewGameStep,
    fromSliderTextSpeed,
    getDialogueSpeedBand,
    getNewGameSteps,
    toSaveData,
    toSliderTextSpeed,
    withGameMode,
    type NewGameDraft,
} from './newGameFlowModel';
import { ALLY_ITEMS, DIFFICULTY_ITEMS } from './newGameOptions';

/** Signature fast-start, silky-settle easing shared by the title-menu chrome. */
const STEP_EASE = [0.16, 1, 0.3, 1] as const;

interface NewGameFlowProps {
    initialDraft: NewGameDraft;
    onSubmit: (data: SaveData) => Promise<void>;
    onCancel: () => void;
}

const MODE_ITEMS = GAME_MODE_ORDER.map((mode) => ({
    id: mode,
    title: GAME_MODES[mode].title,
    description: GAME_MODES[mode].description,
}));

export function NewGameFlow({ initialDraft, onSubmit, onCancel }: NewGameFlowProps) {
    const { t } = useTranslation(['newGame', 'game', 'settings', 'common']);
    const reducedMotion = usePrefersReducedMotion();
    const [draft, setDraft] = useState(initialDraft);
    const [stepIndex, setStepIndex] = useState(0);
    const [saving, setSaving] = useState(false);
    const nameInputRef = useRef<HTMLInputElement>(null);
    const seedInputRef = useRef<HTMLInputElement>(null);

    const steps = useMemo(() => getNewGameSteps(draft.gameMode), [draft.gameMode]);
    const activeIndex = Math.min(stepIndex, steps.length - 1);
    const step = steps[activeIndex];
    const capabilities = GAME_MODES[draft.gameMode];
    const canContinue = !saving && canAdvanceNewGameStep(step, draft);
    const isLastStep = activeIndex === steps.length - 1;

    const updateDraft = useCallback((patch: Partial<NewGameDraft>) => {
        setDraft((previous) => ({ ...previous, ...patch }));
    }, []);

    const selectMode = (mode: GameMode) => {
        setDraft((previous) => withGameMode(previous, mode));
    };

    const goBack = useCallback(() => {
        if (saving) return;

        if (activeIndex === 0) {
            onCancel();
            return;
        }

        setStepIndex(activeIndex - 1);
    }, [activeIndex, onCancel, saving]);

    const goNext = useCallback(() => {
        if (!canContinue) return;

        if (isLastStep) {
            setSaving(true);
            void onSubmit(toSaveData(draft)).then(
                () => setSaving(false),
                () => setSaving(false),
            );
            return;
        }

        playSfx('click');
        setStepIndex(activeIndex + 1);
    }, [activeIndex, canContinue, draft, isLastStep, onSubmit]);

    // Put the caret in the typed questions, so answering needs no mouse.
    useEffect(() => {
        if (step !== 'name' && step !== 'seed') return;

        const frame = requestAnimationFrame(() => {
            const input = step === 'seed' ? seedInputRef.current : nameInputRef.current;
            input?.focus();
            input?.select();
        });
        return () => cancelAnimationFrame(frame);
    }, [step]);

    const stepVariants = useMemo<Variants>(() => ({
        enter: {
            opacity: 0,
            scale: reducedMotion ? 1 : 0.98,
            filter: reducedMotion ? 'blur(0px)' : 'blur(4px)',
        },
        center: {
            opacity: 1,
            scale: 1,
            filter: 'blur(0px)',
            transition: { duration: reducedMotion ? 0.01 : 0.3, ease: STEP_EASE },
        },
        exit: {
            opacity: 0,
            scale: reducedMotion ? 1 : 0.96,
            filter: reducedMotion ? 'blur(0px)' : 'blur(6px)',
            transition: { duration: reducedMotion ? 0.01 : 0.18, ease: 'easeIn' },
        },
    }), [reducedMotion]);

    //region — Step content
    const renderModeStep = () => (
        <CommonSelector
            items={MODE_ITEMS}
            defaultId={draft.gameMode}
            title={t('newGame.labels.mode')}
            onChange={(item) => {
                if (isGameMode(item.id)) selectMode(item.id);
            }}
            orientation="vertical"
            showDescription
            ns="newGame"
            containerClassName="py-2"
        />
    );

    const renderDifficultyStep = () => (
        <CommonSelector
            items={DIFFICULTY_ITEMS}
            defaultId={draft.difficulty}
            title={t('newGame.labels.difficulty')}
            onChange={(item) => {
                if (isDifficulty(item.id)) updateDraft({ difficulty: item.id });
            }}
            orientation="vertical"
            showDescription
            ns="game"
            containerClassName="py-2"
        />
    );

    const renderSeedStep = () => (
        <div className="mx-auto flex max-w-md flex-col items-center">
            <CommonInput
                title={t('newGame.wizard.seed.label')}
                description={t('newGame.wizard.seed.description')}
                value={draft.seedInput}
                onChange={(seedInput) => updateDraft({ seedInput })}
                placeholder={t('newGame.wizard.seed.placeholder')}
                maxCharacters={64}
                spellCheck={false}
                showDescription
                inputRef={seedInputRef}
                containerClassName="w-full"
                inputClassName="text-2xl"
            />
        </div>
    );

    const renderTooltipStep = () => (
        <div className="space-y-2">
            {capabilities.hasCombat && (
                <CommonSwitch
                    key={`fighting-tooltip-${draft.fightingTooltipVisible}`}
                    title={t('game.settings.fightingTips.title')}
                    description={t('game.settings.fightingTips.description')}
                    defaultChecked={draft.fightingTooltipVisible}
                    onChange={(fightingTooltipVisible) => updateDraft({ fightingTooltipVisible })}
                    showDescription
                    containerClassName="setting-line border-b-game border-white/10 py-4"
                />
            )}
            {capabilities.hasExploration && (
                <CommonSwitch
                    key={`action-tooltip-${draft.actionsTooltipVisible}`}
                    title={t('game.settings.actionTips.title')}
                    description={t('game.settings.actionTips.description')}
                    defaultChecked={draft.actionsTooltipVisible}
                    onChange={(actionsTooltipVisible) => updateDraft({ actionsTooltipVisible })}
                    showDescription
                    containerClassName="setting-line border-b-game border-white/10 py-4"
                />
            )}
            {capabilities.hasDialogue && (
                <CommonSwitch
                    key={`dialogue-tooltip-${draft.dialogueTooltipVisible}`}
                    title={t('game.settings.dialogueTips.title')}
                    description={t('game.settings.dialogueTips.description')}
                    defaultChecked={draft.dialogueTooltipVisible}
                    onChange={(dialogueTooltipVisible) => updateDraft({ dialogueTooltipVisible })}
                    showDescription
                    containerClassName="setting-line border-b-game border-white/10 py-4"
                />
            )}
        </div>
    );

    const renderAllyStep = () => (
        <CommonSelector
            items={ALLY_ITEMS}
            defaultId={draft.allyControl}
            title={t('newGame.labels.allies')}
            onChange={(item) => {
                if (isAllyControl(item.id)) updateDraft({ allyControl: item.id });
            }}
            orientation="vertical"
            showDescription
            ns="game"
            containerClassName="py-2"
        />
    );

    const renderPresentationStep = () => (
        <div className="space-y-2">
            {capabilities.hasCombat && (
                <CommonSwitch
                    key={`combat-animations-${draft.combatAnimations}`}
                    title={t('game.settings.combatAnimations.title')}
                    description={t('game.settings.combatAnimations.description')}
                    defaultChecked={draft.combatAnimations}
                    onChange={(combatAnimations) => updateDraft({ combatAnimations })}
                    showDescription
                    containerClassName="setting-line border-b-game border-white/10 py-4"
                />
            )}
            {capabilities.hasDialogue && (
                <div className="border-b-game border-white/10 py-4">
                    <CommonSlider
                        title={t('game.settings.textSpeed.title')}
                        min={DIALOGUE_TEXT_SPEED_MIN}
                        max={DIALOGUE_TEXT_SPEED_MAX}
                        numBars={10}
                        value={toSliderTextSpeed(draft.dialogueTextSpeed)}
                        onChange={(sliderValue) => updateDraft({ dialogueTextSpeed: fromSliderTextSpeed(sliderValue) })}
                        formatValue={(sliderValue) => t(`newGame.wizard.presentation.speed.${getDialogueSpeedBand(fromSliderTextSpeed(sliderValue))}`)}
                        sliderContainerClassName="w-36 sm:w-48"
                    />
                </div>
            )}
            <CommonSwitch
                key={`now-playing-${draft.showNowPlayingMusic}`}
                title={t('settings.sound.nowPlaying.title')}
                description={t('settings.sound.nowPlaying.description')}
                defaultChecked={draft.showNowPlayingMusic}
                onChange={(showNowPlayingMusic) => updateDraft({ showNowPlayingMusic })}
                showDescription
                containerClassName="setting-line border-b-game border-white/10 py-4"
            />
        </div>
    );

    const renderNameStep = () => (
        <div className="mx-auto flex max-w-md flex-col items-center">
            <CommonInput
                title={t('newGame.wizard.name.label')}
                value={draft.saveName}
                onChange={(saveName) => updateDraft({ saveName })}
                placeholder={t('newGame.wizard.name.placeholder')}
                maxCharacters={32}
                spellCheck={false}
                inputRef={nameInputRef}
                containerClassName="w-full"
                inputClassName="text-2xl"
            />
        </div>
    );

    //endregion — Step content

    //region — Render
    return (
        <motion.div
            className="relative h-full overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={PAGE_FADE_TRANSITION}
        >
            <div className="relative z-10 mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden px-6 py-5 sm:px-10 sm:py-6">
                <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center">
                    <div className="justify-self-start">
                        <BackButton label={t('back')} onClick={onCancel} />
                    </div>
                    <div className="text-center">
                        <h1 className="pl-[0.18em] text-3xl uppercase text-white sm:text-4xl">
                            {t('newGame.title')}
                        </h1>
                    </div>
                    <span aria-hidden="true" />
                </header>

                <div
                    className="mt-4 h-0.5 w-full shrink-0 overflow-hidden bg-white/10"
                    role="progressbar"
                    aria-valuemin={1}
                    aria-valuemax={steps.length}
                    aria-valuenow={activeIndex + 1}
                >
                    <motion.div
                        className="h-full bg-galatime-primary"
                        animate={{ width: `${((activeIndex + 1) / steps.length) * 100}%` }}
                        transition={reducedMotion ? { duration: 0 } : { duration: 0.35, ease: STEP_EASE }}
                    />
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                    <div className="flex min-h-full items-center justify-center py-8">
                        <AnimatePresence mode="wait" initial={false}>
                            <motion.section
                                key={step}
                                variants={stepVariants}
                                initial="enter"
                                animate="center"
                                exit="exit"
                                className="w-full"
                            >
                                <div className="mx-auto w-full max-w-3xl">
                                    {step === 'mode' && renderModeStep()}
                                    {step === 'difficulty' && renderDifficultyStep()}
                                    {step === 'seed' && renderSeedStep()}
                                    {step === 'tooltips' && renderTooltipStep()}
                                    {step === 'allies' && renderAllyStep()}
                                    {step === 'presentation' && renderPresentationStep()}
                                    {step === 'name' && renderNameStep()}
                                </div>
                            </motion.section>
                        </AnimatePresence>
                    </div>
                </div>

                <footer className="flex shrink-0 items-center justify-end gap-2 border-t-game border-white/10 pt-4">
                    <CommonButton
                        variant="ghost"
                        disabled={activeIndex === 0 || saving}
                        onPress={goBack}
                    >
                        {t('newGame.wizard.previous')}
                    </CommonButton>
                    <CommonButton
                        variant="primary"
                        particles
                        disabled={!canContinue}
                        onPress={goNext}
                    >
                        {saving
                            ? t('newGame.wizard.saving')
                            : isLastStep
                                ? t('newGame.wizard.start')
                                : t('newGame.wizard.continue')}
                    </CommonButton>
                </footer>
            </div>
        </motion.div>
    );
    //endregion — Render
}
