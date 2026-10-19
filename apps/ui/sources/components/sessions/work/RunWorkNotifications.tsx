import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import * as React from 'react';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { AutomationRunLifecycleSource } from '@happier-dev/protocol/automations/automationRunLifecycle';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ScmDiffSummaryGenerateOutputSchema, type ScmDiffSummaryOutputKind } from '@happier-dev/protocol/scm/diffSummary';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { WorkflowTriggerAddRequestV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { buildTriggerTarget, readTriggerThen } from '@/components/workflows/triggers/sessionTriggerForm';
import { callWorkflowAction, type WorkflowActionExecute } from '@/sync/domains/workflows/callWorkflowAction';
import { addWorkflowTrigger, listWorkflowTriggerSets, removeWorkflowTrigger, type WorkflowTriggerWriteResult } from '@/sync/domains/workflows/workflowTriggerActions';
import { getStorage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createWorkflowTriggerChangeSelector, createWorkflowTriggerSetSelector } from '@/sync/store/domains/automations';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { t } from '@/text';
import { WorkNotificationGroup, WorkNotificationOperation } from './WorkNotificationOperation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';

export type RunTriggersRead = Readonly<{
    status: 'loading' | 'ready' | 'failed';
    sets: readonly WorkflowTriggerSetV1[];
    add: (input: WorkflowTriggerAddRequestV1) => Promise<WorkflowTriggerWriteResult>;
    remove: (automationId: string, triggerId: string) => Promise<WorkflowTriggerWriteResult>;
}>;

/** The caller selects an output; its saved identity and baseline come from the Run owner. */
export type RunWorkNotificationOutput = Readonly<{
    output: ScmDiffSummaryOutputKind;
    comparisonId: string;
    resultId: string;
    message: string;
}>;

export function RunWorkNotifyOperation(props: Readonly<{
    source: AutomationRunLifecycleSource;
    project: WorkflowProjectTargetV1;
    read: RunTriggersRead;
    execute?: WorkflowActionExecute;
    selectedOutput?: RunWorkNotificationOutput;
}>) {
    const conditions = props.source.kind === 'workflow_run' ? ['terminal', 'needs_attention'] as const : ['terminal'] as const;
    // Each offer is a full-width row with its switch trailing, as in the Session's Work section: a row
    // that hugged its label would leave the two switches on different edges.
    return <WorkNotificationGroup sourceId={props.source.runId} style={{ minWidth: 0 }}>
        {conditions.map((condition) => {
            const message = props.selectedOutput?.message ?? (condition === 'terminal' ? t('sessionWork.notify.runFinished') : t('sessionWork.notify.runNeedsYou'));
            const matchesSource = (source: AutomationRunLifecycleSource) => {
                if (!props.selectedOutput) return sameStrictJsonValue(source, props.source);
                if (source.kind !== 'execution_run' || props.source.kind !== 'execution_run') return false;
                const { observation, ...base } = source;
                const { observation: _callerObservation, ...callerBase } = props.source;
                return sameStrictJsonValue(base, callerBase) && observation?.kind === 'scm_diff_summary'
                    && observation.output === props.selectedOutput.output && observation.comparisonId === props.selectedOutput.comparisonId
                    && observation.resultId === props.selectedOutput.resultId;
            };
            const match = (set: WorkflowTriggerSetV1) => {
                const then = set.target ? readTriggerThen(set.target) : null;
                if (!set.enabled || set.health !== 'available' || then?.kind !== 'notifyMe') return null;
                return set.triggers.find((trigger) => trigger.kind === 'runLifecycle' && trigger.enabled
                    && trigger.status.state === 'waiting' && trigger.remainingOccurrences !== 0
                    && trigger.condition === condition && matchesSource(trigger.source))?.id ?? null;
            };
            const add = async () => {
                let source = props.source;
                if (props.selectedOutput) {
                    if (source.kind !== 'execution_run') throw new Error('Output notifications require an execution Run');
                    const snapshot = await callWorkflowAction({ actionId: 'execution.run.get',
                        input: { runId: source.runId, sessionId: source.sessionId ?? null, includeStructured: true },
                        context: { executionRunTargetMachineId: source.machineId }, execute: props.execute,
                        parseResult: value => ExecutionRunGetResponseSchema.parse(value) });
                    const output = createStoredReadSchema(ScmDiffSummaryGenerateOutputSchema).parse(
                        snapshot.structuredMeta?.kind === EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary ? snapshot.structuredMeta.payload : snapshot.latestToolResult);
                    const progress = output.outputs?.[props.selectedOutput.output];
                    if (snapshot.run.runId !== source.runId || output.comparison?.id !== props.selectedOutput.comparisonId
                        || !output.resultId || output.revision === undefined || !progress
                        || !output.requestedOutputs?.includes(props.selectedOutput.output)
                        || output.resultId !== props.selectedOutput.resultId) {
                        throw new Error('execution_run_output_source_mismatch');
                    }
                    source = { ...source, observation: { kind: 'scm_diff_summary', output: props.selectedOutput.output,
                        comparisonId: props.selectedOutput.comparisonId, resultId: output.resultId,
                        // Settled output catches up immediately; only unfinished output needs a later revision.
                        ...(progress.state === 'pending' || progress.state === 'writing' ? { afterRevision: output.revision } : {}) } };
                }
                const target = buildTriggerTarget({ kind: 'notifyMe', message, title: '', channels: [] }, 'account');
                if (!target) throw new Error('Invalid notification target');
                return props.read.add({ project: props.project, target,
                    trigger: { kind: 'runLifecycle', source, condition, enabled: true } });
            };
            return <WorkNotificationOperation key={condition} sourceId={props.source.runId} testIDPrefix={`notify-run-${condition}`}
                title={condition === 'terminal' ? t('sessionWork.notify.run') : t('sessionWork.notify.attention')}
                sets={props.read.sets} status={props.read.status} machineId={props.project.machineId}
                match={match} add={add} remove={(triggerId, automationId) => props.read.remove(automationId, triggerId)} execute={props.execute} />;
        })}
    </WorkNotificationGroup>;
}

/** Run sources and writes are views of the existing Account-inline Automation projection. */
export function RunWorkNotifications(props: Readonly<{
    source: AutomationRunLifecycleSource;
    project: WorkflowProjectTargetV1;
    serverId?: string | null;
    selectedOutput?: RunWorkNotificationOutput;
}>) {
    const scope = useActiveServerAccountScope();
    if (!scope || (props.serverId && !areServerProfileIdentifiersEquivalent(props.serverId, scope.serverId))) return null;
    return <RunWorkNotificationsForAccount key={`${scope.serverId}:${scope.accountId}:${props.source.kind}:${props.source.runId}:${props.selectedOutput?.comparisonId ?? ''}:${props.selectedOutput?.output ?? ''}:${props.selectedOutput?.resultId ?? ''}`} {...props} />;
}

function RunWorkNotificationsForAccount(props: Readonly<{ source: AutomationRunLifecycleSource; project: WorkflowProjectTargetV1; selectedOutput?: RunWorkNotificationOutput }>) {
    const selector = React.useMemo(() => createWorkflowTriggerSetSelector('account_inline'), []);
    const sets = getStorage()(selector);
    const changeSelector = React.useMemo(() => createWorkflowTriggerChangeSelector(null), []);
    const changeSignal = getStorage()(changeSelector);
    const [status, setStatus] = React.useState<RunTriggersRead['status']>('loading');
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        const controller = new AbortController();
        void listWorkflowTriggerSets({ scope: 'account_inline' }, { signal: controller.signal })
            .then(() => { if (!controller.signal.aborted) setStatus('ready'); })
            .catch(() => { if (!controller.signal.aborted) setStatus('failed'); });
        return () => controller.abort();
    }, [attempt, changeSignal]);
    return <>
        <RunWorkNotifyOperation source={props.source} project={props.project} selectedOutput={props.selectedOutput} read={{ status, sets,
            add: (input) => addWorkflowTrigger(input), remove: (automationId, triggerId) => removeWorkflowTrigger({ automationId, triggerId }) }} />
        {status === 'failed' ? <RoundButton display="inverted" size="small" style={{ minHeight: 44 }}
            title={t('common.retry')} onPress={() => setAttempt((value) => value + 1)} /> : null}
    </>;
}

/**
 * An execution Run that lives in a Session: the Session names the machine and folder the notification
 * is registered against, so a surface only says which Run. Without both, the offer is not shown.
 */
export function SessionRunWorkNotifications(props: Readonly<{
    sessionId: string;
    runId: string;
    serverId?: string | null;
    selectedOutput?: RunWorkNotificationOutput;
}>) {
    const session = useSessionViewShellSession(props.sessionId, props.serverId ?? null);
    const machineId = resolveSessionMachineId(session?.metadata);
    const directory = session?.metadata?.path?.trim() || null;
    if (!machineId || !directory) return null;
    return <RunWorkNotifications source={{ kind: 'execution_run', machineId, runId: props.runId, sessionId: props.sessionId }}
        project={{ machineId, directory }} serverId={props.serverId} selectedOutput={props.selectedOutput} />;
}
