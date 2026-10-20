import { queryCodeIntelligenceFallback, type CodeIntelligenceFallbackInput, type CodeIntelligenceFallbackResult } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import { machineWorkspaceFileSearch } from './machineWorkspaceFileSearch';
import {
    DaemonLspSyncRequestSchema, DaemonLspSyncResponseSchema,
    DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema,
    DaemonLspWatchRequestSchema, DaemonLspWatchResponseSchema,
    DaemonLspRestartRequestSchema, DaemonLspRestartResponseSchema,
    type LanguageIntelligenceSyncInput, type LanguageIntelligenceSyncResult,
    type LanguageIntelligenceQueryInput, type LanguageIntelligenceQueryResult,
    type LanguageIntelligenceWatchInput, type LanguageIntelligenceWatchResult,
    type LanguageIntelligenceRestartInput, type LanguageIntelligenceRestartResult,
} from '@happier-dev/protocol/machines/languageIntelligence';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { classifyWorkspaceFileRpcError } from './machineWorkspaceFileRpcError';

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
