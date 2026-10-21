import type { machinePluginUiResourceWatchNext, MachinePluginUiResourceWatchNextResult } from '@/sync/ops/machineContributionRegistryProjection';

/** A live daemon long poll stays open until its owning mount cancels it. */
export async function parkPluginResourceWatchUntilAbort(
    _machineId: unknown,
    rawRequest: unknown,
): Promise<MachinePluginUiResourceWatchNextResult> {
    // The transport mock receives the process-local cancellation port beside the wire request.
    const { signal } = rawRequest as Parameters<typeof machinePluginUiResourceWatchNext>[1];
    if (!signal) throw new Error('Expected a Resource watch cancellation signal');
    await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { supported: true, result: { ok: true, status: 'idle' } };
}
