import { useEffect, useMemo, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react';
import { ArrowDown, ArrowUp, ElementIcon } from '../../../../assets/GalatimeIcon';
import CommonHoverElement from '../../../common/CommonHoverElement';
import CommonTooltipCard from '../../../common/CommonTooltipCard';
import { fetchAttack } from '../../../../controllers/attackController';
import { elementTint } from '../../../../constants/CombatAnimationConstants';
import type { CombatStats } from '../../../../types/CombatType';
import type {
    CombatFormationEntity,
    CombatStatModifier,
    CombatStatusBadge,
} from './CombatFormationHUD.types';

interface CombatFormationTooltipProps {
    id: string;
    entity: CombatFormationEntity;
    showDetails: boolean;
    floatingRef: Ref<HTMLDivElement>;
    style: CSSProperties;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
}

interface FormationSkill {
    id: string;
    name: string;
    elementId: string;
    isKnown: boolean;
}

function displayElementName(id: string) {
    return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** How each stat a modifier can name is written on the board. */
const STAT_LABELS: Record<keyof CombatStats, string> = {
    maxHp: 'HP',
    maxMana: 'Mana',
    maxStamina: 'Stamina',
    physicalAttack: 'Physical Attack',
    magicalAttack: 'Magical Attack',
    physicalDefense: 'Physical Defense',
    magicalDefense: 'Magical Defense',
    speed: 'Speed',
    accuracy: 'Accuracy',
    evasion: 'Evasion',
    critChance: 'Critical',
};

/** Label colour of a status, matching the sprite chip's tone. */
const STATUS_TONE_TEXT: Record<CombatStatusBadge['tone'], string> = {
    buff: 'text-galatime-successHover',
    debuff: 'text-galatime-errorHover',
    neutral: 'text-white/75',
};

/** Fill of the status dot, matching the tones used by the sprite chips. */
const STATUS_TONE_DOT: Record<CombatStatusBadge['tone'], string> = {
    buff: 'bg-galatime-success',
    debuff: 'bg-galatime-error',
    neutral: 'bg-white/55',
};

/** `+10`, `-12`, `+2.5` — the sign is the point, so it is always drawn. */
function formatDelta(delta: number): string {
    return `${delta > 0 ? '+' : ''}${Math.round(delta * 10) / 10}`;
}

/** A titled block: the heading is deliberately small and muted so the content reads first. */
function TooltipSection({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="mt-2.5 border-t-game border-white/15 pt-2 sm:mt-3 sm:pt-2.5">
            <p className="mb-1.5 font-pixel text-[9px] uppercase tracking-[0.18em] text-white/40 sm:text-[10px]">
                {title}
            </p>
            {children}
        </section>
    );
}

/**
 * Folds every modifier of the same stat into one entry.
 *
 * The backend already narrows the effects to one net delta per stat, but merging here as
 * well keeps the board honest if two sources ever report the same stat separately: the
 * player reads `Magical Attack +10`, never the same `+5` twice.
 */
function mergeModifiers(modifiers: readonly CombatStatModifier[]): CombatStatModifier[] {
    const totals = new Map<keyof CombatStats, number>();
    for (const modifier of modifiers) {
        totals.set(modifier.stat, (totals.get(modifier.stat) ?? 0) + modifier.delta);
    }

    const merged: CombatStatModifier[] = [];
    for (const [stat, rawDelta] of totals) {
        const delta = Math.round(rawDelta * 10) / 10;
        if (delta !== 0) merged.push({ stat, delta });
    }

    // Raises before drops; `sort` is stable, so each group keeps the insertion order.
    return merged.sort((a, b) => Number(b.delta > 0) - Number(a.delta > 0));
}

interface FormationEffectsProps {
    statuses: readonly CombatStatusBadge[];
    modifiers: readonly CombatStatModifier[];
}

/**
 * The unit's live effects, in one block.
 *
 * Named statuses (`Wet`, `Frozen`, `Burning`) come first with their remaining duration,
 * followed by the net stat changes of every effect folded together. An unnamed effect is
 * only a stat change, so it does not get a second row: the merged stat line already says it.
 */
function FormationEffects({ statuses, modifiers }: FormationEffectsProps) {
    const { t } = useTranslation('combat');

    // Several effects can share a name (two `Wet` applications); one row per name is enough.
    const namedStatuses = useMemo(() => {
        const byLabel = new Map<string, CombatStatusBadge>();
        for (const status of statuses) {
            if (!status.named) continue;

            const existing = byLabel.get(status.label);
            if (!existing) {
                byLabel.set(status.label, status);
                continue;
            }

            // The same status applied twice: report the longest remaining duration, and let
            // "until the fight ends" win over any finite count.
            const turns = existing.turns === null || status.turns === null
                ? null
                : Math.max(existing.turns, status.turns);
            if (turns !== existing.turns) byLabel.set(status.label, { ...existing, turns });
        }
        return [...byLabel.values()];
    }, [statuses]);

    const mergedModifiers = useMemo(() => mergeModifiers(modifiers), [modifiers]);

    if (namedStatuses.length === 0 && mergedModifiers.length === 0) return null;

    return (
        <TooltipSection title={t('combat.tooltip.effects')}>
            <div className="flex flex-col gap-y-1">
                {namedStatuses.map((status) => (
                    <span
                        key={status.id}
                        className="flex w-full items-center gap-1.5 whitespace-nowrap font-pixel text-xs sm:text-sm"
                    >
                        <span
                            aria-hidden="true"
                            className={`h-1.5 w-1.5 shrink-0 border-game border-black/50 sm:h-2 sm:w-2 ${STATUS_TONE_DOT[status.tone]}`}
                            style={{ borderColor: status.elementId ? elementTint(status.elementId) : undefined }}
                        />
                        <span className={STATUS_TONE_TEXT[status.tone]}>{status.label}</span>
                        <span
                            className="ml-auto pl-3 font-pixel text-[10px] tabular-nums text-white/40 sm:text-xs"
                            title={status.turns === null ? t('combat.tooltip.untilEnd') : undefined}
                        >
                            {status.turns === null ? '∞' : t('combat.tooltip.turns', { count: status.turns })}
                        </span>
                    </span>
                ))}

                {mergedModifiers.map((modifier) => {
                    const raised = modifier.delta > 0;
                    return (
                        <span
                            key={modifier.stat}
                            className={`flex items-center gap-1 whitespace-nowrap font-pixel text-xs sm:text-sm ${raised ? 'text-galatime-successHover' : 'text-galatime-errorHover'}`}
                        >
                            {raised ? <ArrowUp /> : <ArrowDown />}
                            <span className="text-white/70">{STAT_LABELS[modifier.stat]}</span>
                            <span className="font-bold tabular-nums">{formatDelta(modifier.delta)}</span>
                        </span>
                    );
                })}
            </div>
        </TooltipSection>
    );
}

interface FormationElementsProps {
    /** Every element the character carries; the weaknesses are read from the combination. */
    elementIds: readonly string[];
    /** Whether the fighting-tooltip setting allows the weakness table. */
    showWeaknesses: boolean;
}

/**
 * The character's elements, which hover as one block.
 *
 * The block is the trigger rather than each name, because the answer is about the
 * *combination*: the multipliers are consolidated across it, so a single element
 * on its own would not mean anything. A block is also a stable target - a row of
 * separate triggers opens and closes as the pointer crosses the gaps between them.
 *
 * The popup itself ignores the pointer. One that could take it would pull the
 * pointer off the row, close, and re-open under the cursor, flickering forever.
 */
function FormationElements({ elementIds: combinationIds, showWeaknesses }: FormationElementsProps) {
    const [hovered, setHovered] = useState(false);
    const { refs, floatingStyles } = useFloating({
        open: hovered,
        placement: 'left-start',
        whileElementsMounted: autoUpdate,
        middleware: [offset(8), flip(), shift({ padding: 12 })],
    });

    return (
        <>
            <div
                ref={refs.setReference}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                className={`mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 sm:gap-x-2 sm:gap-y-1 ${showWeaknesses ? 'cursor-help' : ''}`}
            >
                {combinationIds.map((elementId) => (
                    <span
                        key={elementId}
                        className="flex items-center gap-1 whitespace-nowrap font-pixel text-xs text-white/75 sm:text-sm"
                    >
                        <ElementIcon id={elementId} className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                        {displayElementName(elementId)}
                    </span>
                ))}
            </div>

            {hovered && showWeaknesses && createPortal(
                <div ref={refs.setFloating} style={floatingStyles} className="pointer-events-none z-200">
                    <CommonHoverElement
                        elementIds={[...combinationIds]}
                        elementName={combinationIds.map(displayElementName).join(' / ')}
                        isVisible
                        isTooltip
                        isAttack={false}
                    />
                </div>,
                document.body,
            )}
        </>
    );
}

/**
 * Entity identity, with catalogue-resolved skill details when the fighting tooltip setting is on.
 *
 * The card reads top-down as a hierarchy: who the unit is, what is happening to it, what it
 * is made of, what it can cast, and finally what it is holding. Sections are separated by a
 * hairline and a small muted caption so the eye jumps between groups instead of scanning one
 * undifferentiated block of text.
 */
export function CombatFormationTooltip({
    id,
    entity,
    showDetails,
    floatingRef,
    style,
    onPointerEnter,
    onPointerLeave,
}: CombatFormationTooltipProps) {
    const { t } = useTranslation('combat');
    const elementIds = useMemo(() => [...new Set(entity.elementIds ?? [])], [entity.elementIds]);
    const skillIds = useMemo(() => [...new Set(entity.skillIds ?? [])], [entity.skillIds]);
    const abilities = entity.abilities ?? [];
    const modifiers = entity.modifiers ?? [];
    const statusBadges = entity.statusBadges ?? [];
    const weapon = entity.weapon ?? null;
    const [skills, setSkills] = useState<FormationSkill[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        setSkills(null);

        if (!showDetails || skillIds.length === 0) {
            setSkills([]);
            return () => { cancelled = true; };
        }

        const resolveSkills = async () => {
            const resolved: FormationSkill[] = [];
            for (const skillId of skillIds) {
                if (cancelled) return;
                try {
                    const attack = await fetchAttack(skillId);
                    resolved.push(attack
                        ? { id: skillId, name: attack.name, elementId: attack.element_id, isKnown: true }
                        : { id: skillId, name: displayElementName(skillId), elementId: 'unknown', isKnown: false });
                } catch (error) {
                    console.error(`Failed to resolve formation skill "${skillId}":`, error);
                    resolved.push({ id: skillId, name: displayElementName(skillId), elementId: 'unknown', isKnown: false });
                }
            }
            if (!cancelled) setSkills(resolved);
        };
        void resolveSkills();

        return () => { cancelled = true; };
    }, [skillIds, showDetails]);

    return (
        <CommonTooltipCard
            id={id}
            ref={floatingRef}
            style={style}
            role="tooltip"
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            className="pointer-events-auto z-100 w-max max-w-[min(17rem,calc(100vw-2rem))] px-2.5 py-2 sm:max-w-[min(22rem,calc(100vw-1.5rem))] sm:px-3.5 sm:py-2.5"
        >
            {/* Identity first: the largest text on the card, so the eye lands on the name. */}
            <p className="font-pixel text-base uppercase leading-tight tracking-[0.08em] text-white sm:text-xl">
                {entity.name}
            </p>

            {elementIds.length > 0 ? (
                <FormationElements elementIds={elementIds} showWeaknesses={showDetails} />
            ) : (
                <p className="mt-1 font-pixel text-xs text-white/45">{t('combat.tooltip.noElements')}</p>
            )}

            {/* What is happening to the unit right now: statuses and their net stat movement. */}
            <FormationEffects statuses={statusBadges} modifiers={modifiers} />

            {/* Innate abilities belong to the identity: what the creature *is*, before what it casts. */}
            {showDetails && abilities.length > 0 && (
                <TooltipSection title={t('combat.tooltip.abilities')}>
                    <div className="flex flex-col gap-y-1.5">
                        {abilities.map((ability) => (
                            <div key={ability.id} className="flex flex-col gap-y-0.5">
                                <span className="font-pixel text-xs text-white/90 sm:text-sm">
                                    {ability.name}
                                </span>
                                {ability.description && (
                                    <span className="font-pixel text-[10px] leading-snug text-white/55 sm:text-xs">
                                        {ability.description}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </TooltipSection>
            )}

            {showDetails && (skills === null ? (
                <TooltipSection title={t('combat.tooltip.skills')}>
                    <p className="font-pixel text-xs text-white/40">{t('combat.tooltip.loadingSkills')}</p>
                </TooltipSection>
            ) : skills.length > 0 ? (
                <TooltipSection title={t('combat.tooltip.skills')}>
                    <div className="flex flex-col gap-y-1">
                        {skills.map((skill) => (
                            <span
                                key={skill.id}
                                title={skill.isKnown ? undefined : skill.id}
                                className="flex items-center gap-1 whitespace-nowrap font-pixel text-xs text-white/85 sm:text-sm"
                            >
                                <ElementIcon id={skill.elementId} className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                                {skill.name}
                            </span>
                        ))}
                    </div>
                </TooltipSection>
            ) : null)}

            {/* The equipped weapon closes the card: what is in this unit's hands right now,
                with its live ammo when the weapon feeds on any. Only meaningful with the
                detail view on. */}
            {showDetails && weapon && (
                <TooltipSection title={t('combat.tooltip.weapon')}>
                    <div className="flex flex-col gap-y-0.5">
                        <span className="flex items-baseline gap-1.5 font-pixel text-xs text-white/90 sm:text-sm">
                            {weapon.name}
                            <span className="text-[10px] uppercase tracking-[0.08em] text-white/40 sm:text-xs">
                                {weapon.type}
                            </span>
                        </span>
                        {weapon.summary && (
                            <span className="font-pixel text-[10px] leading-snug text-white/55 sm:text-xs">
                                {weapon.summary}
                            </span>
                        )}
                        {weapon.ammo && (
                            <span className="font-pixel text-[10px] text-white/45 sm:text-xs">
                                {t('combat.tooltip.ammo', { remaining: weapon.ammo.remaining, item: weapon.ammo.item })}
                            </span>
                        )}
                    </div>
                </TooltipSection>
            )}
        </CommonTooltipCard>
    );
}
