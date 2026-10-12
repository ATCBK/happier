import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';

type CallbackQueueFailure = Readonly<{
    code: 'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED' | 'PLUGIN_EXEC_CLIENT_CALLBACK_FAILED';
    cause?: unknown;
}>;

export type PluginProtocolCallbackQueue = Readonly<{
    enqueue(byteLength: number, callback: () => void | Promise<void>): boolean;
    drained(): Promise<void>;
}>;

export function createPluginProtocolCallbackQueue(params: Readonly<{
    maxPendingCallbacks?: number;
    maxPendingBytes?: number;
    onFailure(failure: CallbackQueueFailure): void;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>): PluginProtocolCallbackQueue {
    const maxPendingCallbacks = params.maxPendingCallbacks;
    const maxPendingBytes = params.maxPendingBytes;
    const recordRuntimeLimitMeasurement = params.recordRuntimeLimitMeasurement;
    let pendingCallbacks = 0;
    let pendingBytes = 0;
    let failed = false;
    let haltQueuedCallbacks = false;
    let tail = Promise.resolve();

    const fail = (failure: CallbackQueueFailure): void => {
        if (failed) return;
        failed = true;
        haltQueuedCallbacks = failure.code === 'PLUGIN_EXEC_CLIENT_CALLBACK_FAILED';
        try {
            params.onFailure(failure);
        } catch {
            // Failure reporting is a boundary callback and cannot escape the queue owner.
        }
    };

    return Object.freeze({
        enqueue(byteLength, callback) {
            const normalizedBytes = Math.max(0, Math.trunc(byteLength));
            if (failed) return false;
            if (
                (maxPendingCallbacks !== undefined && pendingCallbacks + 1 > maxPendingCallbacks)
                || (maxPendingBytes !== undefined && pendingBytes + normalizedBytes > maxPendingBytes)
            ) {
                recordRuntimeLimitMeasurement?.(Object.freeze({
                    family: 'plugin-protocol-callbacks',
                    queuedItems: pendingCallbacks + 1,
                    queuedBytes: pendingBytes + normalizedBytes,
                    backpressured: true,
                }));
                fail({ code: 'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED' });
                return false;
            }
            pendingCallbacks += 1;
            pendingBytes += normalizedBytes;
            recordRuntimeLimitMeasurement?.(Object.freeze({
                family: 'plugin-protocol-callbacks',
                queuedItems: pendingCallbacks,
                queuedBytes: pendingBytes,
                backpressured: false,
            }));
            tail = tail.then(async () => {
                if (!haltQueuedCallbacks) {
                    try {
                        await callback();
                    } catch (cause) {
                        fail({ code: 'PLUGIN_EXEC_CLIENT_CALLBACK_FAILED', cause });
                    }
                }
                pendingCallbacks -= 1;
                pendingBytes -= normalizedBytes;
            });
            return true;
        },
        drained: () => tail,
    });
}
