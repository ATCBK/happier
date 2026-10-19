import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useWorkflowComposerStart } from '@/components/workflows/run/useWorkflowComposerStart';
import type { WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';

export { SESSION_STARTABLE_BUILTIN_WORKFLOWS } from '@/components/workflows/run/useWorkflowComposerStart';

/** Session placement and navigation bind the shared Workflow composer/start owner. */
export function useSessionBuiltinWorkflowStart(params: Readonly<{ sessionId: string; serverId?: string | null }>) {
    const router = useRouter();
    const target = useSessionMachineTarget(params.sessionId, params.serverId);
    const project = React.useMemo(() => target ? { machineId: target.machineId, directory: target.basePath } : null,
        [target?.basePath, target?.machineId]);
    const originSession = React.useMemo(() => ({ serverId: params.serverId ?? undefined, sessionId: params.sessionId }),
        [params.serverId, params.sessionId]);
    const onStarted = React.useCallback((result: WorkflowRunStartResultV1) => {
        router.push({ pathname: '/workflows/runs/[runId]', params: { runId: result.run.id } } as never);
    }, [router]);
    return useWorkflowComposerStart({ project, originSession, onStarted });
}
