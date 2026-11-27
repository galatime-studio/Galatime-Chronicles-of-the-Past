import { useTranslation } from 'react-i18next';
import CommonButton from '@/components/common/CommonButton';
import {
    PLAYER_STAT_COST,
    PLAYER_STAT_ORDER,
} from '@/constants/ProgressionConstants';
import { canImproveStat, statGain } from '@/services/progressionService';
import type { BaseStats } from '@/types/EntityDataType';
import type { PlayerProgression, PlayerStatKey } from '@/types/ProgressionType';

interface SurvivalCharacterProps {
    progression: PlayerProgression;
    baseStats: BaseStats | null;
    currentHp: number;
    maxHp: number;
    onImproveStat: (stat: PlayerStatKey) => void;
}

/** Where each bought bonus lands on Arthur's authored stat block. */
const BASE_STAT_KEY: Record<PlayerStatKey, keyof BaseStats> = {
    maxHp: 'hp',
    maxMana: 'mana',
    maxStamina: 'stamina',
    physicalAttack: 'physical_attack',
    magicalAttack: 'magical_attack',
    physicalDefense: 'physical_defense',
    magicalDefense: 'magical_defense',
    speed: 'speed',
};

/**
 * The character page opened from the marketplace.
 *
 * It shows the experience bar, the skill points still unspent and Arthur's
 * eight combat stats. Every improvement is one skill point; the health pool is
 * printed as current over maximum because the run carries its own wound.
 */
export function SurvivalCharacter({
    progression,
    baseStats,
    currentHp,
    maxHp,
    onImproveStat,
}: SurvivalCharacterProps) {
    const { t } = useTranslation(['survival']);
    const canImprove = canImproveStat(progression);
    const xpProgress = progression.xpToNext > 0
        ? Math.max(0, Math.min(100, (progression.xp / progression.xpToNext) * 100))
        : 0;

    const statValue = (stat: PlayerStatKey): string => {
        if (stat === 'maxHp') return `${currentHp} / ${maxHp}`;
        if (!baseStats) return '—';
        const value = baseStats[BASE_STAT_KEY[stat]] + (progression.statBonuses[stat] ?? 0);
        return value.toLocaleString();
    };

    return (
        <div className="flex flex-col border-game border-white/10 bg-galatime-dark/50 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b-game border-white/10 px-3 py-2">
                <h2 className="text-[0.65rem] uppercase tracking-[0.3em] text-white/45">
                    {t('survival.characterPage.title')}
                </h2>
                <p className="text-xs text-galatime-accent">
                    {t('survival.characterPage.skillPointsOwned', { total: progression.skillPoints })}
                </p>
            </div>

            <div className="p-3 sm:p-4">
                <div className="border-game border-white/10 bg-galatime-darkHover/40 p-3">
                    <div className="flex items-baseline justify-between gap-3">
                        <p className="text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                            {t('survival.characterPage.experience')}
                        </p>
                        <p className="text-sm leading-none text-white/70">
                            {t('survival.characterPage.experienceProgress', {
                                xp: progression.xp,
                                next: progression.xpToNext,
                            })}
                        </p>
                    </div>
                    <div
                        className="relative mt-2 h-2.5 border-game border-white/15 bg-galatime-background p-0.5"
                        role="progressbar"
                        aria-label={t('survival.characterPage.experience')}
                        aria-valuemin={0}
                        aria-valuemax={progression.xpToNext}
                        aria-valuenow={progression.xp}
                    >
                        <div
                            className="relative h-full bg-galatime-primary transition-[width] duration-300"
                            style={{ width: `${xpProgress}%` }}
                        >
                            <span className="absolute left-full top-1/2 h-2.5 w-1 -translate-y-1/2 bg-white/90" />
                        </div>
                    </div>
                </div>

                <p className="mt-3 text-[0.65rem] uppercase tracking-[0.12em] text-white/35">
                    {canImprove
                        ? t('survival.characterPage.hint', { cost: PLAYER_STAT_COST })
                        : t('survival.characterPage.noPoints')}
                </p>

                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {PLAYER_STAT_ORDER.map((stat) => {
                        const label = t(`survival.characterPage.stats.${stat}`);
                        return (
                            <li
                                key={stat}
                                className="flex flex-col gap-2 border-game border-white/10 bg-galatime-darkHover/40 p-2.5"
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="truncate text-[0.6rem] uppercase tracking-[0.16em] text-white/40">
                                            {label}
                                        </p>
                                        <p className="mt-1 text-lg leading-none text-white">
                                            {statValue(stat)}
                                        </p>
                                    </div>
                                    <span className="shrink-0 text-[0.65rem] uppercase tracking-[0.12em] text-galatime-success">
                                        +{statGain(stat)}
                                    </span>
                                </div>

                                <CommonButton
                                    variant="outline"
                                    size="sm"
                                    className="w-full justify-center"
                                    disabled={!canImprove}
                                    title={canImprove
                                        ? t('survival.characterPage.improveAria', {
                                            stat: label,
                                            cost: PLAYER_STAT_COST,
                                        })
                                        : t('survival.characterPage.noPoints')}
                                    onPress={() => onImproveStat(stat)}
                                >
                                    {t('survival.characterPage.improve', { cost: PLAYER_STAT_COST })}
                                </CommonButton>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </div>
    );
}
