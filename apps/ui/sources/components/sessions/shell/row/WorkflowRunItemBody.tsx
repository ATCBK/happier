import * as React from 'react';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useWorkRelativeTime } from '@/components/sessions/agents/presentation/agentActivityClock';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { describeWorkflowRunState, isTerminalWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { normalizeResultPreview } from '@/components/workflows/presentation/resultPreview';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { describeWorkflowRunDestinationProgress, describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { workStatusGlyphColor, workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { getStorage, useWorkflowRun, useServerScopedMachine } from '@/sync/domains/state/storage';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishOpenedWorkflowRunDetail } from '@/sync/engine/workflows/refreshWorkflowRun';
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { Item } from '@/components/ui/lists/Item';
import { WORKER_KIND_GLYPHS } from '@/components/sessions/work/workerKindGlyphs';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';

import { SESSION_LIST_ROW_CORNER_RADIUS, type SessionListRowDensity } from '../resolveSessionListDensityViewState';
import { SESSION_LIST_SHEET_INSET_PX } from '../sessionListStyles';
import {
    SessionListRowPresentation, SessionListRowSubtitle, SessionListRowTitle, useReadableNativePhoneMinimalRow,
} from './SessionListRowPresentation';

export type WorkflowRunItemProps = Readonly<{
    kind: 'workflow_run';
    runId: string;
    serverId: string;
    dataActive?: boolean;
    density?: SessionListRowDensity;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
    folderDepth?: number;
    reportsDepth?: number;
    /** Opened habit History only; collection/trigger summary rows never request result bodies. */
    includeResult?: boolean;
    /** Work-pane configuration rows use the same Item anatomy as Triggers. */
    presentation?: 'list' | 'work';
    /** Writes-here rows retain their destination, separately from the Run's origin. */
    destinationSessionId?: string;
    /** What names a Run whose own title cannot be read: the trigger or workflow it belongs to. */
    fallbackName?: string;
}>;

const styles = StyleSheet.create((theme) => ({
    sheet: { marginHorizontal: SESSION_LIST_SHEET_INSET_PX },
    tail: { marginBottom: theme.space.s12 },
    context: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
    status: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, flexShrink: 1, minWidth: 0 },
    statusWord: { flexShrink: 1, minWidth: 0 },
    guide: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.default },
}));

/** Only the age leaf observes the existing shared clock; hidden rows keep a frozen snapshot. */
function WorkflowRunRowAge(props: Readonly<{
    runId: string; timestamp: number; dataActive: boolean; density: SessionListRowDensity; readablePhone: boolean; textScale: number;
}>) {
    const frozenNow = React.useRef(Date.now());
    const age = useWorkRelativeTime(props.timestamp, props.dataActive ? undefined : frozenNow.current);
    return <SessionListRowSubtitle testID={`workflow-run-row:${props.runId}:age`}
        density={props.density} readableNativePhoneMinimal={props.readablePhone} textScale={props.textScale}>{age}</SessionListRowSubtitle>;
}

/** Read status is local; the selected result and its producer remain in the Account's sole Run body. */
function useOpenedWorkflowRunResult(input: Readonly<{
    runId: string; scopeKey: string | null; enabled: boolean; row: WorkflowRunRow | null;
}>) {
    const identity = `${input.scopeKey ?? ''}\u0000${input.runId}`;
    const [attempt, setAttempt] = React.useState(0);
    const [read, setRead] = React.useState<Readonly<{ identity: string; status: 'pending' | 'loaded' | 'failed' }> | null>(null);
    const revision = input.row?.summary?.revision;
    React.useEffect(() => {
        if (!input.enabled) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || serverAccountScopeKeySuffix(lifetime.scope) !== input.scopeKey) return;
        let cancelled = false;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        setRead({ identity, status: 'pending' });
        void workflowRunDetailActions.getRun(input.runId, controller.signal).then(detail => {
            if (cancelled || !lifetime.isCurrent()) return;
            publishOpenedWorkflowRunDetail(detail);
            setRead({ identity, status: 'loaded' });
        }).catch(() => {
            if (!cancelled && lifetime.isCurrent()) setRead({ identity, status: 'failed' });
        });
        return () => { cancelled = true; controller.abort(); retirement.dispose(); };
    }, [attempt, identity, input.enabled, input.runId, input.scopeKey, revision]);
    const retry = React.useCallback(() => setAttempt(value => value + 1), []);
    const status = read?.identity === identity ? read.status : 'pending';
    const detail = input.row?.detail;
    const value = status === 'failed' ? undefined : detail?.result;
    // getRun's strict schema admits result and finalOutputInvocationId as one pair.
    const text = value === undefined ? null
        : normalizeResultPreview(typeof value === 'string' ? value : JSON.stringify(value)).display.replace(/\s+/gu, ' ').trim();
    return { status, text, retry };
}

/** The Run arm of SessionItem: the same sheet anatomy, with an exact, demand-bound reader. */
export function WorkflowRunItemBody(props: WorkflowRunItemProps): React.ReactElement | null {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { fontScale } = useWindowDimensions();
    const scope = getStorage()((state) => state.profileScope);
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const inScope = scope !== null && areServerProfileIdentifiersEquivalent(scope.serverId, props.serverId);
    const dataActive = props.dataActive !== false && inScope;
    const live = useWorkflowRun(props.runId, { enabled: dataActive });
    const retained = React.useRef<Readonly<{ scopeKey: string | null; serverId: string; runId: string; row: WorkflowRunRow | null }> | null>(null);
    if (dataActive || retained.current === null || retained.current.scopeKey !== scopeKey
        || retained.current.serverId !== props.serverId || retained.current.runId !== props.runId) {
        retained.current = { scopeKey, serverId: props.serverId, runId: props.runId,
            row: inScope ? live ?? getStorage().getState().workflowRunsById[workflowRunStoreKey(props.runId)] ?? null : null };
    }
    // A hidden surface retains its body, never another Account's body.
    const row = inScope && retained.current.scopeKey === scopeKey ? retained.current.row : null;
    const summary = row?.summary;
    const machine = useServerScopedMachine(dataActive ? props.serverId : '', dataActive ? summary?.machineId ?? '' : '');
    const observedMachines = React.useMemo(() => machine ? [machine] : [], [machine]);
    const presenceNowMs = useMachinePresenceNowMs(observedMachines);
    useMachineReachabilityRevision(dataActive && machine !== null);
    const machineReachable = machine ? isMachineReachable(inScope ? scope : null, machine, presenceNowMs) : undefined;
    const machineName = getMachineDisplayName(machine);
    const resultEnabled = props.includeResult === true && dataActive && summary != null
        && isTerminalWorkflowRunState(summary.state);
    const result = useOpenedWorkflowRunResult({ runId: props.runId, scopeKey, enabled: resultEnabled, row });
    const readablePhone = useReadableNativePhoneMinimalRow(props.density === 'minimal');
    if (!summary) return null;
    const density = props.density ?? 'default';
    // A Run is always named: its own title, else the trigger or workflow it belongs to. Why the title
    // could not be read is a quiet part of the line beneath, never the name.
    const displayName = resolveWorkflowRunDisplayName(row.metadata);
    const name = displayName.kind === 'name' ? displayName.value
        : props.fallbackName ?? formatWorkflowRunDisplayName({ kind: 'unknown' });
    const unreadable = displayName.kind === 'unavailable' ? formatWorkflowRunDisplayName(displayName) : null;
    const lifecycle = describeWorkflowRunState(summary.state, {
        inAttentionWindow: summary.attentionRequired === true, workflowCustodyState: summary.workflowCustodyState,
        machineReachable, machineName,
    });
    const status = resolveWorkStatusTone({ kind: 'workflow_run', facts: {
        state: summary.state, word: lifecycle.label, inAttentionWindow: summary.attentionRequired === true,
        workflowCustodyState: summary.workflowCustodyState,
        machineReachable, machineName,
    } });
    const word = status.word;
    const destinationProgress = props.destinationSessionId
        ? describeWorkflowRunDestinationProgress(summary.stepProgress, props.destinationSessionId) : [];
    const starterLabel = summary.startedBy === 'trigger' ? t('workflows.list.startedByTrigger')
        : summary.startedBy === 'agent' ? t('workflows.list.startedByAgent') : null;
    // A Writes-here row leads with the step that writes into this Session, then the Run's aggregate
    // progress; when the Run began is not what this row is for. Without a known destination step the
    // work row keeps its start time, so it never reads bare.
    const context = [...destinationProgress,
        props.presentation === 'work' && destinationProgress.length === 0 ? formatAsOfTime(Date.parse(summary.createdAt)) : null,
        describeWorkflowRunProgress(summary.stepProgress),
        props.presentation !== 'work' ? starterLabel : null, unreadable].filter(Boolean).join(' · ');
    const resultLine = !resultEnabled ? null : result.text
        ?? t(result.status === 'failed' ? 'workflows.contentUnavailable'
            : result.status === 'pending' ? 'common.loading' : 'workflows.finalOutput.none');
    const depth = (props.folderDepth ?? 0) + (props.reportsDepth ?? 0);
    if (props.presentation === 'work') return (
        <Item testID={`workflow-run-row:${props.runId}`}
            title={name} subtitle={[resultLine ?? context, starterLabel].filter(Boolean).join(' · ')}
            icon={<Icon name={WORKER_KIND_GLYPHS.workflow_run} />}
            rightElement={<View style={styles.status}>
                {lifecycle.marker.kind === 'activity'
                    ? <ActivitySpinner size={ICON_SIZE.xs} animationEnabled={dataActive} color={workStatusGlyphColor(theme.colors, status.tone)} />
                    : null}
                <SessionListRowSubtitle density={density} textScale={fontScale} style={[styles.statusWord, workStatusWordStyle(status.tone)]}>{word}</SessionListRowSubtitle>
            </View>}
            showChevron={false}
            accessibilityLabel={[name, word, context, starterLabel].filter(Boolean).join('. ')}
            onPress={() => router.push(createWorkflowRunRoute(props.runId, props.serverId) as never)} />
    );
    return <GlassSurface testID={`workflow-run-sheet:${props.runId}`} surfaceGroup="card" nested finishRole={null}
        solidColor={theme.colors.surface.base} style={[styles.sheet, {
        overflow: 'hidden',
        borderTopLeftRadius: props.isFirst || props.isSingle ? SESSION_LIST_ROW_CORNER_RADIUS : 0,
        borderTopRightRadius: props.isFirst || props.isSingle ? SESSION_LIST_ROW_CORNER_RADIUS : 0,
        borderBottomLeftRadius: props.isLast || props.isSingle ? SESSION_LIST_ROW_CORNER_RADIUS : 0,
        borderBottomRightRadius: props.isLast || props.isSingle ? SESSION_LIST_ROW_CORNER_RADIUS : 0,
    }, props.isLast || props.isSingle ? styles.tail : null,
        depth > 0 ? { paddingLeft: depth * 12 } : null]}>
        <View style={depth > 0 ? styles.guide : null}>
            <SessionListRowPresentation density={density} readableNativePhoneMinimal={readablePhone} textScale={fontScale} first={props.isFirst || props.isSingle}
                last={props.isLast || props.isSingle} selected={props.selected}
                identity={<Icon name={WORKER_KIND_GLYPHS.workflow_run} size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                // A Run is named work, so its title reads in primary ink, as a live Session's does.
                title={<SessionListRowTitle density={density} readableNativePhoneMinimal={readablePhone} textScale={fontScale}
                    emphasized={props.selected} color={theme.colors.text.primary}>{name}</SessionListRowTitle>}
                trailingProps={{ testID: `workflow-run-row:${props.runId}:status` }}
                trailing={summary.state === 'succeeded' && status.tone === 'neutral' ? <WorkflowRunRowAge
                    runId={props.runId} timestamp={Date.parse(summary.finishedAt ?? summary.updatedAt)}
                    dataActive={dataActive} density={density} readablePhone={readablePhone} textScale={fontScale} /> : <View style={styles.status}>
                    {lifecycle.marker.kind === 'activity'
                        ? <ActivitySpinner size={ICON_SIZE.xs} animationEnabled={dataActive} color={workStatusGlyphColor(theme.colors, status.tone)} />
                        : <Icon name={lifecycle.marker.icon} size={ICON_SIZE.xs} color={workStatusGlyphColor(theme.colors, status.tone)} />}
                    {lifecycle.marker.kind !== 'activity' || status.tone !== 'neutral'
                        ? <SessionListRowSubtitle density={density} readableNativePhoneMinimal={readablePhone} textScale={fontScale} style={[styles.statusWord, workStatusWordStyle(status.tone)]}>{word}</SessionListRowSubtitle> : null}
                </View>}
                renderContainer={(content, style) => <WorkspaceDestinationRow href={createWorkflowRunRoute(props.runId, props.serverId)} style={style}>
                    <Pressable style={style} testID={`workflow-run-row:${props.runId}`}
                    accessibilityRole="button" accessibilityState={{ selected: props.selected === true }}
                    accessibilityLabel={[name, word, context, starterLabel].filter(Boolean).join('. ')}
                    onPress={() => router.push(createWorkflowRunRoute(props.runId, props.serverId) as never)}>{content}</Pressable>
                </WorkspaceDestinationRow>}>
                {context || starterLabel || resultLine !== null ? <View style={styles.context}>
                    {summary.startedBy === 'trigger' || summary.startedBy === 'agent'
                        ? <Icon name={summary.startedBy === 'trigger' ? 'lightning' : 'robot'} size={ICON_SIZE.xs}
                            color={theme.colors.text.tertiary} /> : null}
                    {resultLine !== null || context ? <SessionListRowSubtitle density={density} readableNativePhoneMinimal={readablePhone} textScale={fontScale}>
                        {resultLine ?? context}</SessionListRowSubtitle> : null}
                    {resultEnabled && result.status === 'failed' ? <ToolbarButton
                        testID={`workflow-run-result:${props.runId}:retry`} label={t('workflows.retry')}
                        onPress={event => { event?.stopPropagation(); result.retry(); }} /> : null}
                </View> : null}
            </SessionListRowPresentation>
        </View>
    </GlassSurface>;
}
