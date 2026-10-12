import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { DaemonExecutionRunEntry } from '@happier-dev/protocol/daemon/executionRuns';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ExecutionRunRow } from '@/components/sessions/runs/ExecutionRunRow';
import { readExecutionRunSessionAssociation } from '@/components/sessions/runs/readExecutionRunSessionAssociation';
import { isAcceptedPendingSessionStop } from '@/components/sessions/sessionStopArchiveFlow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import { Modal } from '@/modal';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { machineExecutionRunsList } from '@/sync/ops';
import { t } from '@/text';
import { showDaemonUnavailableAlert, tryShowDaemonUnavailableAlertForRpcFailure } from '@/utils/errors/daemonUnavailableAlert';
import { fireAndForget } from '@/utils/system/fireAndForget';

type ExecutionRunsState =
    | { status: 'idle' | 'loading'; runs: readonly DaemonExecutionRunEntry[] }
    | { status: 'loaded'; runs: readonly DaemonExecutionRunEntry[] }
    | { status: 'error'; runs: readonly DaemonExecutionRunEntry[]; error: string };

/**
 * The processes sessions started on this machine (Project work), grouped by session, each stoppable
 * while it runs. Loads when the machine is reachable and again on the page's refresh; absent until
 * the machine has answered once.
 */
export const MachineRunsSection = React.memo(function MachineRunsSection(props: Readonly<{
    machine: Machine;
    serverId: string;
    online: boolean;
    /** The focused Home is switching to this machine's: no machine RPC until it settles. */
    isServerSwitching: boolean;
    /** Bumped by the page's refresh. */
    refreshKey: number;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const shouldContinue = useMountedShouldContinue();
    const navigateToSession = useNavigateToSession();
    const { machine, online: isOnline, isServerSwitching } = props;
    const machineId = machine.id;
    const machineServerId = props.serverId;
    const stopExecution = useMountedActionExecution(machineServerId);
    const [executionRunsState, setExecutionRunsState] = React.useState<ExecutionRunsState>({ status: 'idle', runs: [] });
    const [showFinishedRuns, setShowFinishedRuns] = React.useState(false);
    const [stoppingRunId, setStoppingRunId] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!machineId) return;
        if (!isOnline) return;
        if (isServerSwitching) return;

        let cancelled = false;
        setExecutionRunsState((prev) => ({ status: 'loading', runs: prev.runs }));
        fireAndForget((async () => {
            const res = await machineExecutionRunsList(machineId, { serverId: machineServerId });
            if (cancelled) return;
            if (res.ok) {
                setExecutionRunsState({ status: 'loaded', runs: res.runs });
            } else {
                setExecutionRunsState((prev) => ({ status: 'error', runs: prev.runs, error: res.error }));
            }
        })(), { tag: 'MachineRunsSection.fetchExecutionRuns' });

        return () => {
            cancelled = true;
            // A load abandoned because the machine went offline (or the Home changed) has no answer
            // coming: leave "Loading…" rather than hold it forever. Loaded rows stay as they were.
            setExecutionRunsState((prev) => (prev.status === 'loading' ? { status: 'idle', runs: prev.runs } : prev));
        };
    }, [isOnline, isServerSwitching, machineId, machineServerId, props.refreshKey]);

    if (executionRunsState.status === 'idle') return null;
    return (
        <ItemGroup title={t('runs.title')} description={t('machineDetailPage.runsSectionDescription')}>
            {executionRunsState.runs.some((run) => run.status !== 'running') ? <Item
                title={t('runs.showFinished')}
                showChevron={false}
                rightElement={(
                    <Switch
                        value={showFinishedRuns}
                        onValueChange={setShowFinishedRuns}
                        disabled={executionRunsState.status === 'loading'}
                    />
                )}
            /> : null}
            {stopExecution.approval.approvalPending && stopExecution.approval.approvalId ? (
                <ActionApprovalPendingNotice testID="machine-run-stop-approval"
                    message={t('approvals.status.open')}
                    onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(stopExecution.approval.approvalId!)}?serverId=${encodeURIComponent(machineServerId)}`)} />
            ) : null}
            {/* The section's states are the one in-sheet state line, like the Project work sections above it. */}
            {executionRunsState.status === 'loading' ? (
                <SurfaceStateCard testID="machine-runs-loading" size="line" kind="loading" title={t('common.loading')} />
            ) : executionRunsState.status === 'error' ? (
                <SurfaceStateCard testID="machine-runs-error" size="line" kind="error" title={t('machineDetailPage.runsLoadFailed')} reason={executionRunsState.error || undefined} />
            ) : (showFinishedRuns ? executionRunsState.runs : executionRunsState.runs.filter((r) => r.status === 'running')).length === 0 ? (
                <SurfaceStateCard testID="machine-runs-empty" size="line" kind="empty" title={t('runs.empty')} />
            ) : (
                (() => {
                    const visibleRuns = showFinishedRuns
                        ? executionRunsState.runs
                        : executionRunsState.runs.filter((r) => r.status === 'running');

                    const grouped = new Map<string | null, DaemonExecutionRunEntry[]>();
                    for (const run of visibleRuns) {
                        const key = readExecutionRunSessionAssociation(run);
                        const list = grouped.get(key) ?? [];
                        list.push(run);
                        grouped.set(key, list);
                    }
                    const orderedSessionIds = Array.from(grouped.keys()).sort((left, right) => {
                        if (left === null || right === null) {
                            if (left === right) return 0;
                            return left === null ? 1 : -1;
                        }
                        return left.localeCompare(right);
                    });

                    return orderedSessionIds.flatMap((sessionId) => {
                        const runs = grouped.get(sessionId) ?? [];
                        runs.sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));

                        const header = sessionId === null ? null : (
                            <Item
                                key={`sess-${sessionId}`}
                                title={t('runs.sessionTitle', { sessionId })}
                                icon={<Icon name="chat-circle-dots" />}
                                subtitle={t('runs.openSession')}
                                subtitleStyle={{ color: theme.colors.text.secondary }}
                                onPress={() => navigateToSession(sessionId, { serverId: machineServerId })}
                                showChevron
                            />
                        );

                        const rows = runs.slice(0, 20).map((run) => {
                            const detailParts: string[] = [t('runs.detail.pid', { pid: run.pid })];
                            const cpu = (run as any).process?.cpu;
                            const memory = (run as any).process?.memory;
                            if (typeof cpu === 'number' && Number.isFinite(cpu)) {
                                detailParts.push(t('runs.detail.cpu', { percent: cpu.toFixed(1) }));
                            }
                            if (typeof memory === 'number' && Number.isFinite(memory)) {
                                detailParts.push(t('runs.detail.memory', { megabytes: Math.round(memory / (1024 * 1024)) }));
                            }

                            const canStop = run.status === 'running' && sessionId !== null;
                            const onStop = async () => {
                                if (!machineId) return;
                                if (!sessionId) return;
                                if (!canStop) return;
                                setStoppingRunId(run.runId);
                                let issued = false;
                                let refreshRuns = false;
                                const stopSessionProcess = async () => {
                                    if (!stopExecution.isCurrent()) return;
                                    const stopResult = await stopExecution.execute('session.stop', { sessionId });
                                    if (!stopExecution.isCurrent()) return;
                                    let errorCode = stopResult.ok ? null : stopResult.errorCode;
                                    let error = stopResult.ok ? t('runs.stop.failedToStopSession') : stopResult.error;
                                    let retryWhenRuntimeAvailable = false;
                                    const response = stopResult.ok ? stopResult.result : null;
                                    if (response && typeof response === 'object' && !Array.isArray(response)
                                        && 'success' in response && typeof response.success === 'boolean') {
                                        const code = 'code' in response && typeof response.code === 'string' ? response.code : undefined;
                                        const recovery = 'recovery' in response && response.recovery === 'wait_for_inactive'
                                            ? 'wait_for_inactive' : undefined;
                                        if (response.success || isAcceptedPendingSessionStop({ success: response.success, code, recovery })) return;
                                        errorCode = code ?? null;
                                        error = 'message' in response && typeof response.message === 'string'
                                            ? response.message : t('runs.stop.failedToStopSession');
                                        retryWhenRuntimeAvailable = 'recovery' in response && response.recovery === 'retry_when_runtime_available';
                                    }

                                    const retryPresentation = {
                                        machine,
                                        onRetry: () => {
                                            void stopSessionProcess();
                                        },
                                        shouldContinue,
                                    };
                                    if (retryWhenRuntimeAvailable) {
                                        showDaemonUnavailableAlert({ ...retryPresentation,
                                            titleKey: 'errors.daemonUnavailableTitle', bodyKey: 'errors.daemonUnavailableBody' });
                                        return;
                                    }
                                    const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForRpcFailure({
                                        ...retryPresentation, rpcErrorCode: errorCode, message: error,
                                    });
                                    if (!shownDaemonUnavailable) {
                                        Modal.alert(t('common.error'), error || t('runs.stop.failedToStopSession'));
                                    }
                                };
                                const showStopFailure = async (error: string) => {
                                    if (!stopExecution.isCurrent()) return;
                                    if (!issued) {
                                        Modal.alert(t('common.error'), error);
                                        return;
                                    }
                                    const confirmed = await Modal.confirm(
                                        t('runs.stop.stopRunFailedTitle'),
                                        t('runs.stop.stopRunFailedBody'),
                                        { confirmText: t('runs.stop.stopSession'), cancelText: t('common.cancel'), destructive: true },
                                    );
                                    if (!stopExecution.isCurrent()) return;
                                    if (confirmed) await stopSessionProcess();
                                    else Modal.alert(t('common.error'), error);
                                };
                                try {
                                    const res = await stopExecution.execute('execution.run.stop',
                                        { sessionId, runId: run.runId }, { onTransportIssued: () => { issued = true; } });
                                    refreshRuns = res.ok || issued;
                                    if (!res.ok) {
                                        await showStopFailure(res.error || t('runs.stop.failedToStopRun'));
                                    }
                                } catch (error) {
                                    refreshRuns = issued;
                                    await showStopFailure(error instanceof Error ? error.message : t('runs.stop.failedToStopRun'));
                                } finally {
                                    setStoppingRunId(null);
                                    if (refreshRuns && stopExecution.isCurrent()) {
                                        const refreshed = await machineExecutionRunsList(machineId, { serverId: machineServerId });
                                        if (refreshed.ok && stopExecution.isCurrent()) {
                                            setExecutionRunsState({ status: 'loaded', runs: refreshed.runs });
                                        }
                                    }
                                }
                            };

                            return (
                                <ExecutionRunRow
                                    key={run.runId}
                                    run={run as any}
                                    serverId={machineServerId}
                                    subtitle={`${t('runs.runLabel', { runId: run.runId })} · ${detailParts.join(' · ')}`}
                                    onPress={sessionId ? () => router.push(buildScopedSessionRouteHref({
                                        sessionId,
                                        serverId: machineServerId,
                                        suffix: `/runs/${encodeURIComponent(run.runId)}`,
                                    }) as any) : undefined}
                                    rightAccessory={canStop ? (
                                        <Pressable
                                            accessibilityRole="button"
                                            accessibilityLabel={t('runs.stop.stopRunA11y')}
                                            onPress={onStop}
                                            disabled={stoppingRunId === run.runId}
                                            style={({ pressed }) => ({
                                                opacity: pressed ? motionTokens.press.opacity : 1,
                                            })}
                                        >
                                            {stoppingRunId === run.runId ? (
                                                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                            ) : (
                                                <Icon name="stop-circle" size={20} color={theme.colors.accent.orange} />
                                            )}
                                        </Pressable>
                                    ) : null}
                                />
                            );
                        });

                        return header ? [header, ...rows] : rows;
                    });
                })()
            )}
        </ItemGroup>
    );
});
