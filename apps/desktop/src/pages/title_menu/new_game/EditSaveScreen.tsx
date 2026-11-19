import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { BackButton } from '../../../components/common/BackButton';
import CommonButton from '../../../components/common/CommonButton';
import CommonInput from '../../../components/common/CommonInput';
import CommonSelector from '../../../components/common/CommonSelector';
import CommonSlider from '../../../components/common/CommonSlider';
import CommonSwitch from '../../../components/common/CommonSwitch';
import { PAGE_FADE_TRANSITION } from '../../../constants/AnimationConstants';
import { isAllyControl } from '../../../constants/AllyControlConstants';
import {
    DIALOGUE_TEXT_SPEED_MAX,
    DIALOGUE_TEXT_SPEED_MIN,
} from '../../../constants/DialogueConstants';
import { isDifficulty } from '../../../constants/DifficultyConstants';
import { GAME_MODES } from '../../../constants/GameModeConstants';
import type { SaveData } from '../../../services/saveService';
import {
    createDraftFromSave,
    fromSliderTextSpeed,
    getDialogueSpeedBand,
    toSaveData,
    toSliderTextSpeed,
    type NewGameDraft,
} from './newGameFlowModel';
import { ALLY_ITEMS, DIFFICULTY_ITEMS } from './newGameOptions';

interface EditSaveScreenProps {
    save: SaveData;
    onSubmit: (data: SaveData) => Promise<void>;
    onCancel: () => void;
}

/**
 * Editing a chronicle is deliberately a single page instead of the New Game
 * wizard: the mode is fixed once the save exists, so there is no sequence of
 * decisions left to walk through.
 */
export function EditSaveScreen({ save, onSubmit, onCancel }: EditSaveScreenProps) {
    const { t } = useTranslation(['newGame', 'game', 'settings', 'common']);
    const [draft, setDraft] = useState(() => createDraftFromSave(save));
    const [saving, setSaving] = useState(false);
    const nameInputRef = useRef<HTMLInputElement>(null);
    const capabilities = GAME_MODES[save.gameMode];

    const updateDraft = useCallback((patch: Partial<NewGameDraft>) => {
        setDraft((previous) => ({ ...previous, ...patch }));
    }, []);

    const canSave = !saving && draft.saveName.trim().length > 0;

    const cancel = useCallback(() => {
        if (!saving) onCancel();
    }, [onCancel, saving]);

    const commit = useCallback(() => {
        if (!canSave) return;

        setSaving(true);
        void onSubmit(toSaveData({ ...draft, gameMode: save.gameMode }, save)).then(
            () => setSaving(false),
            () => setSaving(false),
        );
    }, [canSave, draft, onSubmit, save]);

    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            nameInputRef.current?.focus();
            nameInputRef.current?.select();
        });
        return () => cancelAnimationFrame(frame);
    }, []);

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
                        <BackButton label={t('back')} onClick={cancel} />
                    </div>
                    <div className="text-center">
                        <h1 className="pl-[0.18em] text-3xl uppercase text-white sm:text-4xl">
                            {t('newGame.editTitle')}
                        </h1>
                    </div>
                    <span aria-hidden="true" />
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                    <div className="mx-auto w-full max-w-3xl py-8">
                        <div className="border-b-game border-white/10 pb-4">
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

                        <div className="setting-line border-b-game border-white/10 py-4">
                            <div>
                                <span className="text-lg text-white">{t('newGame.labels.mode')}</span>
                                <p className="text-xs">{t('newGame.editModeLocked')}</p>
                            </div>
                            <span className="shrink-0 text-white/75">{t(GAME_MODES[save.gameMode].title)}</span>
                        </div>

                        <div className="space-y-2">
                            {capabilities.hasCombat && (
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
                                    containerClassName="border-b-game border-white/10 py-4"
                                />
                            )}

                            {capabilities.hasAllies && (
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
                                    containerClassName="border-b-game border-white/10 py-4"
                                />
                            )}

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
                    </div>
                </div>

                <footer className="flex shrink-0 items-center justify-end gap-2 border-t-game border-white/10 pt-4">
                    <CommonButton variant="ghost" disabled={saving} onPress={cancel}>
                        {t('cancel')}
                    </CommonButton>
                    <CommonButton
                        variant="primary"
                        particles
                        disabled={!canSave}
                        onPress={commit}
                    >
                        {saving ? t('newGame.wizard.saving') : t('newGame.save')}
                    </CommonButton>
                </footer>
            </div>
        </motion.div>
    );
}
