import { WorkspaceFilesReplaceActionOutputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { DaemonWorkspaceFileReplaceApplyResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { acknowledgeWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });

/** Delivery only: Action admission owns policy; the Machine operation owns effects and cancellation. */
export function createUiWorkspaceFileReplaceAction(account?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['workspaceFilesReplace']> {
    return async (input, context) => {
        context.signal?.throwIfAborted();
        if (!account || account.credentialAuthorityKind !== 'account' || context.externalActionCredential
            || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization
            || context.actionCaller && context.actionCaller.kind !== 'host') return failure('admission_unavailable');
        account.assertCurrent();
        const target = context.externalActionTarget;
        if (target?.kind !== 'machine' || target.machineId !== input.machineId || !context.actionRequestId
            || context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, account.serverId)
            || context.runtimeAccountId && context.runtimeAccountId !== account.accountId) return failure('admission_unavailable');
        const invocation = ExternalActionRequesterInvocationV1Schema.safeParse({
            caller: context.actionCaller ?? { kind: 'host' }, surface: context.surface ?? 'rpc',
            authority: context.authority ?? 'account_automation', callerPermissionMode: context.callerPermissionMode,
            callerInputConstraints: context.callerInputConstraints, workspaceWrites: context.workspaceWrites,
            defaultSessionId: context.defaultSessionId,
        });
        if (!invocation.success) return failure('admission_unavailable');
        // User cancellation requests a stop between files. It must not abort
        // admission or the terminal observation and lose an already-written file's inverse.
        return await withActionAccountRequestSignal({ accountLifetime: account.accountOnlyLifetime }, undefined, async signal => {
            const execution = await executeOriginalAccountMachineAction({ account, actionId: 'workspace.files.replace', input,
                machineId: input.machineId, machineTarget: target, requestId: context.actionRequestId!,
                authority: invocation.data.authority, invocation: invocation.data, ...(signal ? { signal } : {}) });
            if (!execution.ok) return execution;
            const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
            if (approval.success) return approval.data;
            const output = WorkspaceFilesReplaceActionOutputSchema.safeParse(execution.result);
            if (!output.success) return failure('invalid_action_output');
            let result: unknown = output.data;
            if ('operation' in output.data) {
                const operationId = output.data.operation.operationId;
                let cancellation: Promise<unknown> | undefined;
                const cancel = () => {
                    cancellation ??= (async () => {
                        const { executeDefaultActionInCapturedAccount } = await import('./defaultActionExecutor');
                        return await executeDefaultActionInCapturedAccount(account, 'action.operations.cancel', {
                            serverId: account.serverId, machineId: input.machineId, operationId,
                        }, { surface: 'ui', authority: 'present_user', expectedAccountId: account.accountId, signal });
                    })().catch(() => undefined);
                };
                context.signal?.addEventListener('abort', cancel, { once: true });
                try {
                    if (context.signal?.aborted) cancel();
                    const terminal = await getActionOperation({ serverId: account.serverId, accountId: account.accountId,
                        machineId: input.machineId, operationId, waitForTerminal: true, signal,
                        rpc: request => machineRpcWithServerScope({ ...request, operationTimeoutMs: null }),
                    });
                    if (terminal.kind !== 'found' || terminal.operation.operationId !== operationId
                        || terminal.operation.actionId !== 'workspace.files.replace'
                        || terminal.operation.requestId !== context.actionRequestId
                        || terminal.operation.scope.accountId !== account.accountId
                        || terminal.operation.scope.machineId !== input.machineId) return failure('operation_scope_mismatch');
                    if (terminal.operation.state === 'failed') return failure(terminal.operation.error?.errorCode ?? 'workspace_file_replace_failed');
                    if (terminal.operation.state !== 'succeeded') return failure(terminal.operation.state === 'cancelled' ? 'cancelled' : 'outcome_uncertain');
                    result = terminal.operation.result;
                } finally {
                    context.signal?.removeEventListener('abort', cancel);
                    await cancellation;
                }
            }
            const parsed = DaemonWorkspaceFileReplaceApplyResponseSchema.safeParse(result);
            if (!parsed.success) return failure('invalid_action_output');
            if (parsed.data.ok && account.accountOnlyLifetime.isCurrent()) {
                acknowledgeWorkspaceFileWrites({ serverId: account.serverId, accountId: account.accountId,
                    machineId: input.machineId, rootPath: input.rootPath }, parsed.data.results
                    .filter(item => item.status === 'replaced' || item.status === 'restored')
                    .map(item => ({ path: item.path, hash: item.hash ?? null })));
            }
            return parsed.data;
        });
    };
}
