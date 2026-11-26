import { motion, type Variants } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import CommonButton from '@/components/common/CommonButton';
import CommonImage from '@/components/common/CommonImage';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

export interface SurvivalVictorySummary {
    round: number;
    /** Enemies left defeated when the wave ended. */
    defeated: number;
    /** Coins paid by the round-completion reward. */
    roundReward: number;
    /** Coins found in the fight's loot log. */
    loot: number;
    /** The purse after both gains. */
    coins: number;
    /** Experience earned from the enemies defeated in the wave. */
    xpGained: number;
    /** Experience banked toward the next skill point. */
    xp: number;
    /** Experience the next skill point needs. */
    xpToNext: number;
    /** Skill points owned after the wave. */
    skillPoints: number;
    /** Skill points earned by filling the experience bar. */
    skillPointsGained: number;
    nextRound: number;
}

interface SurvivalVictoryProps {
    summary: SurvivalVictorySummary;
    onContinue: () => void;
}

/** Coins flung out of the emblem once, purely decorative. */
const BURST_COINS = [
    { x: -96, y: -58, rotate: -35, delay: 0.1 },
    { x: 92, y: -66, rotate: 42, delay: 0.16 },
    { x: -72, y: 44, rotate: 28, delay: 0.22 },
    { x: 78, y: 38, rotate: -30, delay: 0.28 },
    { x: 0, y: -92, rotate: 12, delay: 0.34 },
];

/**
 * The wave-cleared screen: full-width spoils instead of a centred settings card.
 *
 * Everything is presentation; the run screen has already resolved the rewards
 * and persisted the next run before this mounts.
 */
export function SurvivalVictory({ summary, onContinue }: SurvivalVictoryProps) {
    const { t } = useTranslation(['survival', 'common']);
    const reduceMotion = usePrefersReducedMotion();

    const container: Variants = {
        hidden: {},
        visible: {
            transition: {
                delayChildren: reduceMotion ? 0 : 0.12,
                staggerChildren: reduceMotion ? 0 : 0.09,
            },
        },
    };
    const item: Variants = {
        hidden: reduceMotion ? { opacity: 1 } : { opacity: 0, y: 18 },
        visible: {
            opacity: 1,
            y: 0,
            transition: { duration: reduceMotion ? 0 : 0.38, ease: 'easeOut' },
        },
    };

    return (
        <div className="flex h-full flex-col overflow-y-auto bg-galatime-background text-white">
            <motion.div
                className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center px-4 py-8 sm:px-8"
                variants={container}
                initial="hidden"
                animate="visible"
            >
                <motion.div variants={item} className="flex flex-col items-center text-center">
                    <div className="relative flex h-28 w-28 items-center justify-center">
                        <motion.span
                            className="absolute inset-0 rounded-full border-game border-galatime-success/40"
                            initial={reduceMotion ? false : { opacity: 0, scale: 0.55 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.5, ease: 'easeOut' }}
                        />
                        <motion.span
                            className="absolute inset-3 rounded-full border-game border-galatime-accent/25"
                            initial={reduceMotion ? false : { opacity: 0, scale: 0.7 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.55, delay: 0.08, ease: 'easeOut' }}
                        />
                        <motion.div
                            initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.45, delay: 0.05, ease: 'easeOut' }}
                        >
                            <CommonImage src="/images/ui/coin.png" alt="" className="size-16" />
                        </motion.div>
                        {!reduceMotion && BURST_COINS.map((coin) => (
                            <motion.span
                                key={`${coin.x}-${coin.y}`}
                                className="pointer-events-none absolute"
                                initial={{ opacity: 0, x: 0, y: 0, scale: 0.4, rotate: 0 }}
                                animate={{
                                    opacity: [0, 1, 0],
                                    x: coin.x,
                                    y: coin.y,
                                    scale: [0.4, 1, 0.85],
                                    rotate: coin.rotate,
                                }}
                                transition={{ duration: 0.95, delay: coin.delay, ease: 'easeOut' }}
                                aria-hidden="true"
                            >
                                <CommonImage src="/images/ui/coin.png" alt="" className="size-6" />
                            </motion.span>
                        ))}
                    </div>

                    <p className="mt-5 text-[0.65rem] uppercase tracking-[0.35em] text-galatime-success/85">
                        {t('survival.victory.kicker', { round: summary.round })}
                    </p>
                    <h1 className="mt-2 text-4xl uppercase tracking-wide text-white sm:text-6xl">
                        {t('survival.victory.title')}
                    </h1>
                    <p className="mt-3 max-w-2xl text-sm text-white/55">
                        {t('survival.victory.subtitle')}
                    </p>
                </motion.div>

                <motion.div
                    variants={item}
                    className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
                >
                    <div className="border-game border-white/10 bg-galatime-dark p-4">
                        <p className="text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                            {t('survival.victory.defeated')}
                        </p>
                        <p className="mt-1 text-3xl text-white">{summary.defeated}</p>
                    </div>
                    <div className="border-game border-white/10 bg-galatime-dark p-4">
                        <p className="text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                            {t('survival.victory.roundReward')}
                        </p>
                        <p className="mt-1 flex items-center gap-2 text-3xl text-galatime-success">
                            <CommonImage src="/images/ui/coin.png" alt="" className="size-6" />
                            +{summary.roundReward}
                        </p>
                    </div>
                    <div className="border-game border-white/10 bg-galatime-dark p-4">
                        <p className="text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                            {t('survival.victory.loot')}
                        </p>
                        <p className="mt-1 flex items-center gap-2 text-3xl text-galatime-accent">
                            <CommonImage src="/images/ui/coin.png" alt="" className="size-6" />
                            +{summary.loot}
                        </p>
                    </div>
                    <div className="border-game border-white/10 bg-galatime-dark p-4">
                        <p className="text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                            {t('survival.victory.experience')}
                        </p>
                        <p className="mt-1 text-3xl text-galatime-primary">+{summary.xpGained}</p>
                        <p className="mt-1 text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                            {t('survival.victory.experienceProgress', {
                                xp: summary.xp,
                                next: summary.xpToNext,
                            })}
                        </p>
                    </div>
                    <div className="border-game border-galatime-accent/30 bg-galatime-dark p-4">
                        <p className="text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                            {t('survival.victory.skillPoints')}
                        </p>
                        <p className="mt-1 text-3xl text-galatime-accent">
                            +{summary.skillPointsGained}
                        </p>
                        <p className="mt-1 text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                            {t('survival.victory.skillPointsOwned', { total: summary.skillPoints })}
                        </p>
                    </div>
                    <div
                        className="flex items-center justify-between gap-4 border-game border-galatime-warning/30 bg-galatime-dark p-4"
                        aria-label={t('survival.coinsAria', { coins: summary.coins })}
                    >
                        <div>
                            <p className="text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                                {t('survival.victory.purse')}
                            </p>
                            <p className="mt-1 text-3xl text-galatime-warning">{summary.coins}</p>
                        </div>
                        <CommonImage src="/images/ui/coin.png" alt="" className="size-8" />
                    </div>
                </motion.div>

                <motion.div variants={item} className="mt-8 flex justify-end">
                    <CommonButton variant="primary" particles onPress={onContinue}>
                        {t('survival.victory.continue', { round: summary.nextRound })}
                    </CommonButton>
                </motion.div>
            </motion.div>
        </div>
    );
}
