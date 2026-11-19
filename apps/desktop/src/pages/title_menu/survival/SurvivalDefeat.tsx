import { useTranslation } from 'react-i18next';
import CommonButton from '@/components/common/CommonButton';
import CommonImage from '@/components/common/CommonImage';

export interface SurvivalDefeatSummary {
    round: number;
    bestRound: number;
    coins: number;
    retreated: boolean;
}

interface SurvivalDefeatProps {
    summary: SurvivalDefeatSummary;
    onExit: () => void;
}

/** The run-over screen: full-width result instead of a centred settings card. */
export function SurvivalDefeat({ summary, onExit }: SurvivalDefeatProps) {
    const { t } = useTranslation(['survival', 'common']);

    return (
        <div className="flex h-full flex-col overflow-y-auto bg-galatime-background text-white">
            <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center px-4 py-8 sm:px-8">
                <div className="border-b-game border-galatime-error/40 pb-5">
                    <p className="text-[0.65rem] uppercase tracking-[0.35em] text-galatime-error/80">
                        {t('survival.defeat.kicker')}
                    </p>
                    <h1 className="mt-2 text-4xl uppercase tracking-wide text-white sm:text-6xl">
                        {t('survival.defeat.title')}
                    </h1>
                    <p className="mt-3 max-w-2xl text-sm text-white/55">
                        {summary.retreated
                            ? t('survival.defeat.retreated', { round: summary.round })
                            : t('survival.defeat.reached', { round: summary.round })}
                    </p>
                </div>

                <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="border-game border-white/10 bg-galatime-dark p-4">
                        <p className="text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                            {t('survival.defeat.reachedLabel')}
                        </p>
                        <p className="mt-1 text-3xl text-white">{summary.round}</p>
                    </div>
                    <div className="border-game border-white/10 bg-galatime-dark p-4">
                        <p className="text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                            {t('survival.defeat.bestLabel')}
                        </p>
                        <p className="mt-1 text-3xl text-galatime-accent">{summary.bestRound}</p>
                    </div>
                    <div
                        className="flex items-center justify-between gap-4 border-game border-white/10 bg-galatime-dark p-4"
                        aria-label={t('survival.coinsAria', { coins: summary.coins })}
                    >
                        <CommonImage src="/images/ui/coin.png" alt="" className="size-8" />
                        <p className="text-3xl text-galatime-warning">{summary.coins}</p>
                    </div>
                </div>

                <div className="mt-8 flex justify-end">
                    <CommonButton variant="primary" particles onPress={onExit}>
                        {t('survival.returnToSaves')}
                    </CommonButton>
                </div>
            </div>
        </div>
    );
}
