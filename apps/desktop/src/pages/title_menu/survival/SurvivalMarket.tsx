import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import CommonButton from '@/components/common/CommonButton';
import CommonImage from '@/components/common/CommonImage';
import { ControlIcon, InventoryIcon, SelectorIcon, UnknownIcon } from '@/assets/GalatimeIcon';
import { SURVIVAL_HEAL_COST, SURVIVAL_HEAL_FRACTION } from '@/constants/SurvivalConstants';
import { getEntityImages } from '@/services/entityImageService';
import { getItemDefinition } from '@/services/inventory/itemService';
import type { BaseStats } from '@/types/EntityDataType';
import type { ItemDefinition, ItemRarity } from '@/types/InventoryType';
import type { PlayerProgression, PlayerStatKey } from '@/types/ProgressionType';
import type { SurvivalRun } from '@/types/SurvivalType';
import { playSfx } from '@/controllers/audioController';
import { canBuySurvivalItem } from './survivalModel';
import { SurvivalCharacter } from './SurvivalCharacter';

interface SurvivalMarketProps {
    run: SurvivalRun;
    currentHp: number;
    maxHp: number;
    ready: boolean;
    canHeal: boolean;
    clearedRound: number | null;
    /** The six supplies drawn for this round. */
    stock: readonly ItemDefinition[];
    /** Experience and unspent skill points, shared with the character page. */
    progression: PlayerProgression;
    /** Arthur's authored stats, before bought increases. */
    baseStats: BaseStats | null;
    onHeal: () => void;
    onBuy: (itemId: string) => void;
    onImproveStat: (stat: PlayerStatKey) => void;
    onStart: () => void;
    onSettings: () => void;
}

type MarketTabId = 'shop' | 'inventory' | 'character' | 'skillTree' | 'fountain';

interface MarketTab {
    id: MarketTabId;
    labelKey: string;
    icon?: ReactNode;
    disabled: boolean;
}

interface OwnedItem {
    item: ItemDefinition;
    quantity: number;
}

const TAB_ICON_CLASS = 'h-4 w-4';

const RESOURCE_LABEL: Record<string, string> = {
    hp: 'HP',
    mana: 'MP',
    stamina: 'SP',
};

/** Rarity is a colour cue everywhere it is printed. */
const RARITY_CLASS: Record<ItemRarity, string> = {
    common: 'text-white/50',
    uncommon: 'text-galatime-success',
    rare: 'text-galatime-primaryHover',
    epic: 'text-galatime-accent',
    legendary: 'text-galatime-warning',
};

/** A compact shelf label such as `HP +30 · MP +20`. */
function itemEffectSummary(item: ItemDefinition): string {
    return item.effects.flatMap((effect) => {
        if (effect.type === 'restore') {
            return [`${RESOURCE_LABEL[effect.resource]} +${effect.amount}`];
        }
        if (effect.type === 'restore_percent') {
            return [`${RESOURCE_LABEL[effect.resource]} +${effect.amountPercent}%`];
        }
        return [];
    }).join(' · ');
}

/**
 * A health meter with no visible numbers. The value stays in the ARIA payload
 * for assistive technology, but the player only reads the bar and its fill.
 */
function HealthMeter({ value, max, compact = false }: { value: number; max: number; compact?: boolean }) {
    const { t } = useTranslation(['survival']);
    const percentage = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;

    return (
        <div className={compact ? 'w-28 sm:w-52' : 'w-full max-w-md'}>
            <p className="mb-1 text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                {t('survival.hp')}
            </p>
            <div
                className="relative h-2.5 border-game border-white/15 bg-galatime-background p-0.5"
                role="progressbar"
                aria-label={t('survival.hp')}
                aria-valuemin={0}
                aria-valuemax={max}
                aria-valuenow={value}
            >
                <div
                    className="relative h-full bg-galatime-stats-health transition-[width] duration-300"
                    style={{ width: `${percentage}%` }}
                >
                    <span className="absolute left-full top-1/2 h-2.5 w-1 -translate-y-1/2 bg-white/90" />
                </div>
            </div>
        </div>
    );
}

/** Item art does not exist yet; every shelf shows the shared unknown placeholder. */
function ShelfItemArt() {
    return (
        <div className="relative flex h-28 items-center justify-center" aria-hidden="true">
            <div className="absolute inset-x-4 bottom-2 h-1.5 border-t-game border-white/15 bg-galatime-darkHover" />
            <UnknownIcon className="relative z-10 mb-3 h-12 w-12 text-white/20" />
        </div>
    );
}

/**
 * The Survival Mode marketplace, drawn as a game shop instead of a settings card.
 *
 * Everything here is presentation: the shelves, the item selection, the bag and
 * the tab rail. The screen above owns the run, persistence and combat. The Shop,
 * the Inventory, the Character page and the Fountain of Life share the main
 * panel; the Skill Tree stays visible but disabled until that system exists.
 */
export function SurvivalMarket({
    run,
    currentHp,
    maxHp,
    ready,
    canHeal,
    clearedRound,
    stock,
    progression,
    baseStats,
    onHeal,
    onBuy,
    onImproveStat,
    onStart,
    onSettings,
}: SurvivalMarketProps) {
    const { t } = useTranslation(['survival', 'common', 'settings']);
    const [activeTab, setActiveTab] = useState<MarketTabId>('shop');
    const [selectedId, setSelectedId] = useState('');

    const portrait = useMemo(
        () => getEntityImages({ type: 'character', id: 'arthur', name: 'Arthur' })[0]?.url,
        [],
    );

    const owned = useMemo<OwnedItem[]>(() => (
        Object.entries(run.inventory)
            .flatMap(([itemId, quantity]) => {
                const item = getItemDefinition(itemId);
                return item && quantity > 0 ? [{ item, quantity }] : [];
            })
            .sort((a, b) => a.item.name.localeCompare(b.item.name))
    ), [run.inventory]);

    // A stale selection (the shelf rolled over) falls back to the first slot.
    const selected = stock.find((item) => item.id === selectedId) ?? stock[0] ?? null;
    const selectedOwned = selected ? run.inventory[selected.id] ?? 0 : 0;
    const selectedCanBuy = selected !== null && ready && canBuySurvivalItem(run, selected);
    const buyHint = !selected
        ? undefined
        : run.coins < selected.price
            ? t('survival.shop.needCoins')
            : selected.max_stack !== null && selectedOwned >= selected.max_stack
                ? t('survival.shop.stackFull')
                : undefined;

    const healthFull = currentHp >= maxHp;
    const healHint = healthFull
        ? t('survival.fountain.full')
        : run.coins < SURVIVAL_HEAL_COST
            ? t('survival.fountain.needCoins')
            : t('survival.fountain.description', { percent: Math.round(SURVIVAL_HEAL_FRACTION * 100) });

    const tabs: MarketTab[] = [
        {
            id: 'shop',
            labelKey: 'survival.tabs.shop',
            disabled: false,
        },
        {
            id: 'inventory',
            labelKey: 'survival.tabs.inventory',
            icon: <InventoryIcon className={TAB_ICON_CLASS} />,
            disabled: false,
        },
        {
            id: 'character',
            labelKey: 'survival.tabs.character',
            icon: <ControlIcon className={TAB_ICON_CLASS} />,
            disabled: false,
        },
        {
            id: 'skillTree',
            labelKey: 'survival.tabs.skillTree',
            icon: <SelectorIcon className={TAB_ICON_CLASS} />,
            disabled: true,
        },
        {
            id: 'fountain',
            labelKey: 'survival.tabs.fountain',
            disabled: false,
        },
    ];

    return (
        <div className="flex h-full flex-col overflow-hidden bg-galatime-background text-white">
            <header className="flex shrink-0 items-center justify-between gap-3 border-b-game border-white/10 bg-galatime-dark px-3 py-2 sm:px-5">
                <div className="flex min-w-0 items-center gap-3">
                    <div className="size-10 shrink-0 border-game border-white/15 bg-galatime-darkHover p-0.5 sm:size-11">
                        {portrait && (
                            <CommonImage
                                src={portrait}
                                alt={t('survival.character')}
                                className="h-full w-full"
                            />
                        )}
                    </div>
                    <p className="truncate text-xs uppercase tracking-[0.22em] text-white/55">
                        {t('survival.character')}
                    </p>
                </div>

                <HealthMeter value={currentHp} max={maxHp} compact />
            </header>

            <div className="grid min-h-0 flex-1 gap-3 overflow-x-hidden overflow-y-auto p-3 sm:p-4 lg:grid-cols-[17rem_minmax(0,1fr)] lg:overflow-hidden">
                <aside className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:overflow-x-hidden lg:overflow-y-auto">
                    <nav className="grid min-w-0 grid-cols-2 gap-1.5 lg:flex lg:flex-col" aria-label={t('survival.tabs.label')}>
                        {tabs.map((tab) => {
                            const active = tab.id === activeTab;
                            return (
                                <CommonButton
                                    key={tab.id}
                                    variant="ghost"
                                    size="sm"
                                    disabled={tab.disabled}
                                    aria-current={active ? 'page' : undefined}
                                    title={tab.disabled ? t('survival.comingSoon') : undefined}
                                    onPress={() => setActiveTab(tab.id)}
                                    className={`min-w-0 justify-start border-0 px-2.5 py-1.5 text-left text-[0.65rem] tracking-[0.08em] sm:px-3 sm:text-sm sm:tracking-[0.15em] ${active
                                        ? 'bg-white text-galatime-dark hover:bg-white hover:text-galatime-dark'
                                        : 'opacity-60 hover:opacity-100'}`}
                                >
                                    <span className="flex w-full items-center justify-between gap-2">
                                        <span className="flex min-w-0 items-center gap-2">
                                            {tab.icon}
                                            <span className="truncate">{t(tab.labelKey)}</span>
                                        </span>
                                        {tab.disabled && (
                                            <span className="hidden shrink-0 text-[0.55rem] uppercase tracking-[0.1em] text-galatime-warning/80 sm:inline">
                                                {t('survival.comingSoon')}
                                            </span>
                                        )}
                                    </span>
                                </CommonButton>
                            );
                        })}
                    </nav>

                    <div className="mt-auto border-game border-galatime-primary/40 bg-galatime-dark p-3">
                        <div className="flex items-end justify-between gap-3">
                            <div>
                                <p className="text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                                    {t('survival.bestRound')}
                                </p>
                                <p className="text-lg leading-none text-white">{run.bestRound}</p>
                            </div>
                            <div className="text-right">
                                <p className="text-[0.6rem] uppercase tracking-[0.2em] text-white/40">
                                    {t('survival.nextRound')}
                                </p>
                                <p className="text-lg leading-none text-galatime-warning">{run.round}</p>
                            </div>
                        </div>

                        <div
                            className="mt-3 flex items-center justify-between border-game border-galatime-warning/45 bg-galatime-background px-2.5 py-1.5 text-galatime-warning"
                            aria-label={t('survival.coinsAria', { coins: run.coins })}
                        >
                            <CommonImage src="/images/ui/coin.png" alt="" className="size-4" />
                            <span className="text-lg leading-none">{run.coins}</span>
                        </div>

                        <CommonButton
                            variant="primary"
                            particles
                            className="mt-3 w-full justify-center"
                            disabled={!ready}
                            onPress={onStart}
                        >
                            {t('survival.start', { round: run.round })}
                        </CommonButton>

                        <CommonButton
                            variant="ghost"
                            size="sm"
                            className="mt-2 w-full justify-center"
                            onPress={onSettings}
                        >
                            {t('settings.title')}
                        </CommonButton>
                    </div>
                </aside>

                <section className="flex flex-col gap-3 lg:min-h-0">
                    {activeTab === 'character' ? (
                        <SurvivalCharacter
                            progression={progression}
                            baseStats={baseStats}
                            currentHp={currentHp}
                            maxHp={maxHp}
                            onImproveStat={onImproveStat}
                        />
                    ) : activeTab === 'fountain' ? (
                        <div className="flex flex-col border-game border-white/10 bg-galatime-dark/50 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                            <div className="flex shrink-0 items-center justify-between border-b-game border-white/10 px-3 py-2">
                                <h2 className="text-[0.65rem] uppercase tracking-[0.3em] text-white/45">
                                    {t('survival.fountain.title')}
                                </h2>
                            </div>

                            <div className="p-4 sm:p-6">
                                <div className="max-w-xl">
                                    <HealthMeter value={currentHp} max={maxHp} />
                                    <p className="mt-4 min-h-8 text-sm leading-relaxed text-white/50">
                                        {healHint}
                                    </p>
                                    <CommonButton
                                        variant="success"
                                        className="mt-4 justify-center sm:min-w-44"
                                        disabled={!ready || !canHeal}
                                        onPress={onHeal}
                                        icon={(
                                            <span className="flex items-center gap-1">
                                                <CommonImage src="/images/ui/coin.png" alt="" className="size-4" />
                                                <span>{SURVIVAL_HEAL_COST}</span>
                                            </span>
                                        )}
                                        iconPosition="right"
                                    >
                                        {t('survival.heal')}
                                    </CommonButton>
                                </div>
                            </div>
                        </div>
                    ) : activeTab === 'inventory' ? (
                        <div className="flex flex-col border-game border-white/10 bg-galatime-dark/50 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                            <div className="flex shrink-0 items-center justify-between border-b-game border-white/10 px-3 py-2">
                                <h2 className="text-[0.65rem] uppercase tracking-[0.3em] text-white/45">
                                    {t('survival.inventory.title')}
                                </h2>
                                <p className="text-[0.6rem] uppercase tracking-[0.12em] text-white/35">
                                    {t('survival.inventory.count', { count: owned.length })}
                                </p>
                            </div>

                            <div className="p-3 sm:p-4">
                                {owned.length === 0 ? (
                                    <p className="max-w-md text-sm leading-relaxed text-white/50">
                                        {t('survival.inventory.empty')}
                                    </p>
                                ) : (
                                    <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                        {owned.map(({ item, quantity }) => (
                                            <li
                                                key={item.id}
                                                className="flex gap-3 border-game border-white/15 bg-galatime-darkHover/70 p-2.5"
                                            >
                                                <div className="flex size-14 shrink-0 items-center justify-center border-game border-white/10 bg-galatime-background">
                                                    <UnknownIcon className="h-7 w-7 text-white/20" />
                                                </div>
                                                <div className="flex min-w-0 flex-1 flex-col">
                                                    <div className="flex items-start justify-between gap-2">
                                                        <p className="truncate text-sm uppercase tracking-[0.08em] text-white">
                                                            {item.name}
                                                        </p>
                                                        <span className="shrink-0 text-sm leading-none text-white/70">
                                                            {t('survival.inventory.quantity', { quantity })}
                                                        </span>
                                                    </div>
                                                    <p className={`text-[0.6rem] uppercase tracking-[0.16em] ${RARITY_CLASS[item.rarity]}`}>
                                                        {t(`survival.rarity.${item.rarity}`)}
                                                    </p>
                                                    <p className="mt-1 text-[0.65rem] uppercase tracking-[0.12em] text-galatime-stats-health">
                                                        {itemEffectSummary(item)}
                                                    </p>
                                                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/45">
                                                        {item.description}
                                                    </p>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                <p className="mt-3 text-[0.65rem] uppercase tracking-[0.12em] text-white/30">
                                    {t('survival.inventory.combatHint')}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="flex flex-col border-game border-white/10 bg-galatime-dark/50 lg:min-h-0 lg:flex-1 lg:overflow-hidden">
                                <div className="flex shrink-0 items-center justify-between border-b-game border-white/10 px-3 py-2">
                                    <h2 className="text-[0.65rem] uppercase tracking-[0.3em] text-white/45">
                                        {t('survival.shop.title')}
                                    </h2>
                                    {clearedRound !== null && (
                                        <p className="text-xs text-galatime-success">
                                            {t('survival.roundCleared', { round: clearedRound })}
                                        </p>
                                    )}
                                </div>

                                <div className="p-3 sm:p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                                    {stock.length === 0 ? (
                                        <p className="max-w-md text-sm leading-relaxed text-white/50">
                                            {t('survival.shop.empty')}
                                        </p>
                                    ) : (
                                        <div className="grid auto-rows-fr grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:h-full">
                                            {stock.map((item) => {
                                                const active = item.id === selected?.id;
                                                return (
                                                    <button
                                                        key={item.id}
                                                        type="button"
                                                        aria-pressed={active}
                                                        aria-label={t('survival.shop.select', {
                                                            name: item.name,
                                                            price: item.price,
                                                        })}
                                                        onMouseEnter={() => playSfx('hover')}
                                                        onClick={() => {
                                                            playSfx('click');
                                                            setSelectedId(item.id);
                                                        }}
                                                        className={`relative flex min-h-40 flex-col border-game bg-galatime-darkHover/70 p-2 text-left outline-offset-2 transition-colors duration-200 focus-visible:outline focus-visible:outline-game focus-visible:outline-galatime-primary ${active
                                                            ? 'border-galatime-warning outline outline-game outline-galatime-warning/40'
                                                            : 'border-white/15 hover:border-galatime-primary/70'}`}
                                                    >
                                                        <span className="absolute right-2 top-2 z-10 flex items-center gap-1 border-game border-galatime-warning/50 bg-galatime-background px-1.5 py-0.5 text-xs text-galatime-warning">
                                                            <CommonImage src="/images/ui/coin.png" alt="" className="size-3" />
                                                            {item.price}
                                                        </span>

                                                        <ShelfItemArt />

                                                        <span className="mt-3 px-0.5 text-sm uppercase tracking-[0.1em] text-white">
                                                            {item.name}
                                                        </span>
                                                        <span className="mt-1 px-0.5 text-[0.65rem] uppercase tracking-[0.12em] text-galatime-stats-health">
                                                            {itemEffectSummary(item)}
                                                        </span>
                                                        <span className="mt-auto flex items-center justify-between gap-2 px-0.5 pt-3">
                                                            <span className="text-[0.55rem] uppercase tracking-[0.2em] text-white/30">
                                                                {item.category}
                                                            </span>
                                                            <span className={`text-[0.55rem] uppercase tracking-[0.16em] ${RARITY_CLASS[item.rarity]}`}>
                                                                {t(`survival.rarity.${item.rarity}`)}
                                                            </span>
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {selected && (
                                <div className="grid shrink-0 gap-3 border-game border-white/10 bg-galatime-dark p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                            <p className="text-sm uppercase tracking-[0.12em] text-white">
                                                {selected.name}
                                            </p>
                                            <span className={`text-[0.6rem] uppercase tracking-[0.16em] ${RARITY_CLASS[selected.rarity]}`}>
                                                {t(`survival.rarity.${selected.rarity}`)}
                                            </span>
                                            {selectedOwned > 0 && (
                                                <span className="text-[0.6rem] uppercase tracking-[0.12em] text-white/40">
                                                    {t('survival.inventory.quantity', { quantity: selectedOwned })}
                                                </span>
                                            )}
                                        </div>
                                        <p className="mt-1 text-sm leading-relaxed text-white/55">
                                            {selected.description}
                                        </p>
                                    </div>
                                    <div className="flex items-center justify-between gap-3 sm:justify-end">
                                        <span className="flex items-center gap-1.5 text-lg text-galatime-warning">
                                            <CommonImage src="/images/ui/coin.png" alt="" className="size-4" />
                                            {selected.price}
                                        </span>
                                        <div className="flex flex-col items-end gap-1">
                                            <CommonButton
                                                variant="outline"
                                                disabled={!selectedCanBuy}
                                                title={buyHint}
                                                onPress={() => onBuy(selected.id)}
                                            >
                                                {t('survival.shop.buy')}
                                            </CommonButton>
                                            {buyHint && (
                                                <span className="text-[0.6rem] uppercase tracking-[0.12em] text-white/35">
                                                    {buyHint}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </section>
            </div>
        </div>
    );
}
