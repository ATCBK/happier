import {
    type PromptAssetListTypesResponseV1,
    type PromptAssetDeleteRequest,
    type PromptAssetMutationResponseV1,
    type PromptAssetWriteRequest,
    PromptAssetDeleteRequestSchema,
    PromptAssetListTypesResponseV1Schema,
    PromptAssetMutationResponseV1Schema,
    PromptAssetWriteRequestSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolvePreferScopedMachineRpc } from '@/sync/domains/transfers/runtime/transferRuntime/routing/resolvePreferScopedMachineRpc';
import { throwUnsupportedMachineTransferResponse } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/throwUnsupportedMachineTransferResponse';

import {
    prepareBulkJsonPayloadForUpload,
    uploadBulkPayloadFromFileViaMachineCarrier,
    isTransferFinalizeRecoveryFailure,
    type TransferFinalizeRecoveryFailure,
} from '@/sync/domains/transfers/runtime/transferRuntime';

type MachinePromptAssetsOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
    signal?: AbortSignal;
}>;

export async function machinePromptAssetsListTypes(
    machineId: string,
    opts?: MachinePromptAssetsOpts,
): Promise<PromptAssetListTypesResponseV1> {
    const preferScoped = await resolvePreferScopedMachineRpc({ machineId, serverId: opts?.serverId, timeoutMs: opts?.timeoutMs ?? null });
    const response = await machineRpcWithServerScope<unknown, undefined>({ machineId, serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined, method: RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES, preferScoped, payload: undefined });
    const parsed = PromptAssetListTypesResponseV1Schema.safeParse(response);
    if (!parsed.success) throwUnsupportedMachineTransferResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES);
    return parsed.data;
}

export async function machinePromptAssetsWrite(
    machineId: string,
    input: PromptAssetWriteRequest,
    opts?: MachinePromptAssetsOpts,
): Promise<PromptAssetMutationResponseV1 | TransferFinalizeRecoveryFailure<PromptAssetMutationResponseV1>> {
    const payload = PromptAssetWriteRequestSchema.parse(input);
    const preparedPayload = prepareBulkJsonPayloadForUpload(payload);
    if (!preparedPayload.ok) return { ok: false, errorCode: 'invalid_request', error: preparedPayload.error };
    const result = await uploadBulkPayloadFromFileViaMachineCarrier<PromptAssetMutationResponseV1>({
        machineId, serverId: opts?.serverId,
        fileReader: { sizeBytes: preparedPayload.encodedPayload.byteLength,
            readBytes: async (offset, length) => preparedPayload.encodedPayload.subarray(offset, offset + length), close: async () => {} },
        directImportRequest: { t: 'prompt_asset_upload_v1', workingDirectory: '/', sizeBytes: preparedPayload.encodedPayload.byteLength },
        parseDirectFinalizeResponse: response => {
            const parsed = PromptAssetMutationResponseV1Schema.safeParse(response.finalized.result);
            return parsed.success ? parsed.data : null;
        }, timeoutMs: opts?.timeoutMs ?? null, signal: opts?.signal,
    });
    if ('ok' in result) return result;
    if (isTransferFinalizeRecoveryFailure<PromptAssetMutationResponseV1>(result)) return result;
    return { ok: false, errorCode: 'internal_error', error: result.error };
}

export async function machinePromptAssetsDelete(
    machineId: string,
    input: PromptAssetDeleteRequest,
    opts?: MachinePromptAssetsOpts,
): Promise<PromptAssetMutationResponseV1> {
    const payload = PromptAssetDeleteRequestSchema.parse(input);
    const preferScoped = await resolvePreferScopedMachineRpc({ machineId, serverId: opts?.serverId, timeoutMs: opts?.timeoutMs ?? null });
    const response = await machineRpcWithServerScope<unknown, PromptAssetDeleteRequest>({ machineId, serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined, method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE, preferScoped, payload });
    const parsed = PromptAssetMutationResponseV1Schema.safeParse(response);
    if (!parsed.success) throwUnsupportedMachineTransferResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE);
    return parsed.data;
}
