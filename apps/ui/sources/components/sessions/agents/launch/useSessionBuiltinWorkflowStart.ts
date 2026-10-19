import * as React from 'react';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { RoleOverrideV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import type { WorkflowRunStartRequestV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowStartSelection } from '@/components/workflows/run/WorkflowStartPicker';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useWorkflowRunComposerModal, type WorkflowRunComposerModalProps } from '@/components/workflows/run/useWorkflowRunComposerModal';
import { useWorkflowRunNowController } from '@/components/workflows/run/useWorkflowRunNowController';
import { randomUUID } from '@/platform/randomUUID';
import { tLoose } from '@/text';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

type BuiltinWorkflowEntry = (typeof BUILTIN_WORKFLOW_CATALOG_V1)[number];

/**
 * The built-ins a session's "+" can start: those that run on their own beside it. A built-in that
 * runs inside a session (Keep going) needs that session as its run's origin. Declared Session
 * defaults, including Review & converge's review target, use that exact Session below.
 */
export const SESSION_STARTABLE_BUILTIN_WORKFLOWS: readonly BuiltinWorkflowEntry[] = BUILTIN_WORKFLOW_CATALOG_V1;

type PendingStart = Readonly<{
    entry: Readonly<{ definition: WorkflowPluginSourceV1['definition']; title: string; description: string; source: WorkflowRunStartRequestV1['source'] }>;
    lifetime: ActiveServerAccountScopeLifetime;
    values: Readonly<Record<string, JsonValue | undefined>>;
    rawTextValues: Readonly<Record<string, string>>;
}>;

/**
 * Starts a catalog workflow from a session through FIN's run start (`workflow.run.start` with a
 * catalog source, on the session's machine and folder): its declared inputs are asked first in
 * the shared start composer, and the admitted Run opens. No second start path and no Run cache.
 */
export function useSessionBuiltinWorkflowStart(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
}>): (workflow: string | WorkflowPluginSourceV1 | WorkflowStartSelection, options?: Readonly<{ retainedDraft?: string }>) => void {
    const router = useRouter();
    const target = useSessionMachineTarget(params.sessionId, params.serverId);
    const runNow = useWorkflowRunNowController();
    const { clearRefusal } = runNow;
    const mounted = useMountedRef();
    const [pending, setPending] = React.useState<PendingStart | null>(null);
    // One press is one admission: a retry after a lost response reuses the same Run id.
    const pendingRunIdRef = React.useRef<string | null>(null);
    const machineId = target?.machineId ?? null;
    const directory = target?.basePath ?? null;

    const admit = React.useCallback(async (
        selected: PendingStart,
        inputs: Readonly<Record<string, JsonValue>> | undefined,
        roleOverrides?: readonly RoleOverrideV1[],
    ) => {
        const isCurrent = () => mounted.current && selected.lifetime.isCurrent();
        if (!machineId || !directory || !isCurrent()) return;
        const { entry } = selected;
        const runId = pendingRunIdRef.current ?? randomUUID();
        pendingRunIdRef.current = runId;
        const admitted = await runNow.runNow({
            runId,
            source: entry.source,
            metadata: { title: entry.title },
            ...(inputs === undefined ? {} : { inputs: { ...inputs } }),
            ...(roleOverrides === undefined ? {} : { roleOverrides: [...roleOverrides] }),
            project: { machineId, directory },
            originSessionId: params.sessionId,
            isInvocationCurrent: isCurrent,
            // The start form stays open and says why beside Start, with its inputs and draft kept (lab T4-ST).
            refusal: 'inline',
        });
        if (admitted === null || !isCurrent()) return;
        pendingRunIdRef.current = null;
        setPending(null);
        router.push({ pathname: '/workflows/runs/[runId]', params: { runId: admitted.run.id } } as never);
    }, [directory, machineId, mounted, params.sessionId, router, runNow]);

    const start = React.useCallback((
        workflow: string | WorkflowPluginSourceV1 | WorkflowStartSelection,
        options?: Readonly<{ retainedDraft?: string }>,
    ) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null || !machineId || !directory) return;
        let entry: PendingStart['entry'];
        if (typeof workflow === 'string') {
            const builtin = SESSION_STARTABLE_BUILTIN_WORKFLOWS.find((candidate) => candidate.id === workflow);
            if (!builtin) return;
            entry = { definition: builtin.definition, title: tLoose(builtin.titleKey), description: tLoose(builtin.descriptionKey),
                source: { kind: 'catalog', workflow: builtin.id } };
        } else if ('source' in workflow) {
            // A Run… picker choice (built-in, saved or plugin) already names its exact start source.
            entry = { definition: workflow.definition, title: workflow.name, description: workflow.description, source: workflow.source };
        } else {
            entry = { definition: workflow.definition, title: workflow.title, description: workflow.description ?? '',
                source: { kind: 'catalog', workflow: workflow.workflow, pluginVersion: workflow.version } };
        }
        pendingRunIdRef.current = null;
        clearRefusal();
        // The composer's retained draft is the question: it prefills the first text input, as New does.
        const text = options?.retainedDraft ?? '';
        const main = text.trim() ? entry.definition.inputs.find((input) => input.valueType === 'string') : undefined;
        const draft = main ? { [main.name]: text } : {};
        setPending({ entry, lifetime, values: draft, rawTextValues: draft });
    }, [clearRefusal, directory, machineId]);

    const cancel = React.useCallback(() => {
        clearRefusal();
        setPending(null);
    }, [clearRefusal]);
    const changeValues = React.useCallback((values: PendingStart['values']) => {
        setPending((current) => current ? { ...current, values } : current);
    }, []);
    const changeRawTextValues = React.useCallback((rawTextValues: PendingStart['rawTextValues']) => {
        setPending((current) => current ? { ...current, rawTextValues } : current);
    }, []);
    const modalProps = React.useMemo<WorkflowRunComposerModalProps | null>(() => pending === null ? null : {
        inputs: pending.entry.definition.inputs,
        definition: pending.entry.definition,
        optionsConsumer: pending.entry.source.kind === 'catalog' ? { kind: 'workflow', workflow: pending.entry.source.workflow }
            : pending.entry.source.kind === 'saved' ? { kind: 'workflow', workflow: pending.entry.source.definitionId } : undefined,
        values: pending.values,
        onChangeValues: changeValues,
        rawTextValues: pending.rawTextValues,
        onChangeRawTextValues: changeRawTextValues,
        workflowName: pending.entry.title,
        preview: pending.entry.description,
        machineId,
        serverId: params.serverId ?? null,
        originSession: { serverId: params.serverId ?? pending.lifetime.scope.serverId, sessionId: params.sessionId },
        onRun: (inputs, roleOverrides) => { void admit(pending, inputs, roleOverrides); },
        onCancel: cancel,
        pending: runNow.isPending(pendingRunIdRef.current ?? ''),
        reconciling: runNow.stateFor(pendingRunIdRef.current ?? '') === 'reconciling',
        startProblem: runNow.refusal?.message ?? null,
    }, [admit, cancel, changeRawTextValues, changeValues, machineId, params.serverId, params.sessionId, pending, runNow]);
    useWorkflowRunComposerModal({ open: pending !== null, props: modalProps });

    return start;
}
