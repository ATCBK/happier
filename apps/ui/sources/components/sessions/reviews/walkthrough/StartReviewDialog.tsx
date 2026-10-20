import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { CustomModalChromeConfig, CustomModalInjectedProps } from '@/modal/types';
import type { ScmReviewComparisonSelector } from '@/sync/domains/scm/diffSummary/selection';
import {
    isReviewWalkthroughEngineAvailable,
    resolveReviewWalkthroughPlan,
    type ReviewWalkthroughEngine,
    type ReviewWalkthroughPlan,
} from '@/sync/domains/reviews/reviewWalkthroughPlan';
import { listReviewWalkthroughEngines, startReviewOfComparison, type ReviewOfComparisonStarted } from '@/sync/ops/reviews/reviewWalkthrough';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useReviewExecutionRunLaunchOptions } from '@/components/sessions/runs/launcher/useReviewExecutionRunLaunchOptions';
import { getSessionInputFailureLabelKey } from '@/components/sessions/pending/pendingMessageVisualState';
import { randomUUID } from '@/platform/randomUUID';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { findMachineAgentForBackendTarget } from '@/agents/machineAgents/machineAgentCatalog';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { resolveReviewEngineTarget } from '@/sync/domains/reviews/reviewEngineCatalog';
import { formatMachineAgentStatus } from '@/components/machines/agents/machineAgentCopy';
import { resolveMachineAgentStatus } from '@/components/machines/agents/machineAgentPresentation';

/**
 * Start review over the comparison on screen (Walkthrough lab WT5-R4, R4p, R7): the existing review
 * engines and instructions, the comparison in place of Change type and Base, and one more output,
 * Also write a walkthrough. A narrator is asked for only when several engines review or the one
 * reviewer writes no prose; the footer says, before anything starts, who reviews and who writes.
 */
export type StartReviewDialogViewProps = Readonly<{
    engines: readonly ReviewWalkthroughEngine[] | null;
    enginesError?: string | null;
    selectedEngineIds: readonly string[];
    onToggleEngine: (engineId: string) => void;
    scopeLabel: string;
    scopeDetail?: string | null;
    instructions: string;
    onChangeInstructions: (next: string) => void;
    walkthrough: boolean;
    onToggleWalkthrough: () => void;
    narratorEngineId: string | null;
    onSelectNarrator: (engineId: string) => void;
    plan: ReviewWalkthroughPlan;
    busy?: boolean;
    error?: string | null;
    onCancel: () => void;
    onStart: () => void;
    phone?: boolean;
    launchOptions?: React.ReactNode;
    /** The existing launch input, so an explicit Team choice cannot be labeled as an Account default. */
    launchInput?: Readonly<Record<string, unknown>>;
    walkthroughUnavailable?: boolean;
}>;

function EngineMark(props: Readonly<{ engineId: string; size: number }>) {
    const { theme } = useUnistyles();
    return hasAgentIconMark(props.engineId, theme)
        ? <AgentIcon agentId={props.engineId} size={props.size} />
        : <Icon name="shield-check" size={props.size} color={theme.colors.text.secondary} />;
}

function NarratorSelect(props: Readonly<{ plan: ReviewWalkthroughPlan; description: string; onSelect: (engineId: string) => void }>) {
    const [open, setOpen] = React.useState(false);
    const narrator = props.plan.narrator;
    const items = React.useMemo<DropdownMenuItem[]>(() => (narrator?.candidates ?? []).map((engine) => ({
        id: engine.engineId,
        title: engine.label,
        subtitle: engine.description ?? undefined,
        icon: <EngineMark engineId={engine.engineId} size={16} />,
        checked: engine.engineId === narrator?.engineId,
    })), [narrator]);
    const chosen = narrator?.candidates.find((engine) => engine.engineId === narrator.engineId) ?? null;
    return (
        <ListPresentationProvider value="page"><DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={narrator?.engineId ?? null}
            onSelect={props.onSelect}
            search={false}
            matchTriggerWidth
            placement="bottom"
            popoverPortalWebTarget="modal"
            itemTrigger={{
                title: t('reviewWalkthrough.dialog.narrator'),
                subtitle: props.description,
                showSelectedSubtitle: false,
                detailFormatter: () => chosen
                    ? (chosen.description ? `${chosen.label} · ${chosen.description}` : chosen.label)
                    : t('reviewWalkthrough.dialog.chooseNarrator'),
                itemProps: { testID: 'start-review-narrator', accessoryLayout: 'stacked', subtitleLines: 0, showDivider: false },
            }}
        /></ListPresentationProvider>
    );
}

export function StartReviewDialogView(props: StartReviewDialogViewProps) {
    const { theme } = useUnistyles();
    const phone = props.phone === true;
    const plan = props.plan;
    const footer = plan.footer?.kind === 'reviewer_then_narrator'
        ? t('reviewWalkthrough.dialog.footerHandover', { reviewer: plan.footer.reviewer, narrator: plan.footer.narrator })
        : plan.footer?.kind === 'review_then_walkthrough' ? t('reviewWalkthrough.dialog.footerReviewThenWalkthrough') : null;
    const narratorWhy = plan.narrator?.reason === 'findings_only'
        ? t('reviewWalkthrough.dialog.narratorFindingsOnly', { engine: plan.selected[0]?.label ?? '' })
        : t('reviewWalkthrough.dialog.narratorSeveral', { count: plan.selected.length });
    const engines = props.engines;
    // A phone sheet keeps fewer rows in view so the walkthrough choice stays above the footer (WT5-R4p).
    const rowsInView = phone ? ENGINE_ROWS_IN_VIEW_PHONE : ENGINE_ROWS_IN_VIEW;
    return (
        <View testID="start-review-dialog" style={[styles.dialog, phone ? styles.dialogPhone : null]}>
            <View style={styles.head}>
                <Text accessibilityRole="header" style={styles.title}>{t('scmComparison.startReview')}</Text>
                <IconButton testID="start-review-close" variant="plain" iconName="x" iconSize={ICON_SIZE.md} accessibilityLabel={t('common.close')} onPress={props.onCancel} />
            </View>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                <View style={styles.field}>
                    <View style={styles.labelRow}>
                        <Text style={styles.label}>{t('reviewWalkthrough.dialog.engines')}</Text>
                        {engines && engines.length > 0 ? <Text style={styles.labelHint}>{t('reviewWalkthrough.dialog.selected', { count: plan.selected.length })}</Text> : null}
                    </View>
                    {engines === null ? (
                        props.enginesError
                            ? <SurfaceStateCard size="line" kind="error" title={props.enginesError} />
                            : <SurfaceStateCard size="line" kind="loading" title={t('reviewWalkthrough.dialog.loadingEngines')} />
                    ) : engines.length === 0 ? (
                        <SurfaceStateCard size="line" kind="empty" title={t('reviewWalkthrough.dialog.noEngines')} />
                    ) : (
                        // A long host inventory scrolls inside its own frame, so Changes, Instructions and the
                        // walkthrough choice stay in view (WT5-R4); the half row at the edge says there is more.
                        <ScrollView
                            testID="start-review-engines"
                            style={[styles.group, engines.length > rowsInView ? { maxHeight: ENGINE_ROW_HEIGHT * (rowsInView + 0.5) } : null]}
                            nestedScrollEnabled
                            keyboardShouldPersistTaps="handled"
                        >
                            {engines.map((engine, index) => {
                                const available = isReviewWalkthroughEngineAvailable(engine);
                                const checked = available && props.selectedEngineIds.includes(engine.engineId);
                                const launchModelId = checked && props.launchInput?.teamCredentialModel !== undefined ? null : engine.launchModelId;
                                const availability = !available && engine.machineAgent !== undefined
                                    ? (engine.enabled ? formatMachineAgentStatus(resolveMachineAgentStatus(engine.machineAgent)) : t('common.unavailable')) : null;
                                const reconnect = engine.machineAgent?.state === 'needsSignIn'
                                    && engine.machineAgent.signIn.connectedServices.some(service => service.connected && !service.healthy)
                                    ? t('connectedServices.detail.actions.reconnect') : null;
                                const subtitle = availability
                                    ? [availability, reconnect].filter(Boolean).join(' · ')
                                    : [launchModelId, engine.structuredNarration ? null : t('reviewWalkthrough.dialog.findingsOnly')].filter(Boolean).join(' · ');
                                return (
                                    <HappierPressable
                                        key={engine.engineId}
                                        testID={`start-review-engine-${engine.engineId}`}
                                        accessibilityRole="checkbox"
                                        checked={checked}
                                        disabled={!available}
                                        accessibilityLabel={subtitle ? `${engine.label}, ${subtitle}` : engine.label}
                                        onPress={() => props.onToggleEngine(engine.engineId)}
                                        style={(state) => [
                                            styles.engine,
                                            index > 0 ? styles.engineDivided : null,
                                            state.pressed ? styles.pressed : null,
                                            !available ? styles.disabled : null,
                                            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                                        ]}
                                    >
                                        <SelectionCheckGlyph state={checked ? 'checked' : 'unchecked'} />
                                        <View style={styles.engineMark}><EngineMark engineId={engine.engineId} size={18} /></View>
                                        <View style={styles.engineText}>
                                            <Text style={styles.engineTitle}>{engine.label}</Text>
                                            {subtitle ? <Text style={styles.engineSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
                                        </View>
                                    </HappierPressable>
                                );
                            })}
                        </ScrollView>
                    )}
                </View>
                <View style={styles.field}>
                    <Text style={styles.label}>{t('reviewWalkthrough.dialog.changes')}</Text>
                    <View testID="start-review-changes" style={[styles.changes, phone ? styles.changesPhone : null]}>
                        <Icon name="git-diff" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                        <Text style={styles.changesScope}>{props.scopeLabel}</Text>
                        {props.scopeDetail ? <Text style={styles.changesDetail}>{props.scopeDetail}</Text> : null}
                    </View>
                </View>
                <View style={styles.field}>
                    <Text style={styles.label}>{t('reviewWalkthrough.dialog.instructions')}</Text>
                    <FieldTextInput
                        testID="start-review-instructions"
                        value={props.instructions}
                        onChangeText={props.onChangeInstructions}
                        accessibilityLabel={t('reviewWalkthrough.dialog.instructions')}
                        placeholder={t('reviewWalkthrough.dialog.instructionsPlaceholder')}
                        multiline
                        minLines={2}
                    />
                </View>
                <View style={[styles.also, props.walkthrough ? styles.alsoOn : null]}>
                    <HappierPressable
                        testID="start-review-walkthrough"
                        accessibilityRole="checkbox"
                        checked={props.walkthrough}
                        disabled={props.walkthroughUnavailable}
                        accessibilityLabel={t('reviewWalkthrough.dialog.alsoWalkthrough')}
                        accessibilityHint={props.walkthroughUnavailable ? t('common.unavailable') : t('reviewWalkthrough.dialog.alsoWalkthroughBody')}
                        onPress={props.onToggleWalkthrough}
                        style={(state) => [styles.alsoRow, state.pressed ? styles.pressed : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <SelectionCheckGlyph state={props.walkthrough ? 'checked' : 'unchecked'} />
                        <View style={styles.alsoText}>
                            <Text style={styles.alsoTitle}>{t('reviewWalkthrough.dialog.alsoWalkthrough')}</Text>
                            <Text style={styles.alsoBody}>{props.walkthroughUnavailable ? t('common.unavailable') : t('reviewWalkthrough.dialog.alsoWalkthroughBody')}</Text>
                        </View>
                    </HappierPressable>
                    {props.walkthrough && plan.narrator ? (
                        <View testID="start-review-narrator-row" style={styles.narrator}>
                            {plan.narrator.candidates.length > 0 ? (
                                <NarratorSelect plan={plan} description={narratorWhy} onSelect={props.onSelectNarrator} />
                            ) : <View style={styles.narratorText}>
                                <Text style={styles.alsoTitle}>{t('reviewWalkthrough.dialog.narrator')}</Text>
                                <Text style={styles.alsoBody}>{t('reviewWalkthrough.dialog.noNarrator')}</Text>
                            </View>}
                        </View>
                    ) : null}
                </View>
                {props.launchOptions}
                {props.error ? <Text testID="start-review-error" accessibilityRole="alert" style={styles.error}>{props.error}</Text> : null}
            </ScrollView>
            <View style={[styles.foot, phone ? styles.footPhone : null]}>
                <Text testID="start-review-footer" style={styles.footNote}>{footer ?? ''}</Text>
                {/* One primary action; Cancel is the tertiary way out, words beside it rather than a second fill. */}
                <RoundButtonSizeScope size="normal" presentation="uniform"><View style={styles.footActions}>
                    {/* The link is a sentence-ending control (it aligns to its own start); centre it on the primary's line. */}
                    <View style={styles.footCancel}><TextLinkButton testID="start-review-cancel" tone="quiet" label={t('common.cancel')} onPress={props.onCancel} /></View>
                    <RoundButton
                        testID="start-review-start"
                        title={t('scmComparison.startReview')}
                        disabled={!plan.canStart || props.busy === true}
                        loading={props.busy}
                        onPress={props.onStart}
                    />
                </View></RoundButtonSizeScope>
            </View>
        </View>
    );
}

export type StartReviewDialogInput = Readonly<{
    serverId: string | null;
    cwd: string;
    comparison: ScmReviewComparisonSelector;
    comparisonId?: string | null;
    scopeLabel: string;
    scopeDetail?: string | null;
    /** On from Files and Walkthrough; other entrances keep the findings-only default. */
    defaultWalkthrough: boolean;
    /** Engines to start with selected (Retry one engine of a partial review). */
    preselectedEngineIds?: readonly string[];
    onStarted: (started: ReviewOfComparisonStarted, walkthrough: boolean) => void;
}> & (Readonly<{ sessionId: string; machineId?: never }> | Readonly<{ sessionId?: never; machineId: string }>);

export type StartReviewDialogProps = CustomModalInjectedProps & StartReviewDialogInput;

/** The bound dialog: engines from the host inventory, and a start through `review.start`. */
export function StartReviewDialog(props: StartReviewDialogProps) {
    const deviceType = useDeviceType();
    const [operationId] = React.useState(randomUUID);
    const [listedEngines, setEngines] = React.useState<readonly ReviewWalkthroughEngine[] | null>(null);
    const [enginesError, setEnginesError] = React.useState<string | null>(null);
    const [selected, setSelected] = React.useState<readonly string[] | null>(props.preselectedEngineIds ?? null);
    const [instructions, setInstructions] = React.useState('');
    const [walkthrough, setWalkthrough] = React.useState(Boolean(props.defaultWalkthrough));
    const [narratorEngineId, setNarratorEngineId] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const sessionMachine = useSessionMachineTarget(props.sessionId ?? null, props.serverId);
    const machineInventory = useMachineAgents({ serverId: props.serverId, machineId: props.machineId ?? sessionMachine?.machineId });
    const engines = React.useMemo(() => listedEngines?.map(engine => ({ ...engine,
        machineAgent: findMachineAgentForBackendTarget(machineInventory.agents, resolveReviewEngineTarget(engine.engineId)),
    })) ?? null, [listedEngines, machineInventory.agents]);

    React.useEffect(() => {
        let current = true;
        void listReviewWalkthroughEngines({ sessionId: props.sessionId ?? null, machineId: props.machineId, serverId: props.serverId }).then((listed) => {
            if (!current) return;
            if (!listed.ok) { setEnginesError(listed.error); return; }
            setEngines(listed.engines);
        });
        return () => { current = false; };
    }, [props.serverId, props.sessionId, props.machineId]);

    // Until the person chooses, the first engine that can review is selected (the launcher's own default).
    const selectedEngineIds = React.useMemo(() => selected
        ?? (engines?.find(isReviewWalkthroughEngineAvailable) ? [engines.find(isReviewWalkthroughEngineAvailable)!.engineId] : []), [engines, selected]);
    const plan = React.useMemo(() => resolveReviewWalkthroughPlan({
        engines: engines ?? [], selectedEngineIds, walkthrough, narratorEngineId,
    }), [engines, narratorEngineId, selectedEngineIds, walkthrough]);
    const launchOptions = useReviewExecutionRunLaunchOptions({ sessionId: props.sessionId ?? null, machineId: props.machineId, cwd: props.cwd, serverId: props.serverId,
        engineIds: plan.selected.map((engine) => engine.engineId), busy });
    const { launcher, ready: launchReady } = launchOptions;
    const toggleEngine = React.useCallback((engineId: string) => {
        setSelected((current) => {
            const base = current ?? selectedEngineIds;
            return base.includes(engineId) ? base.filter((id) => id !== engineId) : [...base, engineId];
        });
    }, [selectedEngineIds]);

    const { onClose, onStarted } = props;
    const cancel = React.useCallback(() => {
        launcher.cancelStart();
        onClose();
    }, [launcher.cancelStart, onClose]);
    const start = React.useCallback(async () => {
        if (!plan.canStart || !launchReady || busy) return;
        setBusy(true);
        setError(null);
        const started = await startReviewOfComparison({
            sessionId: props.sessionId ?? null,
            machineId: props.machineId,
            serverId: props.serverId,
            cwd: props.cwd,
            comparison: props.comparison,
            comparisonId: props.comparisonId ?? null,
            plan,
            instructions: instructions.trim() || t('reviewWalkthrough.dialog.defaultInstructions'),
            launchInput: launchOptions.input,
            start: (input) => launcher.startAction('review.start', input, operationId),
        }).catch((cause: unknown) => {
            const label = getSessionInputFailureLabelKey(cause);
            return { ok: false as const, error: label ? t(label) : cause instanceof Error ? cause.message : t('common.requestFailed') };
        });
        if (!launcher.isStartCurrent()) return;
        setBusy(false);
        if (!started.ok) { setError(started.error); return; }
        onClose();
        onStarted(started, plan.walkthrough);
    }, [busy, launchReady, instructions, launchOptions.input, launcher.startAction, launcher.isStartCurrent, operationId, onClose, onStarted, plan, props.comparison, props.comparisonId, props.cwd, props.serverId, props.sessionId, props.machineId]);

    return (
        <StartReviewDialogView
            engines={engines}
            enginesError={enginesError}
            selectedEngineIds={selectedEngineIds}
            onToggleEngine={toggleEngine}
            scopeLabel={props.scopeLabel}
            scopeDetail={props.scopeDetail}
            instructions={instructions}
            onChangeInstructions={setInstructions}
            walkthrough={walkthrough}
            walkthroughUnavailable={false}
            onToggleWalkthrough={() => setWalkthrough((on) => !on)}
            narratorEngineId={narratorEngineId}
            onSelectNarrator={setNarratorEngineId}
            plan={launchReady ? plan : { ...plan, canStart: false }}
            busy={busy}
            error={error}
            onCancel={cancel}
            onStart={() => { void start(); }}
            phone={deviceType === 'phone'}
            launchOptions={launchOptions.controls}
            launchInput={launchOptions.input}
        />
    );
}

/** The dialog's modal chrome: a card on wide screens, a sheet on a phone. One owner, also drawn by the dev specimen. */
export function startReviewDialogChrome(): CustomModalChromeConfig {
    return {
        kind: 'card',
        header: 'none',
        title: t('scmComparison.startReview'),
        // The card hugs the form up to the viewport bound and scrolls its own body above the pinned
        // footer; the engine list keeps its own bounded frame (WT5-R4).
        scrollHost: 'bounded',
        bodyScroll: 'none',
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.86 },
        phonePresentation: 'sheet',
        testID: 'start-review-modal',
    };
}

export function presentStartReviewDialog(props: StartReviewDialogInput): string {
    return Modal.show({
        component: StartReviewDialog,
        props,
        closeOnBackdrop: true,
        chrome: startReviewDialogChrome(),
    });
}

/** Engine rows: one line of name, one of model or capability (WT5-R4). */
const ENGINE_ROW_HEIGHT = 48;
const ENGINE_ROWS_IN_VIEW = 5;
const ENGINE_ROWS_IN_VIEW_PHONE = 3;

const styles = StyleSheet.create((theme) => ({
    dialog: { maxHeight: '100%', flexShrink: 1, minHeight: 0 },
    dialogPhone: {},
    head: { flexDirection: 'row', alignItems: 'center', paddingLeft: theme.space.s20, paddingRight: 14, paddingTop: theme.space.s16, paddingBottom: theme.space.s12 },
    title: { flex: 1, ...Typography.variant('heading'), color: theme.colors.text.primary },
    scroll: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
    body: { paddingHorizontal: theme.space.s20, paddingBottom: theme.space.s16, gap: 18 },
    field: { gap: theme.space.s8 },
    labelRow: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s8 },
    label: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.secondary,  },
    labelHint: { ...Typography.variant('label', 'regular'), color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
    group: { flexGrow: 0, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.default, overflow: 'hidden' },
    engine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s12, minHeight: ENGINE_ROW_HEIGHT, paddingHorizontal: 14, paddingVertical: theme.space.s6 },
    engineDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    engineMark: { width: 20, alignItems: 'center' },
    engineText: { flex: 1, minWidth: 0 },
    engineTitle: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary },
    engineSubtitle: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
    pressed: { backgroundColor: theme.colors.surface.pressed },
    disabled: { opacity: 0.45 },
    changes: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        columnGap: theme.space.s8,
        rowGap: theme.space.s2,
        minHeight: 44,
        paddingHorizontal: 14,
        paddingVertical: theme.space.s8,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
    },
    changesPhone: { alignItems: 'flex-start' },
    changesScope: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary },
    changesDetail: { flexShrink: 1, ...Typography.variant('label', 'regular'), color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
    also: { borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border.default, overflow: 'hidden' },
    alsoOn: { borderColor: theme.colors.state.active.border, backgroundColor: theme.colors.surface.sectionTint, borderWidth: 1.5 },
    alsoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s12, paddingHorizontal: 14, paddingVertical: 14 },
    alsoText: { flex: 1, minWidth: 0, gap: 3 },
    alsoTitle: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary },
    alsoBody: { ...Typography.variant('label', 'regular'), color: theme.colors.text.secondary },
    narrator: {
        flexDirection: 'column',
        alignItems: 'stretch',
        // The narrator is a list row with its own horizontal padding: the offsets leave its title on the
        // walkthrough title's edge and its field on the card's inner edge.
        marginLeft: 46 - HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
        marginRight: 14 - HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
        gap: theme.space.s12,
        paddingVertical: 14,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    narratorText: { minWidth: 0, gap: 3 },
    error: { ...Typography.variant('body'), color: theme.colors.state.danger.foreground,  },
    foot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s20,
        paddingVertical: 14,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    footPhone: { paddingBottom: 18 },
    footNote: { flex: 1, minWidth: 0, ...Typography.variant('meta'), color: theme.colors.text.tertiary },
    footActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s16 },
    footCancel: { alignSelf: 'center' },
}));
