import * as React from 'react';
import { View } from 'react-native';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { isScmCommitPlanApplicationLocked } from '@happier-dev/protocol/scm/diffSummaryCommitPlan';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveExecutionRunAgentMarkId } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { getPreferredLanguage, t } from '@/text';
import { RunWorkNotifications } from '@/components/sessions/work/RunWorkNotifications';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { resolveScmDiffSummaryDiscussionTarget } from '@/sync/domains/scm/diffSummary/discussion';
import { writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { ScmDiffSummaryModelPicker } from '@/components/settings/sourceControl/ScmDiffSummaryModelPicker';
import { ScmDiffSummaryStartOptions, scmDiffSummaryPrerequisiteOf, scmDiffSummaryStartOptionsOf, useOpenExplainChangesSetting, useSummaryModelChoice } from '@/components/sessions/files/comparison/ScmDiffSummaryStartOptions';
import { applySavedScmDiffSummaryResult } from '@/sync/ops/scmDiffSummary/generate';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import type { useScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useScmDiffSummaryBinding';
import { WalkthroughView, type WalkthroughViewLayout } from './WalkthroughView';
import { buildWalkthroughReading, EMPTY_WALKTHROUGH_READING, type WalkthroughStop } from './walkthroughReading';
import { useWalkthroughReviewedMarks } from './useWalkthroughReviewedMarks';
import { useWalkthroughSavedActions } from './WalkthroughSavedActions';
import type { ScmComparisonMenuSection } from '@/components/sessions/files/comparison/ScmComparisonMoreMenu';
import { useWalkthroughReview } from '@/components/sessions/reviews/walkthrough/useWalkthroughReview';
import { ReviewExplainFindingsButton, useSessionWalkthroughReviewPresentation } from '@/components/sessions/reviews/walkthrough/SessionWalkthroughReview';
import { ReviewWalkthroughSteps } from '@/components/sessions/reviews/walkthrough/ReviewWalkthroughParts';
import { requestExplainReviewFindings } from '@/sync/ops/reviews/reviewWalkthrough';

export type ScmWalkthroughViewProps = Readonly<{
    sessionId?: string;
    bound: ReturnType<typeof useScmDiffSummaryBinding>;
    displayMachineId: string | null;
    onAskStop?: (stop: WalkthroughStop) => void;
    serverId?: string | null;
    comparison: SessionScmReviewComparison | null;
    scopeLabel: string;
    scopeDetail?: string | null;
    layout: WalkthroughViewLayout;
    active?: boolean;
    /** The comparison bar, drawn by the review destination above every view, with this view's own actions and menu rows. */
    renderBar: (actions: React.ReactNode, sections?: readonly ScmComparisonMenuSection[], review?: React.ReactNode) => React.ReactNode;
    onShowFiles: () => void;
    onOpenFile: (path: string) => void;
    /** Hands the person to the Session composer, whose recipient now names the generator. */
    onOpenComposer?: () => void;
    /** Reviewer Runs a Start review from this comparison launched, before the saved result names them. */
    startedReviewRunIds?: readonly string[] | null;
    /** Start review again with these engines selected (a partial review's failed reviewer). */
    onRetryReviewEngines?: (engineIds: readonly string[]) => void;
}>;

/**
 * The Walkthrough view bound to an admitted host: the comparison's walkthrough analysis from the one diff-summary
 * store, the person's marks from Account KV, and Discuss through the generating run's real affordances.
 */
export const ScmWalkthroughView = React.memo(function ScmWalkthroughView(props: ScmWalkthroughViewProps) {
    // The comparison's saved result, restore/reread and START: the one binding Walkthrough and Commits share.
    const bound = props.bound;
    const { scope, machine, machineReachability, canControl, canSend, launch, viewModel, capturedComparison, cwd, operations,
        error, setError, model, setModel, modelChoices, modelAvailable, starting } = bound;
    const modelChoice = useSummaryModelChoice(modelChoices);
    const displayHomeId = scope?.serverId ?? props.serverId;
    // Subscribe to attribution, not heartbeat objects. Exact Home lookup and
    // machine naming stay at their existing owners while the machine is offline.
    const machineName = getStorage()(state => getMachineSentenceName(
        resolveServerScopedMachine(state, displayHomeId, props.displayMachineId ?? '') ?? { absence: 'unlisted' },
    ));
    const observedAtMs = viewModel?.observedAtMs ?? null;
    const offline = capturedComparison && machineReachability === 'unreachable' ? {
        machine: machineName,
        time: observedAtMs === null ? t('common.unavailable')
            : formatWithCachedDateTimeFormatter(observedAtMs, getPreferredLanguage(), { dateStyle: 'medium', timeStyle: 'short' }),
    } : null;
    const boundStart = bound.onStart;
    const onStart = React.useCallback(() => boundStart(), [boundStart]);
    const openExplainSetting = useOpenExplainChangesSetting();
    const key = viewModel?.requestKey;
    const runId = viewModel?.executionRunId ?? null;
    const marks = useWalkthroughReviewedMarks({ comparison: capturedComparison, serverId: props.serverId ?? null, host: bound.host });
    const reading = React.useMemo(() => (capturedComparison
        ? buildWalkthroughReading({
            comparison: capturedComparison,
            walkthrough: viewModel?.outputs?.walkthrough ?? null,
            analysis: viewModel?.analysis ?? null,
            reviewed: marks.record?.comparisonId === capturedComparison.id ? marks.record : null,
            provenance: viewModel?.savedResult?.walkthroughProvenance,
        })
        : null), [capturedComparison, marks.record, viewModel?.analysis, viewModel?.outputs?.walkthrough, viewModel?.savedResult?.walkthroughProvenance]);

    const discussion = React.useMemo(() => (props.sessionId
        ? resolveScmDiffSummaryDiscussionTarget({
            sessionId: props.sessionId,
            serverId: props.serverId,
            runId,
            run: viewModel?.latestRun,
            source: 'session_rpc',
            canControlExecutionRuns: canSend,
        })
        : null), [canSend, props.serverId, props.sessionId, runId, viewModel?.latestRun]);
    const onOpenComposer = props.onOpenComposer;
    const sessionId = props.sessionId;
    const onAsk = React.useMemo(() => {
        if (!sessionId || !onOpenComposer || discussion?.kind !== 'continue' || !scope || !cwd || !viewModel?.savedResult) return props.onAskStop;
        const recipient = discussion.recipient;
        const saved = viewModel.savedResult;
        return (stop: WalkthroughStop) => {
            if (!bound.isCurrent()) return;
            writeExistingSessionDraft({ scope, sessionId, patch: { routing: { recipient: StrictJsonValueSchema.parse({ mode: 'scm_diff_summary', recipient,
                target: { cwd, resultId: saved.resultId, expectedRevision: saved.revision, stopIds: [stop.id] } }) } } });
            onOpenComposer();
        };
    }, [bound.isCurrent, cwd, discussion, onOpenComposer, props.sessionId, props.onAskStop, scope?.serverId, scope?.accountId, viewModel?.savedResult]);
    const saved = viewModel?.savedResult;
    const nativeTurns = !sessionId ? viewModel?.latestRun?.inputTurns : null;
    const nativeTerminalTurn = nativeTurns?.current?.state === 'completed' ? nativeTurns.current
        : nativeTurns?.last?.state === 'completed' ? nativeTurns.last : null;
    const nativeDiscussionReply = nativeTerminalTurn?.result?.kind === 'text' ? nativeTerminalTurn.result.value : null;
    const [undoing, setUndoing] = React.useState(false);
    const undoPending = React.useRef(false);
    const onUndo = React.useMemo(() => saved?.canUndo && operations && cwd && key && canControl
        && !isScmCommitPlanApplicationLocked(saved.application) && !undoing ? () => {
            if (!bound.isCurrent() || undoPending.current) return;
            undoPending.current = true;
            setUndoing(true);
            void operations.undo({ cwd, resultId: saved.resultId, expectedRevision: saved.revision }).then((response) => {
                if (!bound.isCurrent()) return;
                if (response.success) applySavedScmDiffSummaryResult(key, response.result);
                else setError(response.error);
            }).finally(() => { undoPending.current = false; setUndoing(false); });
        } : undefined, [bound.isCurrent, canControl, cwd, key, operations, saved, setError, undoing]);
    const onStartNew = React.useMemo(() => sessionId && onOpenComposer && saved?.generator && cwd && scope && canSend && launch.canLaunchExecutionRuns ? () => {
        if (!bound.isCurrent()) return;
        writeExistingSessionDraft({ scope, sessionId, patch: { routing: { recipient: StrictJsonValueSchema.parse({ mode: 'scm_diff_summary', recipient: null,
            target: { cwd, resultId: saved.resultId, expectedRevision: saved.revision, startNew: true } }) } } });
        onOpenComposer();
    } : undefined, [saved, cwd, bound.isCurrent, scope?.serverId, scope?.accountId, canSend, launch.canLaunchExecutionRuns, props.sessionId, onOpenComposer]);
    const onAskSession = React.useCallback(() => {
        if (!sessionId || !onOpenComposer || !scope || !bound.isCurrent()) return;
        writeExistingSessionDraft({ scope, sessionId, patch: { routing: { recipient: StrictJsonValueSchema.parse({ mode: 'manual', recipient: null }) } } });
        onOpenComposer();
    }, [bound.isCurrent, scope?.serverId, scope?.accountId, props.sessionId, onOpenComposer]);

    // The generator's own transcript is the existing run destination, never the human discussion thread.
    const router = useRouter();
    const conversationHref = discussion?.kind === 'continue' ? discussion.href : null;
    const phone = props.layout === 'phone';
    // A phone lists it as a named row of the comparison menu; the wide bar keeps the quiet icon.
    const conversationAction = conversationHref && !phone ? (
        <IconButton
            testID="walkthrough-open-conversation"
            variant="plain"
            iconName="chat-circle-dots"
            tooltip={t('walkthrough.openConversation')}
            accessibilityLabel={t('walkthrough.openConversation')}
            onPress={() => router.push(conversationHref as never)}
        />
    ) : null;

    const askStopById = React.useMemo(() => (onAsk && reading
        ? (stopId: string) => { const stop = reading.stops.find((item) => item.id === stopId); if (stop) onAsk(stop); }
        : null), [onAsk, reading]);
    const review = useWalkthroughReview({
        host: bound.host,
        cwd: cwd ?? '',
        scope,
        comparison: capturedComparison,
        walkthrough: viewModel?.outputs?.walkthrough ?? null,
        producer: viewModel?.producer,
        startedReviewRunIds: props.startedReviewRunIds,
    });
    const [explaining, setExplaining] = React.useState(false);
    const reviewView = useSessionWalkthroughReviewPresentation({
        review,
        phase: reading?.phase ?? 'none',
        phone: props.layout === 'phone',
        onAskStop: askStopById,
        scope,
        sessionId: sessionId ?? '',
        onRetryReviewEngines: props.onRetryReviewEngines,
        modelId: viewModel?.producer?.modelId ?? null,
    });
    const savedForExplain = viewModel?.savedResult ?? null;
    const explainTargets = review?.overlay.stops.size ? [...review.overlay.stops.values()].flatMap((stop) => stop.cards) : [];
    const onExplain = React.useMemo(() => (review && savedForExplain && cwd && canSend && explainTargets.length > 0 && reading?.phase === 'complete'
        ? async () => {
            if (!bound.isCurrent()) return;
            setExplaining(true);
            const done = await requestExplainReviewFindings({
                ...(bound.host.sessionId ? { sessionId: bound.host.sessionId } : { sessionId: null, machineId: bound.host.machineId! }),
                serverId: scope?.serverId ?? props.serverId ?? null, accountId: scope?.accountId, cwd,
                runId: viewModel?.producer?.runId ?? review.reviewRunIds[0]!, reviewRunIds: review.reviewRunIds,
                resultId: savedForExplain.resultId, expectedRevision: savedForExplain.revision,
                findingIds: explainTargets.map((view) => ({ runId: view.runId, findingId: view.findingId })),
            }).catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : t('common.requestFailed') }));
            if (!bound.isCurrent()) return;
            setExplaining(false);
            if (!done.ok) setError(done.error);
        }
        : null), [bound.isCurrent, bound.host.sessionId, bound.host.machineId, canSend, cwd, explainTargets, props.serverId, scope, reading?.phase, review, savedForExplain, setError, viewModel?.producer?.runId]);
    // A walkthrough the review wrote already reads with its findings (lab WT5-R6): Explain is offered only over a
    // walkthrough written before or apart from the review (WT5-R2).
    const explainOffered = onExplain && viewModel?.producer?.kind !== 'review';
    const explainAction = review && (explainOffered || explaining)
        ? <ReviewExplainFindingsButton running={explaining} onPress={() => { if (onExplain) void onExplain(); }} /> : null;
    const reviewStatus = review ? <ReviewWalkthroughSteps progress={review.progress} phone={phone} /> : null;

    const { theme } = useUnistyles();
    const markAgentId = resolveExecutionRunAgentMarkId(viewModel?.latestRun?.backendTarget, theme);
    const marksAvailable = marks.record?.comparisonId === capturedComparison?.id && marks.record !== null && marks.unavailableReason === null;
    const setReviewed = marks.setReviewed;
    const onToggleReviewed = React.useMemo(() => (marksAvailable
        ? (stop: WalkthroughStop) => setReviewed(stop.changeRefs, !stop.reviewed)
        : undefined), [marksAvailable, setReviewed]);

    // The saved result's operations are rows of the comparison menu; what they open renders under the header.
    const savedActions = useWalkthroughSavedActions(saved && cwd && key && operations ? {
        result: saved, cwd, operations,
        nativeDiscussion: !sessionId,
        nativeDiscussionReply,
        onUndo, undoing,
        undoInNotice: Boolean(saved.updateNotice && onUndo),
        phone: props.layout === 'phone',
        canGenerate: canSend && launch.canLaunchExecutionRuns,
        disabledReason: !canControl ? t('walkthroughStart.unavailable') : null,
        onResult: (result) => { if (bound.isCurrent()) applySavedScmDiffSummaryResult(key, result); },
        onError: (failure) => { if (bound.isCurrent()) setError(failure.error); },
    } : null);
    const conversationSection = React.useMemo<ScmComparisonMenuSection | null>(() => (conversationHref && phone ? {
        id: 'conversation',
        items: [{ id: 'open', testID: 'walkthrough-open-conversation', title: t('walkthrough.openConversation'),
            icon: <Icon name="chat-circle-dots" size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> }],
        onSelect: () => router.push(conversationHref as never),
    } : null), [conversationHref, phone, router, theme.colors.text.secondary]);
    const savedSections = React.useMemo(() => {
        const sections = [conversationSection, savedActions.section].filter((section): section is ScmComparisonMenuSection => Boolean(section));
        return sections.length > 0 ? sections : undefined;
    }, [conversationSection, savedActions.section]);

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            {props.renderBar(<>{explainAction}{conversationAction}</>, savedSections, reviewStatus)}
            {modelChoice.choosing ? <ScmDiffSummaryModelPicker value={model} onChange={setModel} modelChoices={modelChoices} machineId={machine?.machineId} serverId={props.serverId} /> : null}
            <WalkthroughView
                reading={reading ?? EMPTY_WALKTHROUGH_READING}
                restoreState={bound.restoreState}
                onRetryRestore={bound.retryRestore}
                scopeLabel={props.scopeLabel}
                scopeDetail={props.scopeDetail}
                modelLabel={viewModel?.producer?.modelId ?? null}
                analysisMark={markAgentId ? <AgentIcon agentId={markAgentId} size={ICON_SIZE.xs} /> : null}
                generatedLabel={reviewView?.generatedLabel ?? null}
                review={reviewView?.slots ?? null}
                layout={props.layout}
                active={props.active}
                offline={offline}
                onToggleReviewed={onToggleReviewed}
                reviewedProgressAvailable={marksAvailable}
                onAsk={onAsk}
                onOpenFile={props.onOpenFile}
                onShowFiles={props.onShowFiles}
                // The band is the way back from the last change; without Undo the reading's own provenance marks carry it.
                update={saved?.updateNotice && onUndo ? { title: t('walkthrough.saved.updated'), onUndo } : null}
                stale={capturedComparison?.freshness === 'stale' ? { ...(canSend && launch.canLaunchExecutionRuns ? { onRefresh: () => {
                    if (!bound.isCurrent()) return;
                    if (!modelAvailable) modelChoice.choose();
                    else void onStart();
                } } : {}) } : null}
                start={{ options: <ScmDiffSummaryStartOptions {...scmDiffSummaryStartOptionsOf(bound, { testID: 'walkthrough-start-options', modelTestID: 'walkthrough-model-choice',
                        prerequisite: scmDiffSummaryPrerequisiteOf(bound),
                        onEnableExplain: openExplainSetting })} />,
                    onStart, busy: starting, disabled: Boolean(bound.startBlocker) || !modelAvailable || !canSend || !launch.canLaunchExecutionRuns }}
                failure={bound.generationFailure}
                onEnableExplain={openExplainSetting}
                onRetry={onStart}
                onChooseModel={modelChoice.choose}
                endedConversation={saved && sessionId && discussion?.kind === 'unavailable' ? { onStartNew, onAskSession } : null}
                notify={machine?.machineId && cwd && runId && capturedComparison && viewModel?.resultId
                    ? <RunWorkNotifications serverId={props.serverId}
                        source={{ kind: 'execution_run', machineId: machine.machineId, runId, ...(sessionId ? { sessionId } : {}) }}
                        project={{ machineId: machine.machineId, directory: cwd }}
                        selectedOutput={{ output: 'walkthrough', comparisonId: capturedComparison.id, resultId: viewModel.resultId,
                            message: t('sessionWork.notify.walkthroughUpdate') }} /> : null}
                savedActions={savedActions.panel}
            />
        </View>
    );
});
