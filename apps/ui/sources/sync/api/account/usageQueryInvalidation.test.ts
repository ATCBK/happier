import { afterEach, expect, it, vi } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import { getUsageQueryMachineInvalidationKey, observeUsageProjection, subscribeUsageQueryStateInvalidation } from './usageQueryInvalidation';

afterEach(() => { vi.restoreAllMocks(); });

it.each(['presentation', 'read'] as const)('preserves a long %s deadline through the native timer boundary', async kind => {
    vi.useFakeTimers();
    const nativeMaximum = 2_147_483_647;
    const schedule = globalThis.setTimeout;
    // Node/browser timer overflow is an environment boundary, not a shorter owner deadline.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) =>
        schedule(callback, ms !== undefined && ms > nativeMaximum ? 1 : ms, ...args));
    const deadline = Date.now() + nativeMaximum + 100;
    let readDeadline = deadline;
    let reads = 0;
    let publications = 0;
    const observation = observeUsageProjection({
        serverId: 'long-usage-deadline.test', busy: () => false,
        read: async () => { reads++; if (reads > 1) readDeadline = Number.POSITIVE_INFINITY; },
        nextReadAtMs: () => kind === 'read' ? readDeadline : Number.POSITIVE_INFINITY,
        presentationDeadlineMs: () => kind === 'presentation' ? deadline : undefined,
        publish: () => { publications++; },
    });
    try {
        await vi.advanceTimersByTimeAsync(100);
        expect(reads).toBe(1);
        expect(publications).toBe(0);
        await vi.advanceTimersByTimeAsync(nativeMaximum - 100);
        expect(reads).toBe(1);
        expect(publications).toBe(0);
        await vi.advanceTimersByTimeAsync(100);
        expect(reads).toBe(kind === 'read' ? 2 : 1);
        expect(publications).toBe(kind === 'presentation' ? 1 : 0);
    } finally {
        observation.dispose();
        vi.restoreAllMocks();
        vi.useRealTimers();
    }
});

it('keeps presence heartbeats from changing the usage Resource machine invalidation key', () => {
    const scope = { serverId: 'usage-invalidation.test', accountId: 'account-a' };
    const machine = createMachineFixture({ id: 'machine', activeAt: 1_900_000_000_000, updatedAt: 1_900_000_000_000 });
    const key = getUsageQueryMachineInvalidationKey({ [machine.id]: machine }, machine.activeAt!, scope);
    expect(getUsageQueryMachineInvalidationKey({
        [machine.id]: { ...machine, activeAt: machine.activeAt! + 1, updatedAt: machine.updatedAt + 1 },
    }, machine.activeAt!, scope)).toBe(key);
    expect(getUsageQueryMachineInvalidationKey({
        [machine.id]: { ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed' } },
    }, machine.activeAt!, scope)).not.toBe(key);
    expect(getUsageQueryMachineInvalidationKey({
        [machine.id]: { ...machine, revokedAt: machine.activeAt },
    }, machine.activeAt!, scope)).not.toBe(key);
});

it('does not reread machine details for unrelated store notifications, but observes presence expiry', () => {
    let nowMs = 1_900_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const machine = createMachineFixture({ id: 'machine', activeAt: nowMs, updatedAt: nowMs });
    const metadata = machine.metadata;
    let detailReads = 0;
    Object.defineProperty(machine, 'metadata', { enumerable: true, get() { detailReads++; return metadata; } });
    const previousMachines = storage.getState().machines;
    const previousReady = storage.getState().isDataReady;
    const previousSettingsScope = storage.getState().settingsScope;
    const previousProfileScope = storage.getState().profileScope;
    storage.setState({ machines: { [machine.id]: machine }, profileScope: { serverId: 'usage-invalidation.test', accountId: 'account-a' } });
    let invalidated = false;
    const release = subscribeUsageQueryStateInvalidation(() => { invalidated = true; });
    try {
        detailReads = 0;
        for (let index = 0; index < 128; index++) storage.setState({ isDataReady: !storage.getState().isDataReady });
        const unrelatedDetailReads = detailReads;
        expect(invalidated).toBe(false);
        const deadline = readMachineStatusNextRefreshAtMs(machine, nowMs);
        if (deadline === null) throw new Error('Expected witnessed presence deadline');
        nowMs = deadline;
        storage.setState({ isDataReady: !storage.getState().isDataReady });
        expect(invalidated).toBe(true);
        expect(detailReads).toBeGreaterThan(unrelatedDetailReads);
        console.info(JSON.stringify({ unrelatedStoreRevisions: 128, unrelatedMachineDetailReads: unrelatedDetailReads, expiryDetailReads: detailReads - unrelatedDetailReads }));
        expect(unrelatedDetailReads).toBe(0);
        invalidated = false;
        nowMs = machine.activeAt!;
        storage.setState({ isDataReady: !storage.getState().isDataReady });
        expect(invalidated).toBe(true); // A backward clock can make the same rows online again.
        invalidated = false;
        storage.setState({ machines: { [machine.id]: { ...machine, activeAt: nowMs + 1, updatedAt: nowMs + 1 } } });
        expect(invalidated).toBe(false);
        const beforeScopeChange = detailReads;
        storage.setState({ settingsScope: { serverId: 'usage-invalidation.test', accountId: 'other-account' } });
        expect(invalidated).toBe(true);
        expect(detailReads).toBe(beforeScopeChange);
    } finally {
        release?.();
        storage.setState({ machines: previousMachines, isDataReady: previousReady, settingsScope: previousSettingsScope, profileScope: previousProfileScope });
    }
});
