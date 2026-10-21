import {
    applySessionListRenderablePatch,
    areSessionListRenderablesEqual,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import {
    normalizeSessionAddress,
    sessionAddressKey,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

type SessionListRenderablePatch = Readonly<{
    address: SessionAddress;
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
}>;

export type SessionListRenderableProjectionPatchCoalescerConfig = Readonly<{
    enabled: boolean;
    windowMs: number;
    maxBatchSize: number;
}>;

type TimerHandle = ReturnType<typeof setTimeout>;

type QueueOptions = Readonly<{
    shouldContinue?: () => boolean;
    deferLeadingPatch?: boolean;
    forceImmediate?: boolean;
}>;

type QueuedProjectionPatch<Payload> = Readonly<{
    payload: Payload;
    shouldContinue: () => boolean;
}>;

type QueuedProjectionPatchTarget<Payload> = {
    address: SessionAddress;
    entries: QueuedProjectionPatch<Payload>[];
};

type QueuedProjectionPatchBatch<Payload> = ReadonlyArray<QueuedProjectionPatchTarget<Payload>>;

function clampPositiveInt(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(1, Math.trunc(value));
}

function countBatchEntries<Payload>(batch: QueuedProjectionPatchBatch<Payload>): number {
    return batch.reduce((total, target) => total + target.entries.length, 0);
}

export function createSessionListRenderableProjectionPatchCoalescer<Payload>(params: Readonly<{
    getConfig: () => SessionListRenderableProjectionPatchCoalescerConfig;
    readRenderable: (address: SessionAddress) => SessionListRenderableSession | undefined;
    buildPatch: (input: Readonly<{
        address: SessionAddress;
        renderable: SessionListRenderableSession;
        payload: Payload;
    }>) => Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
    applyPatches: (patches: SessionListRenderablePatch[]) => void;
}>): Readonly<{
    enqueue: (address: SessionAddress, payload: Payload, options?: QueueOptions) => void;
    flushAll: () => void;
    dropAddresses: (addresses: readonly SessionAddress[]) => void;
}> {
    const queuedByAddress = new Map<string, QueuedProjectionPatchTarget<Payload>>();
    const leadingWindowExpiresAtByAddress = new Map<string, number>();
    let timer: TimerHandle | null = null;

    function clearFlushTimer(): void {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
    }

    function scheduleFlush(windowMs: number): void {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            flushAll();
        }, windowMs);
    }

    function applyBatch(batch: QueuedProjectionPatchBatch<Payload>, eventName: string): void {
        if (batch.length === 0) return;

        const patches: SessionListRenderablePatch[] = [];
        for (const { address, entries } of batch) {
            const renderable = params.readRenderable(address);
            if (!renderable) continue;

            let simulatedRenderable = renderable;
            let hasPatch = false;
            for (const entry of entries) {
                if (!entry.shouldContinue()) continue;
                const patch = params.buildPatch({
                    address,
                    renderable: simulatedRenderable,
                    payload: entry.payload,
                });
                hasPatch = true;
                simulatedRenderable = applySessionListRenderablePatch(simulatedRenderable, patch);
            }

            if (hasPatch && !areSessionListRenderablesEqual(renderable, simulatedRenderable)) {
                const { id: _id, ...patch } = simulatedRenderable;
                patches.push({ address, patch });
            }
        }

        if (patches.length === 0) return;
        syncPerformanceTelemetry.measure(
            eventName,
            { sessions: patches.length, entries: countBatchEntries(batch) },
            () => params.applyPatches(patches),
        );
    }

    function upsertQueued(address: SessionAddress, entry: QueuedProjectionPatch<Payload>): void {
        const key = sessionAddressKey(address);
        const existing = queuedByAddress.get(key);
        if (existing) {
            existing.entries.push(entry);
            return;
        }
        queuedByAddress.set(key, { address, entries: [entry] });
    }

    function takeQueuedBatch(maxBatchSize: number): QueuedProjectionPatchTarget<Payload>[] {
        const batch: QueuedProjectionPatchTarget<Payload>[] = [];
        for (const [key, target] of queuedByAddress) {
            batch.push(target);
            queuedByAddress.delete(key);
            leadingWindowExpiresAtByAddress.delete(key);
            if (batch.length >= maxBatchSize) break;
        }
        return batch;
    }

    function takeQueuedAddressBatch(key: string): QueuedProjectionPatchTarget<Payload>[] {
        const target = queuedByAddress.get(key);
        if (!target) return [];
        queuedByAddress.delete(key);
        leadingWindowExpiresAtByAddress.delete(key);
        return [target];
    }

    function flushQueuedAddress(key: string): void {
        const batch = takeQueuedAddressBatch(key);
        if (batch.length === 0) return;
        applyBatch(batch, 'sync.socket.sessions.projectionPatch.coalesce.flush');
        if (queuedByAddress.size === 0) {
            clearFlushTimer();
        }
    }

    function flushAll(): void {
        clearFlushTimer();
        leadingWindowExpiresAtByAddress.clear();
        const maxBatchSize = clampPositiveInt(params.getConfig().maxBatchSize);
        while (queuedByAddress.size > 0) {
            applyBatch(takeQueuedBatch(maxBatchSize), 'sync.socket.sessions.projectionPatch.coalesce.flush');
        }
    }

    function dropAddresses(addresses: readonly SessionAddress[]): void {
        if (addresses.length === 0) return;

        let dropped = 0;
        for (const address of addresses) {
            const normalizedAddress = normalizeSessionAddress(address.serverId, address.sessionId);
            if (!normalizedAddress) continue;
            const key = sessionAddressKey(normalizedAddress);
            leadingWindowExpiresAtByAddress.delete(key);
            const target = queuedByAddress.get(key);
            if (!target) continue;
            dropped += target.entries.length;
            queuedByAddress.delete(key);
        }

        if (dropped > 0) {
            syncPerformanceTelemetry.count('sync.socket.sessions.projectionPatch.coalesce.dropped', {
                entries: dropped,
                queuedSessions: queuedByAddress.size,
            });
        }
        if (queuedByAddress.size === 0) {
            clearFlushTimer();
        }
    }

    function enqueue(address: SessionAddress, payload: Payload, options?: QueueOptions): void {
        const normalizedAddress = normalizeSessionAddress(address.serverId, address.sessionId);
        if (!normalizedAddress) return;
        const key = sessionAddressKey(normalizedAddress);

        const config = params.getConfig();
        const maxBatchSize = clampPositiveInt(config.maxBatchSize);
        const windowMs = Math.max(0, Math.trunc(config.windowMs));
        const entry: QueuedProjectionPatch<Payload> = {
            payload,
            shouldContinue: options?.shouldContinue ?? (() => true),
        };
        syncPerformanceTelemetry.count('sync.socket.sessions.projectionPatch.coalesce.enqueue', {
            sessions: 1,
            entries: 1,
            windowMs,
            maxBatchSize,
        });

        if (!config.enabled || windowMs <= 0) {
            applyBatch([{ address: normalizedAddress, entries: [entry] }], 'sync.socket.sessions.projectionPatch.coalesce.immediate');
            return;
        }

        const nowMs = Date.now();
        if (options?.forceImmediate === true) {
            flushQueuedAddress(key);
            leadingWindowExpiresAtByAddress.set(key, nowMs + windowMs);
            applyBatch([{ address: normalizedAddress, entries: [entry] }], 'sync.socket.sessions.projectionPatch.coalesce.immediate');
            return;
        }

        const leadingWindowExpiresAt = leadingWindowExpiresAtByAddress.get(key) ?? 0;
        const isInsideLeadingWindow = leadingWindowExpiresAt > nowMs;
        if (!isInsideLeadingWindow) {
            leadingWindowExpiresAtByAddress.set(key, nowMs + windowMs);
            if (options?.deferLeadingPatch === true) {
                upsertQueued(normalizedAddress, entry);
                syncPerformanceTelemetry.count('sync.socket.sessions.projectionPatch.coalesce.queued', {
                    sessions: queuedByAddress.size,
                    entries: Array.from(queuedByAddress.values()).reduce((total, target) => total + target.entries.length, 0),
                    windowMs,
                    maxBatchSize,
                });
                scheduleFlush(windowMs);
                return;
            }
            applyBatch([{ address: normalizedAddress, entries: [entry] }], 'sync.socket.sessions.projectionPatch.coalesce.immediate');
            return;
        }

        upsertQueued(normalizedAddress, entry);
        syncPerformanceTelemetry.count('sync.socket.sessions.projectionPatch.coalesce.queued', {
            sessions: queuedByAddress.size,
            entries: Array.from(queuedByAddress.values()).reduce((total, target) => total + target.entries.length, 0),
            windowMs,
            maxBatchSize,
        });

        if (queuedByAddress.size >= maxBatchSize) {
            applyBatch(takeQueuedBatch(maxBatchSize), 'sync.socket.sessions.projectionPatch.coalesce.flush');
        }

        if (queuedByAddress.size > 0) {
            scheduleFlush(windowMs);
        }
    }

    return {
        enqueue,
        flushAll,
        dropAddresses,
    };
}
