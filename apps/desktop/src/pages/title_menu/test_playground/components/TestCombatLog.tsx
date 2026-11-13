import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import CommonButton from '../../../../components/common/CommonButton';
import { CloseIcon } from '../../../../assets/GalatimeIcon';
import { elementTint } from '../../../../constants/CombatAnimationConstants';
import type { CombatEvent, CombatUnit } from '../../../../types/CombatType';

interface TestCombatLogProps {
    /** Every event the fight has produced so far, oldest first. */
    events: readonly CombatEvent[];
    /** The roster as it stands, used to turn unit ids back into names and colours. */
    units: readonly CombatUnit[];
    onClear?: () => void;
    className?: string;
}

interface LogLine {
    key: number;
    /** The line the reader follows: always white, one step above the detail. */
    text: string;
    /** The maths and the leftovers: always muted, one step below the text. */
    detail?: string;
}

interface LogGroup {
    key: number;
    /** The unit whose turn this is, shown as `[NAME]`. */
    title: string;
    /** The unit's element tint, so names are recognisable at a glance. */
    color: string;
    lines: LogLine[];
}

interface PendingEvent {
    key: number;
    event: CombatEvent;
}

interface RawSegment {
    kind: 'system' | 'turn' | 'loot';
    title: string;
    color: string;
    /** The unit acting in this block; absent for system and loot blocks. */
    unitId?: string;
    events: PendingEvent[];
}

interface CostEntry {
    key: number;
    resource: 'hp' | 'mana' | 'stamina';
    previous: number;
    next: number;
}

/**
 * Trims a computed number to at most two decimals.
 *
 * The damage pipeline multiplies floats, so a raw `baseDamage` reads as
 * `2.4390243902439024` — precise, and useless on a log line.
 */
function short(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Turns the fight's events into blocks, one turn at a time.
 *
 * Every block is a unit's turn: the header names the unit, and everything that
 * happened before the next turn belongs to it. The events that fire between
 * turns — idle regeneration, echoes, deferred damage, triggers — are buffered
 * and handed to the unit that is about to act, so a turn never looks emptier
 * than it was. Only combat start, combat end and loot stand on their own.
 *
 * Costs are part of the action that paid them: the log reports `MN −8` beside
 * the skill, never as a floating resource mutation. Outside rest, mana and
 * stamina changes are dropped entirely — they are bookkeeping, not battle.
 */
function formatEvents(
    events: readonly CombatEvent[],
    units: readonly CombatUnit[],
    t: TFunction<'playground'>,
): LogGroup[] {
    const unitsById = new Map(units.map((unit) => [unit.id, unit] as const));
    const nameOf = (unitId: string) => unitsById.get(unitId)?.name ?? unitId;
    const colorOf = (unitId: string) => elementTint(unitsById.get(unitId)?.elementIds[0]);

    const lineOf = (key: number, line: string, detail?: string): LogLine => ({
        key,
        text: line,
        detail,
    });

    const resourceName = (resource: 'hp' | 'mana' | 'stamina') =>
        t(`playground.combat.log.resourceShort.${resource}`);

    const raw: RawSegment[] = [];
    let current: RawSegment | null = null;
    let carry: PendingEvent[] = [];
    let afterCombat = false;

    for (const [key, event] of events.entries()) {
        if (event.type === 'loot_gained') {
            raw.push({ kind: 'loot', title: event.itemName, color: '#FFFFFF', events: [{ key, event }] });
            continue;
        }

        switch (event.type) {
            case 'combat_started':
                current = {
                    kind: 'system',
                    title: t('playground.combat.log.system'),
                    color: '#FFFFFF',
                    events: [{ key, event }],
                };
                raw.push(current);
                carry = [];
                afterCombat = false;
                break;

            case 'combat_ended':
                raw.push({
                    kind: 'system',
                    title: t('playground.combat.log.system'),
                    color: '#FFFFFF',
                    events: [...carry, { key, event }],
                });
                current = null;
                carry = [];
                afterCombat = true;
                break;

            case 'turn_started':
            case 'turn_skipped': {
                const segment: RawSegment = {
                    kind: 'turn',
                    title: nameOf(event.unitId),
                    color: colorOf(event.unitId),
                    unitId: event.unitId,
                    events: [...carry, { key, event }],
                };
                raw.push(segment);
                current = segment;
                carry = [];
                break;
            }

            case 'turn_ended':
                current = null;
                break;

            default:
                if (afterCombat) break;
                if (current) current.events.push({ key, event });
                else carry.push({ key, event });
        }
    }

    const eventLine = (event: CombatEvent, key: number): LogLine | null => {
        switch (event.type) {
            case 'combat_started':
                return lineOf(
                    key,
                    t('playground.combat.log.started'),
                    t('playground.combat.log.order', { order: event.order.map(nameOf).join(' → ') }),
                );

            case 'combat_ended':
                return lineOf(
                    key,
                    t('playground.combat.log.combatOver', { outcome: event.outcome }),
                    event.reason,
                );

            case 'turn_started':
            case 'turn_ended':
            case 'action_used':
            case 'resource_changed':
            case 'turn_skipped':
                return null;

            case 'attack_resolved': {
                const hit = event.resolution;
                const stats = t('playground.combat.log.attackStats', {
                    attack: short(hit.attackValue),
                    type: hit.damageType,
                    defense: short(hit.defenseValue),
                    power: hit.power,
                });

                if (!hit.isHit) {
                    return lineOf(
                        key,
                        t('playground.combat.log.miss', { target: nameOf(hit.targetId) }),
                        `${stats} · ${t('playground.combat.log.element', { value: hit.elementMultiplier })}`,
                    );
                }

                // The chain in the order it is evaluated:
                // (ATK / DEF) x EFFECT x PWR -> lane -> bracing -> variance.
                const chain = t('playground.combat.log.attackRatio', {
                    ratio: short(hit.attackValue / Math.max(1, hit.defenseValue)),
                    element: hit.elementMultiplier,
                    base: short(hit.baseDamage),
                    position: hit.positionModifier,
                    variance: short(hit.variance),
                    final: short(hit.finalDamage),
                    brace: hit.defenseReduction > 0
                        ? t('playground.combat.log.brace', { value: short(1 - hit.defenseReduction) })
                        : '',
                    hits: hit.hits > 1
                        ? t('playground.combat.log.hits', { count: hit.hits })
                        : '',
                });

                return lineOf(
                    key,
                    t('playground.combat.log.hit', {
                        target: nameOf(hit.targetId),
                        amount: short(hit.finalDamage),
                    }),
                    `${chain} · ${stats} · ${t('playground.combat.log.hp', {
                        before: short(hit.targetHpBefore),
                        after: short(hit.targetHpAfter),
                    })}`,
                );
            }

            case 'healed':
                return lineOf(
                    key,
                    t('playground.combat.log.heal', {
                        target: nameOf(event.resolution.targetId),
                        amount: short(event.resolution.amount),
                    }),
                    t('playground.combat.log.hpAfter', { hp: short(event.resolution.targetHpAfter) }),
                );

            case 'effect_applied':
                return lineOf(
                    key,
                    t('playground.combat.log.gain', { effect: event.statusEffect ?? event.effectId }),
                    event.turns === null
                        ? t('playground.combat.log.untilEnd')
                        : t('playground.combat.log.turns', { count: event.turns }),
                );

            case 'effect_expired':
                return lineOf(key, t('playground.combat.log.lose', { effect: event.effectId }));

            case 'effect_resisted':
                return lineOf(
                    key,
                    event.captured
                        ? t('playground.combat.log.capture', { effect: event.statusEffect ?? event.effectId })
                        : t('playground.combat.log.resist', { effect: event.statusEffect ?? event.effectId }),
                );

            case 'effect_deferred':
                return lineOf(
                    key,
                    t('playground.combat.log.deferredEffect', { effect: event.statusEffect ?? event.effectId }),
                );

            case 'unit_defeated':
                return lineOf(key, t('playground.combat.log.defeated'));

            case 'unit_revived':
                return lineOf(key, t('playground.combat.log.revived', { caster: nameOf(event.casterId) }));

            case 'unit_line_changed':
                return lineOf(
                    key,
                    t('playground.combat.log.line', {
                        line: t(`playground.combat.log.lines.${event.line}`),
                    }),
                );

            case 'action_postponed':
                return lineOf(key, t('playground.combat.log.postponed', { count: event.slots }));

            case 'weather_changed':
                return lineOf(
                    key,
                    t('playground.combat.log.weatherChanged', {
                        label: event.label,
                        count: event.rounds,
                    }),
                );

            case 'weather_ended':
                return lineOf(key, t('playground.combat.log.weatherEnded', { label: event.id }));

            case 'attack_retried':
                return lineOf(key, t('playground.combat.log.retried', { target: nameOf(event.targetId) }));

            case 'ability_triggered':
                return lineOf(
                    key,
                    t('playground.combat.log.ability', { ability: event.abilityName }),
                    event.targetIds.length > 0
                        ? t('playground.combat.log.on', { targets: event.targetIds.map(nameOf).join(', ') })
                        : undefined,
                );

            case 'unit_summoned':
                return lineOf(
                    key,
                    t('playground.combat.log.summoned', {
                        name: event.name,
                        line: t(`playground.combat.log.lines.${event.line}`),
                    }),
                );

            case 'unit_transformed':
                return lineOf(key, t('playground.combat.log.transformed', { name: event.name }));

            case 'damage_reflected':
                return lineOf(
                    key,
                    event.isHit
                        ? t('playground.combat.log.reflected', { amount: short(event.amount) })
                        : t('playground.combat.log.reflectedMiss'),
                    [
                        t('playground.combat.log.from', { source: event.abilityName }),
                        t('playground.combat.log.hpAfter', { hp: short(event.targetHpAfter) }),
                    ].join(' · '),
                );

            case 'shield_absorbed':
                return lineOf(
                    key,
                    t('playground.combat.log.shield', {
                        effect: event.effectId,
                        amount: short(event.amount),
                    }),
                    t('playground.combat.log.shieldLeft', { remaining: short(event.remaining) }),
                );

            case 'action_cancelled':
                return lineOf(
                    key,
                    t('playground.combat.log.cancelled', {
                        action: event.actionId,
                        effect: event.effectId,
                    }),
                );

            case 'action_interrupted':
                return lineOf(
                    key,
                    t('playground.combat.log.interrupted', {
                        action: event.actionId,
                        effect: event.statusEffect ?? event.effectId,
                    }),
                );

            case 'damage_deferred':
                return lineOf(
                    key,
                    t('playground.combat.log.deferred', { amount: short(event.amount) }),
                    t('playground.combat.log.from', { source: nameOf(event.sourceId) }),
                );

            case 'unit_rewound': {
                const pools = t('playground.combat.log.rewindPools', {
                    hp: short(event.restoredHp),
                    mana: short(event.restoredMana),
                    stamina: short(event.restoredStamina),
                });
                const removed = event.removedEffectIds.length > 0
                    ? t('playground.combat.log.rewindRemoved', { effects: event.removedEffectIds.join(', ') })
                    : '';

                return lineOf(
                    key,
                    t('playground.combat.log.rewind', { count: event.turns }),
                    [pools, removed].filter(Boolean).join(' · '),
                );
            }

            case 'flee_attempted':
                return lineOf(
                    key,
                    event.escaped
                        ? t('playground.combat.log.escaped')
                        : t('playground.combat.log.escapeFailed'),
                );

            case 'weapon_durability_changed':
                return lineOf(
                    key,
                    t('playground.combat.log.weaponDurability', {
                        weapon: event.weaponId,
                        previous: event.previous,
                        next: event.next,
                    }),
                );

            case 'weapon_broken':
                return lineOf(key, t('playground.combat.log.weaponBroken', { weapon: event.weaponName }));

            case 'weapon_equipped':
                return lineOf(key, t('playground.combat.log.weaponEquipped', { weapon: event.weaponName }));

            case 'weapon_ammo_changed':
                return lineOf(
                    key,
                    t('playground.combat.log.ammo', {
                        item: event.itemId,
                        state: t(event.consumed
                            ? 'playground.combat.log.ammoSpent'
                            : 'playground.combat.log.ammoKept'),
                        remaining: event.remaining,
                    }),
                );

            case 'loot_gained':
                return lineOf(
                    key,
                    t('playground.combat.log.loot', { quantity: event.quantity }),
                    t('playground.combat.log.lootFrom', { source: nameOf(event.sourceId) }),
                );
        }
    };

    const formatTurn = (segment: RawSegment): LogGroup => {
        const lines: LogLine[] = [];
        let costs: CostEntry[] = [];
        let restLine: LogLine | null = null;
        let restRecovery: string[] = [];

        const flushCosts = () => {
            for (const cost of costs) {
                if (cost.resource !== 'hp') continue;
                lines.push(lineOf(
                    cost.key,
                    t('playground.combat.log.resource', {
                        resource: resourceName('hp'),
                        previous: short(cost.previous),
                        next: short(cost.next),
                    }),
                ));
            }
            costs = [];
        };

        const finalizeRest = () => {
            if (!restLine) return;
            restLine.detail = restRecovery.length > 0
                ? t('playground.combat.log.restRecovered', { recovery: restRecovery.join(' · ') })
                : t('playground.combat.log.restNoRecovery');
            restLine = null;
            restRecovery = [];
        };

        for (const { key, event } of segment.events) {
            if (event.type === 'turn_started' || event.type === 'turn_ended') continue;

            if (event.type === 'resource_changed') {
                const delta = event.next - event.previous;
                const own = event.unitId === segment.unitId;
                // Changes on someone else (a drain, a transfer) belong in this
                // block but must name their owner; the header only names the actor.
                const label = own
                    ? resourceName(event.resource)
                    : `${nameOf(event.unitId)} ${resourceName(event.resource)}`;

                if (delta < 0 && own) {
                    costs.push({
                        key,
                        resource: event.resource,
                        previous: event.previous,
                        next: event.next,
                    });
                    continue;
                }

                if (delta > 0 && own && (event.resource === 'mana' || event.resource === 'stamina') && restLine) {
                    restRecovery.push(t('playground.combat.log.recover', {
                        resource: label,
                        amount: short(delta),
                    }));
                    continue;
                }

                // The actor's own mana and stamina outside rest are bookkeeping.
                if (own && (event.resource === 'mana' || event.resource === 'stamina')) {
                    continue;
                }

                lines.push(lineOf(
                    key,
                    t('playground.combat.log.resource', {
                        resource: label,
                        previous: short(event.previous),
                        next: short(event.next),
                    }),
                ));
                continue;
            }

            if (event.type === 'action_used') {
                if (event.kind === 'rest') {
                    flushCosts();
                    finalizeRest();
                    const line = lineOf(key, t('playground.combat.log.rest'));
                    lines.push(line);
                    restLine = line;
                    restRecovery = [];
                    continue;
                }

                finalizeRest();
                const paid = costs.map((cost) => t('playground.combat.log.cost', {
                    resource: resourceName(cost.resource),
                    amount: short(Math.abs(cost.next - cost.previous)),
                }));
                costs = [];

                const targets = event.targetIds.length > 0
                    ? t('playground.combat.log.on', { targets: event.targetIds.map(nameOf).join(', ') })
                    : '';
                const detail = [targets, ...paid].filter(Boolean).join(' · ');

                lines.push(lineOf(
                    key,
                    t('playground.combat.log.uses', { action: event.actionName }),
                    detail || undefined,
                ));
                continue;
            }

            if (event.type === 'turn_skipped') {
                flushCosts();
                finalizeRest();
                lines.push(lineOf(key, t('playground.combat.log.turnSkipped')));
                continue;
            }

            flushCosts();
            finalizeRest();
            const line = eventLine(event, key);
            if (line) lines.push(line);
        }

        finalizeRest();
        flushCosts();

        const first = segment.events[0];
        return {
            key: first ? first.key : 0,
            title: segment.title,
            color: segment.color,
            lines,
        };
    };

    return raw
        .map((segment) => {
            if (segment.kind === 'turn') return formatTurn(segment);

            const lines = segment.events
                .map(({ key, event }) => eventLine(event, key))
                .filter((line): line is LogLine => line !== null);

            return {
                key: segment.events[0]?.key ?? 0,
                title: segment.title,
                color: segment.color,
                lines,
            };
        })
        .filter((group) => group.lines.length > 0);
}

/**
 * Running commentary on a playground fight: actions, rolls, damage maths and deaths.
 *
 * The log is a panel that floats over the right edge of the battle, never a column
 * that steals width from it. It opens and closes from its own header, and every
 * block is one unit's turn — the name in its element colour, the action in white,
 * the maths in grey.
 */
export function TestCombatLog({ events, units, onClear, className = '' }: TestCombatLogProps) {
    const { t } = useTranslation('playground');
    const [open, setOpen] = useState(false);
    const boxRef = useRef<HTMLDivElement | null>(null);

    const groups = useMemo(() => formatEvents(events, units, t), [events, units, t]);

    // Follow the fight: the newest block is the one being looked at. Closing the
    // panel stops the chasing, so returning to it shows the same place it was left.
    useEffect(() => {
        if (!open) return;
        const box = boxRef.current;
        if (box) box.scrollTop = box.scrollHeight;
    }, [groups.length, open]);

    return (
        <div className={`pointer-events-none absolute bottom-2 right-2 top-12 z-30 flex flex-col items-end ${className}`}>
            {open ? (
                <section
                    aria-label={t('playground.combat.log.title')}
                    className="pointer-events-auto flex min-h-0 w-[min(22rem,calc(100vw-2rem))] flex-1 flex-col border-game border-white/70 bg-galatime-dark/95 shadow-[0_0_24px_rgba(0,0,0,0.65)] backdrop-blur-sm sm:w-[24rem]"
                >
                    <header className="flex shrink-0 items-center gap-2 border-b-game border-white/15 px-3 py-2">
                        <h3 className="mr-auto text-base uppercase leading-none tracking-[0.12em] text-white">
                            {t('playground.combat.log.title')}
                        </h3>

                        {events.length > 0 && (
                            <span className="text-xs tabular-nums text-white/40">
                                {t('playground.combat.log.events', { count: events.length })}
                            </span>
                        )}

                        {onClear && groups.length > 0 && (
                            <CommonButton
                                variant="ghost"
                                size="sm"
                                className="text-xs tracking-[0.1em] opacity-50 hover:opacity-100"
                                onPress={onClear}
                            >
                                {t('playground.combat.log.clear')}
                            </CommonButton>
                        )}

                        <CommonButton
                            variant="ghost"
                            size="sm"
                            icon={<CloseIcon className="h-5 w-5" />}
                            className="p-1 opacity-60 hover:opacity-100"
                            aria-label={t('playground.combat.log.close')}
                            onPress={() => setOpen(false)}
                        />
                    </header>

                    <div ref={boxRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
                        {groups.length === 0 ? (
                            <p className="text-sm text-white/40">{t('playground.combat.log.empty')}</p>
                        ) : (
                            <ol className="flex flex-col gap-5">
                                {groups.map((group) => (
                                    <li
                                        key={group.key}
                                        className="flex flex-col gap-1.5 border-l pl-2.5"
                                        style={{ borderColor: `${group.color}55` }}
                                    >
                                        <span
                                            className="text-sm uppercase leading-none tracking-[0.14em]"
                                            style={{ color: group.color }}
                                        >
                                            [{group.title.toUpperCase()}]
                                        </span>

                                        <div className="flex flex-col gap-1.5">
                                            {group.lines.map((line) => (
                                                <div key={line.key} className="flex flex-col">
                                                    <span className="text-sm leading-snug text-white">
                                                        {line.text}
                                                    </span>
                                                    {line.detail && (
                                                        <span className="text-xs leading-snug text-white/40">
                                                            {line.detail}
                                                        </span>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </li>
                                ))}
                            </ol>
                        )}
                    </div>
                </section>
            ) : (
                <CommonButton
                    variant="outline"
                    size="sm"
                    className="pointer-events-auto"
                    onPress={() => setOpen(true)}
                >
                    {t('playground.combat.log.open')}
                    {events.length > 0 && (
                        <span className="text-xs tabular-nums opacity-60">{events.length}</span>
                    )}
                </CommonButton>
            )}
        </div>
    );
}

export default TestCombatLog;
