import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { playSfx } from '../../../controllers/audioController';
import { fetchDialogue } from '../../../controllers/dialogueController';
import CommonButton from '../../../components/common/CommonButton';
import CommonInput from '../../../components/common/CommonInput';
import CommonSwitch from '../../../components/common/CommonSwitch';
import { DialogueView } from '../../../components/game/dialogue/DialogueView';
import { TestDialoguePopup, type TestDialoguePopupTab } from './components/TestDialoguePopup';
import {
    DIALOGUE_BOX_HEIGHT_ALLOWANCE_PX,
    DIALOGUE_SPRITE_MIN_HEIGHT_PX,
    resolveResultLabelKey,
} from '../../../constants/DialogueConstants';
import type { DialogueSessionSnapshot } from '../../../hooks/useDialogueSession';
import type { DialogueResponse } from '../../../types/DialogueType';
import type { StateChange, WorldStateInput } from '../../../types/WorldStateType';
import {
    OBJECTIVE_STATUSES,
    buildWorldStateInput,
    collectStateRequirements,
    createRequirementValues,
    type DialogueStateRequirement,
    type RequirementValues,
} from '../../../services/dialogueRequirementService';
import { relationshipStatePath } from '../../../services/state/worldStateService';
import { resolveCharacter } from '../../../services/dialogue/characterRegistryService';
import {
    hasCharacterEmotion,
    resolveCharacterPortrait,
} from '../../../services/characterPortraitService';

/**
 * Plays a dialogue for real, against the dialogue backend.
 *
 * It works in two steps, because a dialogue cannot be played without a state to
 * play it against and there is no way to guess one.
 *
 * 1. **Load** an id. The dialogue file is read and the values it gates on are
 *    worked out from its conditions — plus the items its effects move, because a
 *    dialogue that takes an item the player does not own cannot be played at all.
 *    Nothing else is offered, because nothing else would do anything.
 * 2. **Set those values**, then start. The defaults open every branch, so the
 *    interesting thing to do here is lower one and watch an option disappear.
 *
 * The stage takes the whole panel: the values and the session readout do not
 * stand beside it, they float over its right edge in one popup behind two tabs
 * (`TestDialoguePopup`), the way the combat log floats over a fight. The panel
 * mounts it open on Variables and switches it to Session the moment the
 * conversation ends, because the end is reported there: the box does not
 * announce it, and Session also lists — in red — the expressions no sprite
 * answered for while the session ran.
 *
 * The session readout reports exactly what the backend returned — which node,
 * which options it considered visible, what it changed and what it warned about.
 */

/** One editor, chosen by the shape of the value the dialogue compares against. */
function RequirementEditor({
    requirement,
    value,
    onChange,
}: {
    requirement: DialogueStateRequirement;
    value: string;
    onChange: (value: string) => void;
}) {
    // Where the dialogue reads it. Worth showing: it is the answer to "why is this
    // variable here at all".
    const usage = requirement.usage.join(', ');
    const frame = 'border-b-game border-white/10 py-3';

    if (requirement.kind === 'boolean') {
        return (
            <CommonSwitch
                // `CommonSwitch` is uncontrolled, so the key forces it to pick up a
                // value that changed underneath it.
                key={`${requirement.path}-${value}`}
                title={requirement.path}
                description={usage}
                defaultChecked={value === 'true'}
                onChange={(checked) => onChange(checked ? 'true' : 'false')}
                showDescription
                containerClassName={`setting-line ${frame}`}
            />
        );
    }

    if (requirement.kind === 'objective_status') {
        return (
            <div className={frame}>
                <p className="settings-label">{requirement.path}</p>

                <div className="mt-1 flex flex-wrap gap-1">
                    {OBJECTIVE_STATUSES.map((status) => (
                        <CommonButton
                            key={status}
                            variant="ghost"
                            size="sm"
                            aria-pressed={value === status}
                            onPress={() => onChange(status)}
                            className={`px-2 py-1 border-0 tracking-[0.15em] ${value === status
                                ? 'bg-white font-semibold text-galatime-dark'
                                : 'opacity-60 hover:opacity-100'
                                }`}
                        >
                            {status}
                        </CommonButton>
                    ))}
                </div>

                <p className="mt-1 text-xs text-white/40">{usage}</p>
            </div>
        );
    }

    return (
        <CommonInput
            title={requirement.path}
            value={value}
            onChange={onChange}
            type={requirement.kind === 'number' ? 'number' : 'text'}
            containerClassName={frame}
        />
    );
}

/** One `label: value` line of the session readout. */
function DebugRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-white/40">{label}</dt>
            <dd className="min-w-0 wrap-break-word text-white/70">{value}</dd>
        </div>
    );
}

/** Where one affinity started a run, and where it stands now. */
interface RelationshipReading {
    /** Value the session was started with. */
    from: number;
    /** Value the conversation has left it at. */
    to: number;
}

/**
 * The relationships a run starts with, keyed by their dotted state path.
 *
 * Seeded from the state the panel is about to hand the engine, so an affinity
 * the dialogue gates on but never writes still reads as a value rather than
 * being absent from the readout.
 */
function seedRelationships(
    worldState: WorldStateInput | undefined,
): Record<string, RelationshipReading> {
    const readings: Record<string, RelationshipReading> = {};

    for (const [characterId, kinds] of Object.entries(worldState?.relationship ?? {})) {
        for (const [kind, value] of Object.entries(kinds)) {
            const path = relationshipStatePath(characterId, kind);
            readings[path] = { from: value, to: value };
        }
    }

    return readings;
}

/**
 * Folds one step's relationship changes into the running readings.
 *
 * `next` is the value after the change, not the delta, so reporting the same
 * step twice is a no-op instead of a double count — which is why the readings
 * are accumulated rather than summed from the deltas.
 *
 * A path nothing seeded is one the dialogue only *writes*: its change carries
 * the value it had before, and that is where the reading starts.
 */
function applyRelationshipChanges(
    readings: Record<string, RelationshipReading>,
    changes: StateChange[],
): Record<string, RelationshipReading> {
    let updated = readings;

    for (const change of changes) {
        if (change.kind !== 'relationship_changed') {
            continue;
        }

        const to = Number(change.next);

        if (!Number.isFinite(to) || updated[change.target]?.to === to) {
            continue;
        }

        const from = updated[change.target]?.from ?? Number(change.previous ?? 0);

        updated = { ...updated, [change.target]: { from, to } };
    }

    return updated;
}

/** One face a response wants drawn: a cast member, or whoever is speaking. */
interface ExpressionRequest {
    characterId: string;
    emotion: string | null;
}

/**
 * The faces one response asks for: everyone standing in the cast, plus the
 * line and the question being read — they carry the emotion of this very step.
 */
function collectExpressionRequests(response: DialogueResponse): ExpressionRequest[] {
    const requests: ExpressionRequest[] = response.cast_state.characters.map((member) => ({
        characterId: member.character_id,
        emotion: member.emotion,
    }));

    const node = response.current_node;

    if (node?.speaker_id) {
        requests.push({ characterId: node.speaker_id, emotion: node.emotion });
    }

    if (node?.prompt?.speaker_id) {
        requests.push({ characterId: node.prompt.speaker_id, emotion: node.prompt.emotion ?? null });
    }

    return requests;
}

/**
 * The requested faces no sprite answers, as `character/emotion` keys.
 *
 * A named emotion is looked up on its own — no neutral fallback, because the
 * fallback is exactly what hides a missing expression from the stage. A face
 * that names no emotion only counts as missing when the character has no
 * artwork at all, and is then reported as `character/*`, since every
 * expression it could wear is missing with it.
 *
 * The key is the pair the stage would try to draw, so a line of this list
 * names the request that failed rather than a file path nobody authored.
 */
function findMissingExpressions(response: DialogueResponse): string[] {
    const pending = new Map<string, ExpressionRequest>();

    for (const request of collectExpressionRequests(response)) {
        const key = request.emotion
            ? `${request.characterId}/${request.emotion}`
            : `${request.characterId}/*`;

        pending.set(key, request);
    }

    const missing: string[] = [];

    for (const [key, { characterId, emotion }] of pending) {
        const displayName = resolveCharacter(characterId)?.display_name ?? null;
        const found = emotion
            ? hasCharacterEmotion(characterId, emotion, displayName)
            : resolveCharacterPortrait(characterId, null, displayName) !== null;

        if (!found) {
            missing.push(key);
        }
    }

    return missing;
}

export function TestDialoguePanel() {
    const { t } = useTranslation(['playground', 'dialogue']);
    const [dialogueId, setDialogueId] = useState('');
    const [error, setError] = useState<string | null>(null);

    /** The loaded dialogue and the values it gates on. `null` is step one. */
    const [loaded, setLoaded] = useState<{
        id: string;
        requirements: DialogueStateRequirement[];
    } | null>(null);
    const [values, setValues] = useState<RequirementValues>({});
    /** `key` forces a restart even when nothing else changed. */
    const [running, setRunning] = useState<{ id: string; key: number } | null>(null);
    const [snapshot, setSnapshot] = useState<DialogueSessionSnapshot | null>(null);

    /**
     * Every affinity the conversation has touched, keyed by dotted path.
     *
     * A response only carries the changes *this step* applied, so the readout
     * accumulates them here. That is also what keeps the final values on screen
     * once the session is over, when the response — and its `state_changes` —
     * are gone.
     */
    const [relationships, setRelationships] = useState<Record<string, RelationshipReading>>({});

    /**
     * The popup's own two pieces of state, lifted so the panel can move them:
     * it mounts open on Variables and switches itself to Session the moment the
     * conversation ends.
     */
    const [popupOpen, setPopupOpen] = useState(true);
    const [popupTab, setPopupTab] = useState<TestDialoguePopupTab>('variables');

    /**
     * The faces the session asked for and no sprite answered, sorted.
     *
     * Accumulated step by step rather than read from the file: the list
     * reports what playback has actually tried to draw, so a branch that was
     * never taken stays out of it.
     */
    const [missingExpressions, setMissingExpressions] = useState<string[]>([]);

    const response = snapshot?.response ?? null;
    const node = response?.current_node ?? null;

    // Rebuilt on every keystroke; `DialogueView` only reads it when a conversation
    // starts, so editing a value mid-conversation changes nothing until Start.
    const worldState = loaded ? buildWorldStateInput(loaded.requirements, values) : undefined;

    // Fold each step's changes in as they arrive. A status change re-renders the
    // same response, and re-applying an absolute value changes nothing, so the
    // repeat is harmless rather than something to guard against.
    useEffect(() => {
        const changes = snapshot?.response?.state_changes;

        if (changes && changes.length > 0) {
            setRelationships((previous) => applyRelationshipChanges(previous, changes));
        }
    }, [snapshot]);

    // The end is reported in Session — the box no longer announces it — so the
    // popup opens on that tab the moment the conversation completes.
    useEffect(() => {
        if (snapshot?.status !== 'completed') {
            return;
        }

        setPopupOpen(true);
        setPopupTab('session');
    }, [snapshot]);

    // Fold each step's unanswered faces in as they arrive. Keys already
    // listed change nothing, so the effect is a read on every step and a
    // write only when something new is missing.
    useEffect(() => {
        const response = snapshot?.response;

        if (!response) {
            return;
        }

        setMissingExpressions((previous) => {
            const found = findMissingExpressions(response);

            if (found.length === 0) {
                return previous;
            }

            const merged = new Set(previous);
            let changed = false;

            for (const key of found) {
                if (!merged.has(key)) {
                    merged.add(key);
                    changed = true;
                }
            }

            return changed ? [...merged].sort() : previous;
        });
    }, [snapshot]);

    const handleLoad = async () => {
        const id = dialogueId.trim();

        if (!id) {
            void playSfx('denied');
            return;
        }

        // The loader keys dialogues by file name, not by the `dialogue_id` the file
        // declares, so this asks the question the engine will ask.
        const definition = await fetchDialogue(id);

        if (!definition) {
            void playSfx('denied');
            setError(t('playground.dialogue.notFound'));
            setLoaded(null);
            return;
        }

        // No click here: the `Load` button already plays one on pointer down. The
        // keyboard path plays its own in `handleKeyDown`.
        const requirements = collectStateRequirements(definition);

        setValues(createRequirementValues(requirements));
        setLoaded({ id, requirements });
        setError(null);
        setRunning(null);
        setSnapshot(null);
        setRelationships({});
        setMissingExpressions([]);
        setPopupOpen(true);
        setPopupTab('variables');
    };

    // The `Change dialogue` and `Start` buttons play their own click; nothing here
    // may add a second one.
    const handleBack = () => {
        setLoaded(null);
        setRunning(null);
        setSnapshot(null);
        setError(null);
        setRelationships({});
        setMissingExpressions([]);
        setPopupOpen(true);
        setPopupTab('variables');
    };

    const handleStart = () => {
        if (!loaded) {
            return;
        }

        // The readings start where the engine starts: the values this run is
        // about to be given, so an affinity left alone reads as itself rather
        // than as something the conversation never touched.
        setRelationships(seedRelationships(worldState));
        setMissingExpressions([]);
        setSnapshot(null);
        setRunning((previous) => ({ id: loaded.id, key: (previous?.key ?? 0) + 1 }));
    };

    const handleKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === 'Enter') {
            // Enter never reaches the button's pointer-down handler, so the sound
            // for the keyboard path is played here instead.
            void playSfx('click');
            void handleLoad();
        }
    };

    //region — Session readout
    const speakerDescription = node?.speaker_id
        ? `${node.speaker_id}${node.emotion ? `/${node.emotion}` : ''}`
        : t('dialogue.debug.none');

    // Who the dialogue has in the conversation, in the order they are standing.
    const castDescription = response
        ? response.cast_state.characters
            .map((character) => `${character.character_id}@${character.position}`)
            .join(', ') || t('dialogue.debug.none')
        : t('dialogue.debug.none');

    const choiceDescription = response
        ? response.available_choices
            .map((choice) => `${choice.choice_id} (${t(choice.enabled
                ? 'dialogue.debug.enabled'
                : 'dialogue.debug.locked')})`)
            .join(', ') || t('dialogue.debug.none')
        : t('dialogue.debug.none');

    const changeDescription = response
        ? response.state_changes
            .map((change) => `${change.target} ${change.delta !== undefined ? `${change.delta > 0 ? '+' : ''}${change.delta}` : String(change.next)}`)
            .join(', ') || t('dialogue.debug.none')
        : t('dialogue.debug.none');

    // Where every affinity stands, as the conversation has left it. One that
    // never moved reads as its value alone; one that did reads as it was, then
    // as it is.
    const relationshipDescription = Object.entries(relationships)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, reading]) => (
            reading.from === reading.to
                ? `${path}: ${reading.to}`
                : `${path}: ${reading.from} → ${reading.to}`
        ))
        .join(', ') || t('dialogue.debug.none');

    const warningDescription = response
        ? response.warnings
            .map((warning) => `${warning.code}${warning.path ? ` @ ${warning.path}` : ''}`)
            .join(', ') || t('dialogue.debug.none')
        : t('dialogue.debug.none');
    //endregion — Session readout

    //region — Render
    return (
        <div className="flex h-full min-h-0 flex-col gap-3">
            {loaded === null ? (
                /* Step one: the id, and nothing else. */
                <div
                    onKeyDown={handleKeyDown}
                    className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4"
                >
                    <div className="w-full max-w-md">
                        <CommonInput
                            title={t('playground.dialogue.inputTitle')}
                            value={dialogueId}
                            onChange={(value) => {
                                setDialogueId(value);
                                setError(null);
                            }}
                            placeholder={t('playground.dialogue.placeholder')}
                            maxCharacters={50}
                            showCounter
                        />
                    </div>

                    <CommonButton variant="primary" size="md" onPress={() => void handleLoad()}>
                        {t('playground.dialogue.load')}
                    </CommonButton>

                    {error && (
                        <p className="border-l-game border-galatime-error pl-3 text-sm text-galatime-error">
                            {error}
                        </p>
                    )}
                </div>
            ) : (
                /* Step two: the stage, with the values it gates on and what the
                   backend answered floating over its right edge. */
                <>
                    <header className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b-game border-white/10 pb-3">
                        <div className="min-w-0">
                            <p className="settings-label">{t('playground.dialogue.inputTitle')}</p>
                            <p className="truncate font-mono text-sm text-white">{loaded.id}</p>
                        </div>

                        <div className="flex shrink-0 items-center gap-3">
                            <CommonButton variant="ghost" size="sm" onPress={handleBack}>
                                {t('playground.dialogue.back')}
                            </CommonButton>
                            <CommonButton variant="primary" size="sm" onPress={handleStart}>
                                {t('playground.dialogue.start')}
                            </CommonButton>
                        </div>
                    </header>

                    {/*
                      The floor of the dialogue surface, and the only place the
                      minimum character height is enforced.

                      It belongs on the whole surface, not on the stage.
                      `DialogueView` clips its own overflow, so a floor on the stage
                      would not push the panel into a scroll — it would push the box
                      out of the bottom of the clip, and a half-drawn line is the one
                      thing that must never happen. Flooring the surface instead
                      makes the *panel* taller than its section, and the section
                      scrolls.

                      The number is derived rather than written down so that changing
                      `DIALOGUE_SPRITE_MIN_HEIGHT_PX` cannot leave a floor too small to
                      honour it: the stage is what the characters stand on, so the
                      floor has to move with the minimum.

                      The stage takes the whole width: its neighbours — the variables
                      and the session readout — float over it rather than standing
                      beside it, so nothing here has to be shared out.
                    */}
                    <div className="relative flex min-h-64 flex-1">
                        <section
                            className="flex min-w-0 flex-1 flex-col"
                            style={{
                                minHeight: `${DIALOGUE_SPRITE_MIN_HEIGHT_PX + DIALOGUE_BOX_HEIGHT_ALLOWANCE_PX}px`,
                            }}
                        >
                            <DialogueView
                                dialogueId={running?.id ?? null}
                                sessionKey={running?.key}
                                worldState={worldState}
                                onSessionChange={setSnapshot}
                                onExit={() => setRunning(null)}
                                // The end belongs to the Session readout: no box
                                // announces it, and the session stays completed
                                // until Escape, Start or Change dialogue leaves.
                                holdEndSession
                                className="min-h-0 flex-1"
                                stageClassName="min-h-0"
                                idleContent={(
                                    <div className="absolute inset-0 flex items-center justify-center px-6">
                                        <p className="text-center text-sm text-white/40">
                                            {t('playground.dialogue.idle')}
                                        </p>
                                    </div>
                                )}
                            />
                        </section>

                        {/*
                          Both readouts in one panel over the stage's right edge,
                          opened and closed from its own header — the dialogue's
                          answer to the combat log.
                        */}
                        <TestDialoguePopup
                            open={popupOpen}
                            onOpenChange={setPopupOpen}
                            tab={popupTab}
                            onTabChange={setPopupTab}
                            variableCount={loaded.requirements.length}
                            variables={(
                                <>
                                    {loaded.requirements.length === 0 ? (
                                        <p className="mt-3 text-xs text-white/40">
                                            {t('playground.dialogue.noVariables')}
                                        </p>
                                    ) : (
                                        <div className="mt-2">
                                            {loaded.requirements.map((requirement) => (
                                                <RequirementEditor
                                                    key={requirement.path}
                                                    requirement={requirement}
                                                    value={values[requirement.path] ?? ''}
                                                    onChange={(value) => setValues((previous) => ({
                                                        ...previous,
                                                        [requirement.path]: value,
                                                    }))}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                            session={(
                                <>
                                    {/*
                                      The end, reported where the bench reads it:
                                      the box no longer announces it, so this is
                                      the one place that says the conversation is
                                      over and which outcome it produced.
                                    */}
                                    {snapshot?.status === 'completed' && (
                                        <p className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-l-game border-galatime-accent bg-white/5 px-2 py-1.5 text-xs uppercase tracking-widest text-white">
                                            <span>{t('dialogue.result.title')}</span>
                                            <span className="text-galatime-accent">
                                                {t(resolveResultLabelKey(response?.result ?? null))}
                                            </span>
                                        </p>
                                    )}

                                    <dl className="flex flex-col gap-1 font-mono text-xs">
                                        <DebugRow label={t('dialogue.debug.node')} value={node ? `${node.id} (${node.type})` : t('dialogue.debug.none')} />
                                        <DebugRow label={t('dialogue.debug.waitingFor')} value={node?.next_action ?? t('dialogue.debug.none')} />
                                        <DebugRow label="auto_advance" value={String(node?.auto_advance ?? false)} />
                                        <DebugRow label="status" value={snapshot?.status ?? 'idle'} />
                                        <DebugRow label={t('dialogue.debug.speaker')} value={speakerDescription} />
                                        <DebugRow label={t('dialogue.debug.cast')} value={castDescription} />
                                        <DebugRow label={t('dialogue.debug.choices')} value={choiceDescription} />
                                        <DebugRow label={t('dialogue.debug.changes')} value={changeDescription} />
                                        <DebugRow label={t('dialogue.debug.relationships')} value={relationshipDescription} />
                                        <DebugRow label={t('dialogue.debug.warnings')} value={warningDescription} />
                                        {snapshot?.error && (
                                            <DebugRow label="error" value={`${snapshot.error.code}: ${snapshot.error.message}`} />
                                        )}
                                    </dl>

                                    {/*
                                      The expressions no sprite answered for, under
                                      the rows: red, because every line of this
                                      list is a face the stage could not draw.
                                    */}
                                    {missingExpressions.length > 0 && (
                                        <div className="mt-3 border-t-game border-white/10 pt-2">
                                            <p className="text-xs uppercase tracking-widest text-galatime-error">
                                                {t('playground.dialogue.missingExpressions')}
                                            </p>
                                            <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs text-galatime-error">
                                                {missingExpressions.map((expression) => (
                                                    <li key={expression} className="wrap-break-word">
                                                        {expression}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </>
                            )}
                        />
                    </div>
                </>
            )}
        </div>
    );
    //endregion — Render
}
