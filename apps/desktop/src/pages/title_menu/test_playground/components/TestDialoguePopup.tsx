import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import CommonButton from '../../../../components/common/CommonButton';
import { CloseIcon } from '../../../../assets/GalatimeIcon';

/** The two panels the popup can show, in the order their tabs are laid out. */
const TABS = ['variables', 'session'] as const;

export type TestDialoguePopupTab = (typeof TABS)[number];

interface TestDialoguePopupProps {
    /** Whether the panel is on screen; the X in its header takes it down. */
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The tab being read. */
    tab: TestDialoguePopupTab;
    onTabChange: (tab: TestDialoguePopupTab) => void;
    /** The editors of the values the dialogue branches on. */
    variables: ReactNode;
    /** How many of them there are, so the closed trigger can say so. */
    variableCount: number;
    /** The session readout rows. */
    session: ReactNode;
}

/**
 * The dialogue bench's readouts — the variables it branches on and what the
 * backend answered — as one panel floating over the stage.
 *
 * Same contract as `TestCombatLog`: it floats on the stage's right edge instead
 * of taking a column from it, and it opens and closes from its own header. Both
 * halves live in one popup behind two tabs, because they are two views of the
 * same conversation rather than two things to have on screen at once.
 *
 * The state is the panel's, not this component's: the panel mounts it open on
 * **Variables** (what has to be set before Start) and switches it to Session
 * the moment the conversation ends, because Session is where the bench reports
 * the end. This component only draws whichever of the two it is told.
 */
export function TestDialoguePopup({
    open,
    onOpenChange,
    tab,
    onTabChange,
    variables,
    variableCount,
    session,
}: TestDialoguePopupProps) {
    const { t } = useTranslation(['playground', 'dialogue']);

    const labelOf = (id: TestDialoguePopupTab) =>
        id === 'variables' ? t('playground.dialogue.variables') : t('dialogue.debug.title');

    const openOn = (id: TestDialoguePopupTab) => {
        onTabChange(id);
        onOpenChange(true);
    };

    if (!open) {
        return (
            <div className="pointer-events-none absolute bottom-2 right-2 z-30 flex flex-col items-end gap-2">
                <CommonButton
                    variant="outline"
                    size="sm"
                    className="pointer-events-auto"
                    onPress={() => openOn('variables')}
                >
                    {t('playground.dialogue.variables')}
                    {variableCount > 0 && (
                        <span className="text-xs tabular-nums opacity-60">{variableCount}</span>
                    )}
                </CommonButton>

                <CommonButton
                    variant="outline"
                    size="sm"
                    className="pointer-events-auto"
                    onPress={() => openOn('session')}
                >
                    {t('dialogue.debug.title')}
                </CommonButton>
            </div>
        );
    }

    return (
        <div className="pointer-events-none absolute inset-y-2 right-2 z-30 flex flex-col items-end">
            <section
                aria-label={t('playground.dialogue.panelTitle')}
                className="pointer-events-auto flex min-h-0 w-[22rem] max-w-[calc(100%_-_1rem)] flex-1 flex-col border-game border-white/70 bg-galatime-dark/95 shadow-[0_0_24px_rgba(0,0,0,0.65)] backdrop-blur-sm"
            >
                <header className="flex shrink-0 items-center gap-1 border-b-game border-white/15 px-2 py-1.5">
                    <div className="mr-auto flex items-center gap-1">
                        {TABS.map((id) => {
                            const isActive = tab === id;

                            // Same tab look as the sidebar: white fill + dark text
                            // when active, ghost's own white-fill hover when not.
                            return (
                                <CommonButton
                                    key={id}
                                    variant="ghost"
                                    size="sm"
                                    aria-pressed={isActive}
                                    onPress={() => onTabChange(id)}
                                    className={`border-0 px-2 py-1 tracking-[0.12em] ${isActive
                                        ? 'bg-white font-semibold text-galatime-dark'
                                        : 'opacity-60 hover:opacity-100'
                                        }`}
                                >
                                    {labelOf(id)}
                                </CommonButton>
                            );
                        })}
                    </div>

                    <CommonButton
                        variant="ghost"
                        size="sm"
                        icon={<CloseIcon className="h-5 w-5" />}
                        className="p-1 opacity-60 hover:opacity-100"
                        aria-label={t('playground.dialogue.panelClose')}
                        onPress={() => onOpenChange(false)}
                    />
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
                    {tab === 'variables' ? variables : session}
                </div>
            </section>
        </div>
    );
}

export default TestDialoguePopup;
