import type { WorkspaceSyncRelationshipsListActionInputV1, WorkspaceSyncRelationshipsListActionOutputV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolveWorkspaceSyncReadControllerV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';

import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** Read placement comes from the captured Account's rows, never the focused Home's cache. */
export async function listWorkspaceSyncRelationshipsOnController(request: Readonly<{
    input: WorkspaceSyncRelationshipsListActionInputV1;
    account: LazyActionAccountContext | undefined;
    signal?: AbortSignal;
}>): Promise<WorkspaceSyncRelationshipsListActionOutputV1> {
    const { account, input, signal } = request;
    if (!account) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
    account.assertCurrent();
    const rows = input.workspaceRefId ? await createUiProjectAccountRowsClient(account).read(signal) : null;
    if (rows && (rows.status !== 'ready' || rows.coverage !== 'complete')) {
        throw Object.assign(new Error('workspace_ref_not_ready'), { code: 'workspace_ref_not_ready' });
    }
    const controllerMachineId = resolveWorkspaceSyncReadControllerV1({
        ...input, serverId: account.serverId, context: workspaceRefResolutionContextV1,
        workspaceRefs: rows?.workspaceRefs ?? [], relationships: rows?.relationships ?? [],
    });
    account.assertCurrent();
    const result = await machineRpcWithServerScope<WorkspaceSyncRelationshipsListActionOutputV1, unknown>({
        serverId: account.serverId, accountId: account.accountId, machineId: controllerMachineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST,
        payload: input.workspaceRefId ? { workspaceRefId: input.workspaceRefId } : {},
        ...(signal ? { signal } : {}),
    });
    account.assertCurrent();
    return result;
}
