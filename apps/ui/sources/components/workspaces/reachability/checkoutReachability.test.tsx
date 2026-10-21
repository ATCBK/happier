import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
const serverId = 'srv_checkout_reachability';
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { useCheckoutReachability } = await import('./checkoutReachability');
const { t } = await import('@/text');

beforeEach(async () => {
    await home.reset();
    await home.addHome({ name: 'Reachability Home', serverUrl: 'https://reachability.example.test',
        serverIdentityId: serverId, accountId: 'account-a' });
});

afterEach(async () => {
    standardCleanup();
    await home.reset();
});

describe('checkout reachability', () => {
    it('names the Machine in its sentences only once its name is known', async () => {
        // A Machine whose details are still loading has a placeholder title, never a name for a sentence
        // ("Reading it from Loading…"): the sentence says "this machine" until the name arrives.
        const named = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.getState().applyMachines([{ ...named, metadata: null, availability: undefined }], true, { sourceServerId: serverId });
        const hook = await renderHook(() => useCheckoutReachability({ serverId, machineId: 'machine' }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().machineName).not.toBe('machine'));
            expect(hook.getCurrent().machineName).toBe(t('machine.thisMachineInSentence'));
            storage.getState().applyMachines([{ ...named, metadata: { ...named.metadata!, displayName: 'Build box' } }], true, { sourceServerId: serverId });
            await waitForHomeGovernance(() => expect(hook.getCurrent().machineName).toBe('Build box'));
        } finally { await hook.unmount(); }
    });
});
