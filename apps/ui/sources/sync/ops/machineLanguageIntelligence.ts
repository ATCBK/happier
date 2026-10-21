import { queryCodeIntelligenceFallback, type CodeIntelligenceFallbackInput, type CodeIntelligenceFallbackResult } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import { machineWorkspaceFileSearch } from './machineWorkspaceFileSearch';
import {
    DaemonLspSyncRequestSchema, DaemonLspSyncResponseSchema,
    DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema,
    DaemonLspWatchRequestSchema, DaemonLspWatchResponseSchema,
    DaemonLspRestartRequestSchema, DaemonLspRestartResponseSchema,
    DaemonLspApplyRequestSchema, DaemonLspApplyResponseSchema, type DaemonLspApplyRequest, type DaemonLspApplyResponse,
    type LanguageIntelligenceSyncInput, type LanguageIntelligenceSyncResult,
    type LanguageIntelligenceQueryInput, type LanguageIntelligenceQueryResult,
    type LanguageIntelligenceWatchInput, type LanguageIntelligenceWatchResult,
    type LanguageIntelligenceRestartInput, type LanguageIntelligenceRestartResult,
} from '@happier-dev/protocol/machines/languageIntelligence';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { classifyWorkspaceFileRpcError } from './machineWorkspaceFileRpcError';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { acknowledgeWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';

export type MachineLanguageIntelligenceOptions = Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal }>;
type Unavailable = Extract<LanguageIntelligenceQueryResult, { status: 'unavailable' }>;
async function callLanguageIntelligence<Input, Result>(
    machineId: string, method: string, input: Input,
    requestSchema: Readonly<{ parse: (value: unknown) => Input }>,
    responseSchema: Readonly<{ safeParse: (value: unknown) => { success: true; data: Result } | { success: false } }>,
    options?: MachineLanguageIntelligenceOptions,
): Promise<Result | Unavailable> {
    const payload = requestSchema.parse(input);
    try {
        const response = await machineRpcWithServerScope<unknown, Input>({ machineId, method, payload,
            serverId: options?.serverId ?? null, accountId: options?.accountId ?? null, operationTimeoutMs: null,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        const parsed = responseSchema.safeParse(response);
        return parsed.success ? parsed.data : { status: 'unavailable', reason: 'invalid_response' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return { status: 'unavailable', reason: classifyWorkspaceFileRpcError(error) === 'method_unavailable' ? 'update_required' : 'transport_failed' };
    }
}
export function machineLanguageIntelligenceSync(machineId: string, input: LanguageIntelligenceSyncInput, options?: MachineLanguageIntelligenceOptions): Promise<LanguageIntelligenceSyncResult> {
    return callLanguageIntelligence(machineId, RPC_METHODS.DAEMON_LSP_SYNC, input, DaemonLspSyncRequestSchema, DaemonLspSyncResponseSchema, options);
}
export function machineLanguageIntelligenceQuery(machineId: string, input: LanguageIntelligenceQueryInput, options?: MachineLanguageIntelligenceOptions): Promise<LanguageIntelligenceQueryResult> {
    return callLanguageIntelligence(machineId, RPC_METHODS.DAEMON_LSP_QUERY, input, DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema, options);
}
export function machineLanguageIntelligenceWatch(machineId: string, input: LanguageIntelligenceWatchInput, options?: MachineLanguageIntelligenceOptions): Promise<LanguageIntelligenceWatchResult> {
    return callLanguageIntelligence(machineId, RPC_METHODS.DAEMON_LSP_WATCH, input, DaemonLspWatchRequestSchema, DaemonLspWatchResponseSchema, options);
}
export function machineLanguageIntelligenceRestart(machineId: string, input: LanguageIntelligenceRestartInput, options?: MachineLanguageIntelligenceOptions): Promise<LanguageIntelligenceRestartResult> {
    return callLanguageIntelligence(machineId, RPC_METHODS.DAEMON_LSP_RESTART, input, DaemonLspRestartRequestSchema, DaemonLspRestartResponseSchema, options);
}
export async function machineLanguageIntelligenceApply(machineId: string, input: DaemonLspApplyRequest, options?: MachineLanguageIntelligenceOptions): Promise<DaemonLspApplyResponse> {
    const payload = DaemonLspApplyRequestSchema.parse(input);
    const method = payload.operation.kind === 'rename' ? RPC_METHODS.DAEMON_LSP_RENAME_APPLY
        : payload.operation.kind === 'fileRename' ? RPC_METHODS.DAEMON_LSP_FILE_RENAME_APPLY : RPC_METHODS.DAEMON_LSP_CODE_ACTION_APPLY;
    try {
        const raw = await machineRpcWithServerScope<unknown, DaemonLspApplyRequest>({ machineId, method, payload,
            serverId: options?.serverId ?? null, accountId: options?.accountId ?? null, operationTimeoutMs: null,
            waitForResultOnCancel: true, ...(options?.signal ? { signal: options.signal } : {}),
        });
        const parsed = DaemonLspApplyResponseSchema.safeParse(raw);
        if (!parsed.success) return { status: 'unavailable', reason: 'invalid_response' };
        const result = parsed.data, account = createServerAccountScope(options?.serverId, options?.accountId);
        if ('ok' in result && result.ok && account) acknowledgeWorkspaceFileWrites({ ...account, machineId, rootPath: payload.rootPath },
            result.results.filter(file => file.status === 'replaced').flatMap(file => file.renameTo
                ? [{ path: file.path, hash: null }, { path: file.renameTo, hash: file.hash ?? null }]
                : [{ path: file.path, hash: file.hash ?? null }]));
        return result;
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return { status: 'unavailable', reason: classifyWorkspaceFileRpcError(error) === 'method_unavailable' ? 'update_required' : 'transport_failed' };
    }
}

/** File-page commands and tree rename re-enter the same present-user Action owner. */
export async function machineLanguageIntelligenceApplyAction(machineId: string, input: DaemonLspApplyRequest, options?: MachineLanguageIntelligenceOptions): Promise<DaemonLspApplyResponse> {
    const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
    const actionId = input.operation.kind === 'rename' ? 'code.rename.apply' : input.operation.kind === 'fileRename' ? 'code.file.rename.apply' : 'code.codeAction.apply';
    const actionInput = input.operation.kind === 'codeAction' ? { machineId, ...input }
        : { machineId, rootPath: input.rootPath, path: input.path, ...(input.languageId ? { languageId: input.languageId } : {}), files: input.operation.files };
    const response = await createDefaultActionExecutor().execute(actionId, actionInput, {
        surface: 'ui', authority: 'present_user', ...(options?.serverId ? { serverId: options.serverId } : {}),
        ...(options?.accountId ? { expectedAccountId: options.accountId } : {}), ...(options?.signal ? { signal: options.signal } : {}),
    });
    return response.ok ? DaemonLspApplyResponseSchema.parse(response.result) : { status: 'unavailable', reason: 'session_unavailable' };
}
/** Present-user restart always re-enters the canonical Action admission owner. */
export async function machineLanguageIntelligenceRestartAction(machineId: string, input: LanguageIntelligenceRestartInput, options?: MachineLanguageIntelligenceOptions): Promise<LanguageIntelligenceRestartResult> {
    const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
    const response = await createDefaultActionExecutor().execute('code.restart', { machineId, ...input }, {
        surface: 'ui', authority: 'present_user', ...(options?.serverId ? { serverId: options.serverId } : {}),
        ...(options?.accountId ? { expectedAccountId: options.accountId } : {}), ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) return { status: 'unavailable', reason: response.errorCode === 'update_required' ? 'update_required' : 'session_unavailable' };
    const parsed = DaemonLspRestartResponseSchema.safeParse(response.result);
    return parsed.success ? parsed.data : { status: 'unavailable', reason: 'invalid_response' };
}

export async function machineCodeIntelligenceFallback(
    machineId: string,
    input: CodeIntelligenceFallbackInput,
    options?: Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal }>,
): Promise<CodeIntelligenceFallbackResult> {
    return queryCodeIntelligenceFallback(input, request => machineWorkspaceFileSearch(machineId, request, options));
}
