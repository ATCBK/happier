import { afterEach, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionAgentTransitionSelectionV1 } from '@happier-dev/protocol/sessions/agentTransition';

const transport = vi.hoisted(() => ({ calls: [] as { signal?: AbortSignal; method: string }[] }));
// Transport is the external boundary; the hook and single/batch query adapters stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: { signal?: AbortSignal; method: string }) => {
        transport.calls.push(request);
        if (transport.calls.length === 1) return new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return Promise.resolve({ v: 1, inspections: [{ type: 'available', protocolVersion: 1, sameSessionTransition: true }] });
    },
}));

const { useSessionContinuationInspections } = await import('./useSessionContinuationInspections');
const selection: SessionAgentTransitionSelectionV1 = { v: 1, agentId: 'codex' };
afterEach(() => { standardCleanup(); transport.calls.length = 0; });

it('cancels an unanswered inspection when the picker closes and retries the same target when reopened', async () => {
    const hook = await renderHook((demanded: boolean) => useSessionContinuationInspections({
        demanded, sessionId: 'session-one', machine: { machineId: 'machine-one', serverId: 'home-one',
            connectionGeneration: 1, daemonGeneration: 1 },
        machinePresence: 'online', targetSelections: [selection],
    }), { initialProps: true });
    expect(hook.getCurrent().read(selection).status).toBe('checking');
    await hook.rerender(false);
    expect(transport.calls[0]?.signal?.aborted).toBe(true);
    await hook.rerender(true);
    expect(hook.getCurrent().read(selection)).toMatchObject({ status: 'answered', inspection: { type: 'available' } });
    await hook.unmount();
});
