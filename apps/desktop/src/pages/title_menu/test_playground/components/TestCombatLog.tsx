import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import CommonButton from '../../../../components/common/CommonButton';
import { CloseIcon } from '../../../../assets/GalatimeIcon';
import type { CombatEvent, CombatUnit } from '../../../../types/CombatType';

interface TestCombatLogProps {
    /** Every event the fight has produced so far, oldest first. */
    events: readonly CombatEvent[];
    /** The roster as it stands, used to turn unit ids back into names. */
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
    /** Subject owning the block, shown as `[NAME]`. */
    title: string;
    lines: LogLine[];
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
 * Turns the fight's events into blocks, one subject at a time.
 *
 * A block starts whenever the subject changes — a character's turn, the ability
 * that just fired, the weather that rolled in — and every event of the same
 * subject is appended to it. The header carries the identity (`[ARTHUR]`,
 * `[FIRE CLOAK]`); the lines below only describe what happened, so the reader
 * never has to parse the same name twice.
 */
function formatEvents(
    events: readonly CombatEvent[],
    nameOf: (unitId: string) => string,
    t: TFunction<'playground'>,
): LogGroup[] {
    const groups: LogGroup[] = [];

    const push = (title: string, line: LogLine, forceNew = false) => {
        const last = groups[groups.length - 1];
        if (!forceNew && last && last.title === title) {
            last.lines.push(line);
            return;
        }
        groups.push({ key: line.key, title, lines: [line] });
    };

    const lineOf = (key: number, line: string, detail?: string): LogLine => ({
        key,
        text: line,
        detail,
    });

    for (const [key, event] of events.entries()) {
        switch (event.type) {
            case 'combat_started':
                push(
                    t('playground.combat.log.system'),
                    lineOf(
                        key,
                        t('playground.combat.log.started'),
                        t('playground.combat.log.order', { order: event.order.map(nameOf).join(' → ') }),
                    ),
                    true,
                );
                break;

            case 'turn_started':
                push(
                    nameOf(event.unitId),
                    lineOf(key, t('playground.combat.log.turnStarted')),
                    true,
                );
                break;

            case 'action_used':
                push(nameOf(event.actorId), lineOf(
                    key,
                    t('playground.combat.log.uses', { action: event.actionName }),
                    event.targetIds.length > 0
                        ? t('playground.combat.log.on', { targets: event.targetIds.map(nameOf).join(', ') })
                        : undefined,
                ));
                break;

            case 'attack_resolved': {
                const hit = event.resolution;
                const stats = t('playground.combat.log.attackStats', {
                    attack: short(hit.attackValue),
                    type: hit.damageType,
                    defense: short(hit.defenseValue),
                    power: hit.power,
                });

                if (!hit.isHit) {
                    push(nameOf(hit.attackerId), lineOf(
                        key,
                        t('playground.combat.log.miss', { target: nameOf(hit.targetId) }),
                        `${stats} · ${t('playground.combat.log.element', { value: hit.elementMultiplier })}`,
                    ));
                    break;
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

                push(nameOf(hit.attackerId), lineOf(
                    key,
                    t('playground.combat.log.hit', {
                        target: nameOf(hit.targetId),
                        amount: short(hit.finalDamage),
                    }),
                    `${chain} · ${stats} · ${t('playground.combat.log.hp', {
                        before: short(hit.targetHpBefore),
                        after: short(hit.targetHpAfter),
                    })}`,
                ));
                break;
            }

            case 'healed':
                push(nameOf(event.resolution.sourceId), lineOf(
                    key,
                    t('playground.combat.log.heal', {
                        target: nameOf(event.resolution.targetId),
                        amount: short(event.resolution.amount),
                    }),
                    t('playground.combat.log.hpAfter', { hp: short(event.resolution.targetHpAfter) }),
                ));
                break;

            case 'effect_applied':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.gain', { effect: event.statusEffect ?? event.effectId }),
                    event.turns === null
                        ? t('playground.combat.log.untilEnd')
                        : t('playground.combat.log.turns', { count: event.turns }),
                ));
                break;

            case 'effect_expired':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.lose', { effect: event.effectId }),
                ));
                break;

            case 'effect_resisted':
                push(nameOf(event.unitId), lineOf(
                    key,
                    event.captured
                        ? t('playground.combat.log.capture', { effect: event.statusEffect ?? event.effectId })
                        : t('playground.combat.log.resist', { effect: event.statusEffect ?? event.effectId }),
                ));
                break;

            case 'effect_deferred':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.deferredEffect', { effect: event.statusEffect ?? event.effectId }),
                ));
                break;

            case 'resource_changed':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.resource', {
                        resource: event.resource.toUpperCase(),
                        previous: short(event.previous),
                        next: short(event.next),
                    }),
                ));
                break;

            case 'unit_defeated':
                push(nameOf(event.unitId), lineOf(key, t('playground.combat.log.defeated')));
                break;

            case 'unit_revived':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.revived', { caster: nameOf(event.casterId) }),
                ));
                break;

            case 'unit_line_changed':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.line', {
                        line: t(`playground.combat.log.lines.${event.line}`),
                    }),
                ));
                break;

            case 'action_postponed':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.postponed', { count: event.slots }),
                ));
                break;

            case 'weather_changed':
                push(event.label, lineOf(
                    key,
                    t('playground.combat.log.weatherChanged', { count: event.rounds }),
                ));
                break;

            case 'weather_ended':
                push(event.id, lineOf(key, t('playground.combat.log.weatherEnded')));
                break;

            case 'attack_retried':
                push(nameOf(event.attackerId), lineOf(
                    key,
                    t('playground.combat.log.retried', { target: nameOf(event.targetId) }),
                ));
                break;

            case 'ability_triggered':
                push(event.abilityName, lineOf(
                    key,
                    t('playground.combat.log.ability', { unit: nameOf(event.unitId) }),
                    event.targetIds.length > 0
                        ? t('playground.combat.log.on', { targets: event.targetIds.map(nameOf).join(', ') })
                        : undefined,
                ));
                break;

            case 'unit_summoned':
                push(event.name, lineOf(
                    key,
                    t('playground.combat.log.summoned', {
                        source: nameOf(event.sourceId),
                        line: t(`playground.combat.log.lines.${event.line}`),
                    }),
                ));
                break;

            case 'unit_transformed':
                push(event.name, lineOf(key, t('playground.combat.log.transformed')));
                break;

            case 'damage_reflected':
                push(event.abilityName, lineOf(
                    key,
                    event.isHit
                        ? t('playground.combat.log.reflected', {
                            amount: short(event.amount),
                            target: nameOf(event.targetId),
                        })
                        : t('playground.combat.log.reflectedMiss', { target: nameOf(event.targetId) }),
                    t('playground.combat.log.hpAfter', { hp: short(event.targetHpAfter) }),
                ));
                break;

            case 'shield_absorbed':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.shield', {
                        effect: event.effectId,
                        amount: short(event.amount),
                    }),
                    t('playground.combat.log.shieldLeft', { remaining: short(event.remaining) }),
                ));
                break;

            case 'turn_skipped':
                push(nameOf(event.unitId), lineOf(key, t('playground.combat.log.turnSkipped')));
                break;

            case 'action_cancelled':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.cancelled', {
                        action: event.actionId,
                        effect: event.effectId,
                    }),
                ));
                break;

            case 'action_interrupted':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.interrupted', {
                        action: event.actionId,
                        effect: event.statusEffect ?? event.effectId,
                    }),
                ));
                break;

            case 'damage_deferred':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.deferred', { amount: short(event.amount) }),
                    t('playground.combat.log.from', { source: nameOf(event.sourceId) }),
                ));
                break;

            case 'unit_rewound': {
                const pools = t('playground.combat.log.rewindPools', {
                    hp: short(event.restoredHp),
                    mana: short(event.restoredMana),
                    stamina: short(event.restoredStamina),
                });
                const removed = event.removedEffectIds.length > 0
                    ? t('playground.combat.log.rewindRemoved', { effects: event.removedEffectIds.join(', ') })
                    : '';

                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.rewind', { count: event.turns }),
                    [pools, removed].filter(Boolean).join(' · '),
                ));
                break;
            }

            case 'flee_attempted':
                push(nameOf(event.unitId), lineOf(
                    key,
                    event.escaped
                        ? t('playground.combat.log.escaped')
                        : t('playground.combat.log.escapeFailed'),
                ));
                break;

            case 'weapon_durability_changed':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.weaponDurability', {
                        weapon: event.weaponId,
                        previous: event.previous,
                        next: event.next,
                    }),
                ));
                break;

            case 'weapon_broken':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.weaponBroken', { weapon: event.weaponName }),
                ));
                break;

            case 'weapon_equipped':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.weaponEquipped', { weapon: event.weaponName }),
                ));
                break;

            case 'weapon_ammo_changed':
                push(nameOf(event.unitId), lineOf(
                    key,
                    t('playground.combat.log.ammo', {
                        item: event.itemId,
                        state: t(event.consumed
                            ? 'playground.combat.log.ammoSpent'
                            : 'playground.combat.log.ammoKept'),
                        remaining: event.remaining,
                    }),
                ));
                break;

            case 'loot_gained':
                push(event.itemName, lineOf(
                    key,
                    t('playground.combat.log.loot', { quantity: event.quantity }),
                    t('playground.combat.log.lootFrom', { source: nameOf(event.sourceId) }),
                ));
                break;

            case 'combat_ended':
                push(
                    t('playground.combat.log.system'),
                    lineOf(
                        key,
                        t('playground.combat.log.combatOver', { outcome: event.outcome }),
                        event.reason,
                    ),
                    true,
                );
                break;

            case 'turn_ended':
                // The next `turn_started` already delimits a turn; logging both doubles the noise.
                break;
        }
    }

    return groups;
}

/**
 * Running commentary on a playground fight: actions, rolls, damage maths and deaths.
 *
 * The log is a panel that floats over the right edge of the battle, never a column
 * that steals width from it. It opens and closes from its own header, and each
 * subject — a character, an ability, a weather front — gets one block with a
 * `[NAME]` header, a white line and a muted detail line.
 */
export function TestCombatLog({ events, units, onClear, className = '' }: TestCombatLogProps) {
    const { t } = useTranslation('playground');
    const [open, setOpen] = useState(true);
    const boxRef = useRef<HTMLDivElement | null>(null);

    const groups = useMemo(() => {
        const names = new Map(units.map((unit) => [unit.id, unit.name]));
        return formatEvents(events, (unitId) => names.get(unitId) ?? unitId, t);
    }, [events, units, t]);

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
                                    <li key={group.key} className="flex flex-col gap-1.5 border-l border-white/10 pl-2.5">
                                        <span className="text-sm uppercase leading-none tracking-[0.14em] text-white">
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
                    className="pointer-events-auto bg-galatime-dark/90 backdrop-blur-sm"
                    onPress={() => setOpen(true)}
                >
                    {t('playground.combat.log.open')}
                    {events.length > 0 && (
                        <span className="text-xs tabular-nums text-white/40">{events.length}</span>
                    )}
                </CommonButton>
            )}
        </div>
    );
}

export default TestCombatLog;
