import { downloadBulkJsonPayloadViaDirectExport } from '../plumbing/directTransferExportDownload';
import { resolveMachineCarrierRoute } from '../plumbing/machineCarrierHttpLease';

type DirectExportDownloadParams = Parameters<typeof downloadBulkJsonPayloadViaDirectExport>[0];
type DirectExportRequest = DirectExportDownloadParams['request'];

type MachineJsonCarrierDownloadParams<TPayload> = Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number;
    parsePayload: (value: unknown) => TPayload | null;
    signal?: AbortSignal | null;
}>;

/** Downloads one JSON payload through the canonical prepared Machine carrier. */
export async function downloadJsonPayloadViaMachineCarrier<
    TPayload,
    TDirectExportRequest extends DirectExportRequest,
>(
    params: MachineJsonCarrierDownloadParams<TPayload> & Readonly<{
        directExportRequest: TDirectExportRequest;
    }>,
) {
    if (params.signal?.aborted) {
        return { ok: false as const, error: 'Download canceled' };
    }

    const machineRoute = await resolveMachineCarrierRoute(params.machineId, params.serverId);
    if (machineRoute.kind === 'unavailable') {
        return {
            ok: false as const,
            error: machineRoute.error,
            errorCode: machineRoute.errorCode,
        };
    }

    return await downloadBulkJsonPayloadViaDirectExport({
        machineId: params.machineId,
        serverId: machineRoute.serverId,
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        request: params.directExportRequest,
        parsePayload: params.parsePayload,
        signal: params.signal ?? null,
        acquirePreparedCarrier: async ({ operationId }) => await machineRoute.acquire({
            operationId,
            signal: params.signal ?? undefined,
        }),
    });
}
