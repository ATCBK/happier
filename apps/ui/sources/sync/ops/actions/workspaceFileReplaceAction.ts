import { WorkspaceFilesReplaceActionOutputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { DaemonWorkspaceFileReplaceApplyResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { DaemonLspApplyResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { acknowledgeWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });

type MachineWriteContext = Parameters<NonNullable<ActionExecutorDeps['workspaceFilesReplace']>>[1];

/**
 * The present user's admitted write to an exact Machine: the original Account, the requested Machine and
 * request id, and the requester invocation the Home verifies. Shared by every UI Machine write Action.
 */
function admitUiMachineWrite(account: LazyActionAccountContext | undefined, machineId: string, context: MachineWriteContext) {
    context.signal?.throwIfAborted();
    if (!account || account.credentialAuthorityKind !== 'account' || context.externalActionCredential
        || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization
        || context.actionCaller && context.actionCaller.kind !== 'host') return null;
    account.assertCurrent();
    const target = context.externalActionTarget;
    if (target?.kind !== 'machine' || target.machineId !== machineId || !context.actionRequestId
        || context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, account.serverId)
        || context.runtimeAccountId && context.runtimeAccountId !== account.accountId) return null;
    const invocation = ExternalActionRequesterInvocationV1Schema.safeParse({
        caller: context.actionCaller ?? { kind: 'host' }, surface: context.surface ?? 'rpc',
        authority: context.authority ?? 'account_automation', callerPermissionMode: context.callerPermissionMode,
        callerInputConstraints: context.callerInputConstraints, workspaceWrites: context.workspaceWrites,
        defaultSessionId: context.defaultSessionId,
    });
    if (!invocation.success) return null;
    return { account, target, requestId: context.actionRequestId, invocation: invocation.data };
}

/** Delivery only: Action admission owns policy; the Machine operation owns effects and cancellation. */
export function createUiWorkspaceFileReplaceAction(accountContext?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['workspaceFilesReplace']> {
    return async (input, context) => {
        const admitted = admitUiMachineWrite(accountContext, input.machineId, context);
        if (!admitted) return failure('admission_unavailable');
        const { target } = admitted;
        const invocation = { data: admitted.invocation };
        // User cancellation requests a stop between files. It must not abort
        // admission or the terminal observation and lose an already-written file's inverse.
        const account = admitted.account;
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

/**
 * Semantic edits (P7 U7: rename, file rename, one code action) from the present user. Their RPC methods
 * require canonical Action admission at the Home, so the UI delivers them exactly like replace: the
 * admitted original-Account Machine Action, never a raw Machine RPC.
 */
export function createUiLanguageIntelligenceApplyAction(account?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['languageIntelligenceApply']> {
    return async ({ machineId, request, actionId }, context) => {
        const admitted = admitUiMachineWrite(account, machineId, context);
        if (!admitted) return failure('admission_unavailable');
        const input = request.operation.kind === 'codeAction' ? { machineId, ...request }
            : { machineId, rootPath: request.rootPath, path: request.path,
                ...(request.languageId ? { languageId: request.languageId } : {}), files: request.operation.files };
        const live = admitted.account;
        // Like replace: cancellation never abandons the terminal receipt and its inverse edits.
        return await withActionAccountRequestSignal({ accountLifetime: live.accountOnlyLifetime }, undefined, async signal => {
            const execution = await executeOriginalAccountMachineAction({ account: live, actionId, input,
                machineId, machineTarget: admitted.target, requestId: admitted.requestId,
                authority: admitted.invocation.authority, invocation: admitted.invocation, ...(signal ? { signal } : {}) });
            if (!execution) return failure('admission_unavailable');
            if (!execution.ok) return execution;
            const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
            if (approval.success) return approval.data;
            const parsed = DaemonLspApplyResponseSchema.safeParse(execution.result);
            if (!parsed.success) return failure('invalid_action_output');
            const result = parsed.data;
            if ('ok' in result && result.ok && live.accountOnlyLifetime.isCurrent()) {
                acknowledgeWorkspaceFileWrites({ serverId: live.serverId, accountId: live.accountId, machineId, rootPath: request.rootPath },
                    result.results.filter(file => file.status === 'replaced').flatMap(file => file.renameTo
                        ? [{ path: file.path, hash: null }, { path: file.renameTo, hash: file.hash ?? null }]
                        : [{ path: file.path, hash: file.hash ?? null }]));
            }
            return result;
        });
    };
}
