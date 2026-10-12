import { afterEach, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { resolveTransferPolicyAllowsMachineRpcDirect } = await import('./guardedMachineRpcPolicy');

afterEach(async () => {
    vi.useRealTimers();
    await home.reset();
});

it('accepts transfer readiness after 500ms while the caller still has time', async () => {
    const serverId = await home.addHome({ name: 'Transfer Home', serverUrl: 'https://transfer.example.test' });
    let respond!: () => void;
    const respondAfter = new Promise<void>((resolve) => { respond = resolve; });
    home.answer(serverId, '/v1/features', {
        respondAfter,
        body: createRootLayoutFeaturesResponse({ features: { machines: { transfer: {
            enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true },
        } } } }),
    });
    vi.useFakeTimers();
    const pending = resolveTransferPolicyAllowsMachineRpcDirect({ serverId, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(600);
    respond();
    await expect(pending).resolves.toBe(true);
});

it('fails closed when the caller deadline expires before feature readiness', async () => {
    const serverId = await home.addHome({ name: 'Transfer Home', serverUrl: 'https://transfer-deadline.example.test' });
    let respond!: () => void;
    const respondAfter = new Promise<void>((resolve) => { respond = resolve; });
    home.answer(serverId, '/v1/features', { respondAfter, body: createRootLayoutFeaturesResponse() });
    vi.useFakeTimers();
    let outcome: boolean | undefined;
    const pending = resolveTransferPolicyAllowsMachineRpcDirect({ serverId, timeoutMs: 100 })
        .then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(100);
    respond();
    expect(outcome).toBe(false);
    await pending;
});
