import { useTranslation } from 'react-i18next';
import CommonSlider from '../../../components/common/CommonSlider';
import CommonSwitch from '../../../components/common/CommonSwitch';
import {
    DIALOGUE_TEXT_SPEED_MAX,
    DIALOGUE_TEXT_SPEED_MIN,
    flipDialogueTextSpeed,
} from '../../../constants/DialogueConstants';
import type { SettingsPanelProps } from './types';

export function SettingsGamePanel({ settings, updateSettings }: SettingsPanelProps) {
    const { t } = useTranslation('game');

    //region — Render
    return (
        <div className="space-y-2">
            {/* Fighting Tips Toggle */}
            <CommonSwitch
                key={`fightingTips-${settings.fightingTooltipVisible}`}
                title={t('game.settings.fightingTips.title')}
                description={t('game.settings.fightingTips.description')}
                defaultChecked={settings.fightingTooltipVisible}
                onChange={(checked) => updateSettings({ fightingTooltipVisible: checked })}
                showDescription
                containerClassName="setting-line border-b-game border-white/10 py-4"
            />

            {/* Action Tips Toggle */}
            <CommonSwitch
                key={`actionTips-${settings.actionsTooltipVisible}`}
                title={t('game.settings.actionTips.title')}
                description={t('game.settings.actionTips.description')}
                defaultChecked={settings.actionsTooltipVisible}
                onChange={(checked) => updateSettings({ actionsTooltipVisible: checked })}
                showDescription
                containerClassName="setting-line border-b-game border-white/10 py-4"
            />

            {/* Dialogue Tips Toggle */}
            <CommonSwitch
                key={`dialogueTips-${settings.dialogueTooltipVisible}`}
                title={t('game.settings.dialogueTips.title')}
                description={t('game.settings.dialogueTips.description')}
                defaultChecked={settings.dialogueTooltipVisible}
                onChange={(checked) => updateSettings({ dialogueTooltipVisible: checked })}
                showDescription
                containerClassName="setting-line border-b-game border-white/10 py-4"
            />

            {/* Combat Animations Toggle */}
            <CommonSwitch
                key={`combatAnimations-${settings.combatAnimations}`}
                title={t('game.settings.combatAnimations.title')}
                description={t('game.settings.combatAnimations.description')}
                defaultChecked={settings.combatAnimations}
                onChange={(checked) => updateSettings({ combatAnimations: checked })}
                showDescription
                containerClassName="setting-line border-b-game border-white/10 py-4"
            />

            {/* Text Speed Slider */}
            <div className="border-b-game border-white/10 py-4">
                <CommonSlider
                    title={t('game.settings.textSpeed.title')}
                    min={DIALOGUE_TEXT_SPEED_MIN}
                    max={DIALOGUE_TEXT_SPEED_MAX}
                    numBars={10}
                    value={flipDialogueTextSpeed(settings.dialogueTextSpeed)}
                    onChange={(value) => updateSettings({ dialogueTextSpeed: flipDialogueTextSpeed(value) })}
                    sliderContainerClassName="w-36 sm:w-48"
                />
            </div>
        </div>
    );
    //endregion — Render
}
