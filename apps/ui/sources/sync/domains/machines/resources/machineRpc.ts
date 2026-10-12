import {
    MachineVitalsGetInputV1Schema,
    MachineVitalsHistoryGetInputV1Schema,
    MachineVitalsSnapshotV1Schema,
    MachineVitalsWatchInputV1Schema,
    MachineVitalsWatchResultV1Schema,
    type MachineVitalsSnapshotV1,
    type MachineVitalsWatchResultV1,
} from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { MachineVitalsHistoryV1Schema, type MachineVitalsHistoryV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import { MACHINE_WATCH_WINDOW_MS } from '@happier-dev/protocol/rpc/machineWatchWindow';
import { createRpcCallError, readRpcErrorCode, isRpcMethodNotAvailableError, isRpcMethodNotFoundError, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { MachineVitalsActionId } from '@happier-dev/protocol/actions/specs/machineVitals';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type MachineResourceKey = Readonly<{ machineId: string; serverId?: string | null; daemonStateVersion?: number | null }>;
export type MachineVitalsView = 'summary' | 'overview';
export type MachineVitalsRange = MachineVitalsHistoryV1['range'];
export type MachineVitalsReadInput = MachineResourceKey & Readonly<{ view: MachineVitalsView; signal?: AbortSignal }>;
export type MachineVitalsHistoryReadInput = MachineResourceKey & Readonly<{ range: MachineVitalsRange; signal?: AbortSignal }>;
export type MachineVitalsWatchInput = MachineVitalsReadInput & Readonly<{ sinceSampledAt?: number }>;
export type MachineResourceRpcResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: 'older_happier' | 'request_failed' | 'invalid_response' }>;

let actionExecute: FrontDoorActionExecute | undefined;
async function execute(input: MachineResourceKey & Readonly<{ signal?: AbortSignal }>, actionId: MachineVitalsActionId, payload: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (!actionExecute) actionExecute = (await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')).createFrontDoorActionExecute();
    const outcome = await actionExecute(actionId, { ...payload, ...(input.serverId ? { serverId: input.serverId } : {}) }, {
        surface: 'ui', ...(input.serverId ? { serverId: input.serverId } : {}), ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!outcome.ok) throw createRpcCallError({ error: outcome.error, errorCode: outcome.errorCode });
    return outcome.result;
}

async function read<T>(input: MachineResourceKey & Readonly<{ signal?: AbortSignal }>, request: () => Promise<unknown>, parse: (raw: unknown) => { success: true; data: T } | { success: false }): Promise<MachineResourceRpcResult<T>> {
    if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
    try {
        const raw = await request();
        if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
        if (isRpcMethodNotFoundResult(raw)) return { ok: false, reason: 'older_happier' };
        const parsed = parse(raw);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return { ok: false, reason: isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error) ? 'older_happier'
            : readRpcErrorCode(error) === 'invalid_action_output' ? 'invalid_response' : 'request_failed' };
    }
}

export function fetchMachineVitalsViaMachineRpc(input: MachineVitalsReadInput): Promise<MachineResourceRpcResult<MachineVitalsSnapshotV1>> {
    const payload = MachineVitalsGetInputV1Schema.parse({ machineId: input.machineId, view: input.view });
    return read(input, () => execute(input, 'machines.vitals.get', payload), (raw) => MachineVitalsSnapshotV1Schema.safeParse(raw));
}

export function watchMachineVitalsViaMachineRpc(input: MachineVitalsWatchInput): Promise<MachineResourceRpcResult<MachineVitalsWatchResultV1>> {
    const payload = MachineVitalsWatchInputV1Schema.parse({ machineId: input.machineId, view: input.view,
        ...(input.sinceSampledAt === undefined ? {} : { sinceSampledAt: input.sinceSampledAt }) });
    return read(input, () => machineRpcWithServerScope({ machineId: input.machineId, serverId: input.serverId,
        method: RPC_METHODS.DAEMON_VITALS_WATCH, payload, ...(input.signal ? { signal: input.signal } : {}),
        // The retained watch is transport demand, with its existing parking margin.
        timeoutMs: MACHINE_WATCH_WINDOW_MS + 10_000 }), (raw) => MachineVitalsWatchResultV1Schema.safeParse(raw));
}

export function fetchMachineVitalsHistoryViaMachineRpc(input: MachineVitalsHistoryReadInput): Promise<MachineResourceRpcResult<MachineVitalsHistoryV1>> {
    const payload = MachineVitalsHistoryGetInputV1Schema.parse({ machineId: input.machineId, range: input.range });
    return read(input, () => execute(input, 'machines.vitals.history.get', payload), (raw) => MachineVitalsHistoryV1Schema.safeParse(raw));
}
