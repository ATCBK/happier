import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAccountUsageSnapshotV1Schema, buildProviderAccountUsageRecordId } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { storage } from '@/sync/domains/state/storageStore';
import { getProviderAccountUsageCacheState, subscribeProviderAccountUsageCache } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { computeConnectedServiceQuotaErrorBackoffMs } from '@/sync/domains/connectedServices/connectedServiceQuotaErrorBackoff';
import { createQualifiedQuotaTestHarness, quotaTestProviderUsageSnapshot, quotaTestProviderUsageResponse } from './qualifiedConnectedAccountQuotaTestHarness';
import { useProviderAccountUsageSnapshots } from './useProviderAccountUsageSnapshots';

const runtime = vi.hoisted(() => ({ active: true, listeners: new Set<() => void>() }));
// Visibility is an environment boundary. Auth, Home, mode, features, cache and opening remain real.
vi.mock('@/utils/runtime/isRuntimeActive', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/runtime/isRuntimeActive')>(),
    isRuntimeActive: () => runtime.active,
    subscribeToRuntimeActiveChange: (listener: () => void) => {
        runtime.listeners.add(listener); return () => runtime.listeners.delete(listener);
    },
}));
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
installDisconnectedServerSocketBoundary();

function makeUsageSnapshot(subject = 'provider-work') {
    const base = quotaTestProviderUsageSnapshot();
    const recordKey = { ...base.recordKey, accountSubjectId: subject };
    return ProviderAccountUsageSnapshotV1Schema.parse({ ...base, recordKey, recordId: buildProviderAccountUsageRecordId(recordKey),
        accountSubject: { kind: 'providerSubject', id: subject } });
}

describe('useProviderAccountUsageSnapshots', () => {
    let boundary: Awaited<ReturnType<typeof createQualifiedQuotaTestHarness>>;
    function Wrapper({ children }: React.PropsWithChildren) {
        return React.createElement(InjectedAuthProvider, { credentials: boundary.account.credentials, children });
    }
    async function installFeatures() {
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: boundary.account.home.serverIdentityId! },
            connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } },
        } });
        boundary.features.mockImplementation(async () => Response.json(features));
        primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: { status: 'ready', features } });
        storage.getState().applySettingsLocal({ featureToggles: { connectedServices: true, 'connectedServices.quotas': true } });
        await updateEffectiveHomeViewState(current => ({ ...current, activeTargetKind: 'server',
            activeTargetId: getActiveServerSnapshot().serverId }), { scope: 'device' });
    }
    function wake() { publishHomeAccountChange(getActiveServerSnapshot().serverId,
        [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }); }
    async function active(value: boolean) {
        await act(async () => { runtime.active = value; for (const listener of [...runtime.listeners]) listener(); });
        await flushHookEffects({ cycles: 8, turns: 8 });
    }
    beforeEach(async () => {
        standardCleanup(); runtime.active = true; resetServerFeaturesClientForTests();
        boundary = await createQualifiedQuotaTestHarness(); await installFeatures();
    });
    afterEach(async () => {
        standardCleanup(); await boundary.dispose(); resetServerFeaturesClientForTests();
        vi.useRealTimers(); vi.restoreAllMocks();
    });

    it('parks background readers and immediately refreshes retained data on foreground return', async () => {
        vi.useFakeTimers(); runtime.active = false;
        const snapshot = makeUsageSnapshot();
        boundary.usageRead.mockImplementation(async () => Response.json(quotaTestProviderUsageResponse(snapshot)));
        const hook = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(boundary.usageRead).not.toHaveBeenCalled();
        await active(true);
        expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]).toEqual(snapshot);
        await active(false);
        const refreshed = { ...snapshot, observedAtMs: Date.now(), fetchedAtMs: Date.now() };
        boundary.usageRead.mockImplementation(async () => Response.json(quotaTestProviderUsageResponse(refreshed)));
        await active(true);
        expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]).toEqual(refreshed);
        expect(boundary.usageRead).toHaveBeenCalledTimes(2);
        await hook.unmount();
        await active(false); await active(true);
        await act(async () => { wake(); await vi.advanceTimersByTimeAsync(120_000); });
        expect(boundary.usageRead).toHaveBeenCalledTimes(2);
    });

    it('loads canonical usage by record id without exposing connected-service quota projections', async () => {
        const snapshot = makeUsageSnapshot();
        boundary.usageRead.mockImplementation(async () => Response.json(quotaTestProviderUsageResponse(snapshot)));
        const hook = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]).toEqual(snapshot);
        expect(hook.getCurrent().stateByRecordId[snapshot.recordId]).toBe('loaded_data');
        expect('connectedServiceSnapshotsByKey' in hook.getCurrent()).toBe(false);
        expect(boundary.usageRead).toHaveBeenCalledWith(snapshot.recordId);
    });

    it('treats a plaintext miss as authoritative without another representation read', async () => {
        const snapshot = makeUsageSnapshot();
        boundary.usageRead.mockImplementation(async () => new Response('{}', { status: 404 }));
        const hook = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.usageRead).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]).toBeNull();
        expect(hook.getCurrent().loadingByRecordId[snapshot.recordId]).toBe(false);
    });

    it.each([false, true])('does not commit a held response after Home/generation replacement (same Home: %s)', async sameHome => {
        const snapshot = makeUsageSnapshot();
        let finishOld!: () => void;
        boundary.usageRead.mockImplementationOnce(() => new Promise<Response>(resolve => {
            finishOld = () => resolve(Response.json(quotaTestProviderUsageResponse(snapshot)));
        }));
        const hook = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        const oldBasis = getActiveServerSnapshot();
        const oldIdentity = boundary.account.home.serverIdentityId!;
        const oldUrl = boundary.account.home.serverUrl;
        const updated = { ...snapshot, meters: [{ ...snapshot.meters[0]!, used: 50 }] };
        await act(async () => {
            await boundary.dispose();
            boundary = await createQualifiedQuotaTestHarness({ serverUrl: sameHome ? oldUrl : 'https://provider-usage-replacement.test',
                serverIdentityId: sameHome ? oldIdentity : 'srv_provider_usage_replacement' });
            await installFeatures();
            boundary.usageRead.mockImplementation(async () => Response.json(quotaTestProviderUsageResponse(updated)));
        });
        expect(getActiveServerSnapshot().generation).not.toBe(oldBasis.generation);
        await hook.rerender(); await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]?.meters[0]?.used).toBe(50);
        await act(async () => { finishOld(); }); await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]?.meters[0]?.used).toBe(50);
    });

    it('settles every failed record, retains last-known-good, and retries on the shared error deadline', async () => {
        vi.useFakeTimers();
        const first = makeUsageSnapshot('first'), second = makeUsageSnapshot('second');
        const rows = new Map([first, second].map(snapshot => [snapshot.recordId, snapshot]));
        let failing = false;
        boundary.usageRead.mockImplementation(async recordId => failing ? new Response('{}', { status: 400 })
            : Response.json(quotaTestProviderUsageResponse(rows.get(recordId)!)));
        const hook = await renderHook(() => useProviderAccountUsageSnapshots([first.recordId, second.recordId]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        failing = true; await act(async () => { wake(); }); await flushHookEffects({ cycles: 8, turns: 8 });
        for (const snapshot of rows.values()) {
            expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]).toEqual(snapshot);
            expect(hook.getCurrent().stateByRecordId[snapshot.recordId]).toBe('error_last_known_good');
            expect(hook.getCurrent().loadingByRecordId[snapshot.recordId]).toBe(false);
        }
        failing = false;
        await act(async () => { await vi.advanceTimersByTimeAsync(computeConnectedServiceQuotaErrorBackoffMs(1)); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.usageRead).toHaveBeenCalledTimes(6);
        expect(hook.getCurrent().stateByRecordId[first.recordId]).toBe('loaded_data');
    });

    it('serves cache-only demand without acquiring and shares acquisition until the final observing reader releases', async () => {
        const snapshot = makeUsageSnapshot();
        boundary.usageRead.mockImplementation(async () => Response.json(quotaTestProviderUsageResponse(snapshot)));
        const loader = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]), { wrapper: Wrapper });
        const sibling = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]), { wrapper: Wrapper });
        const cached = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId], { fetchPolicy: 'cache_only' }), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 }); expect(boundary.usageRead).toHaveBeenCalledTimes(1);
        await loader.unmount(); await act(async () => { wake(); }); await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.usageRead).toHaveBeenCalledTimes(2);
        await sibling.unmount(); await act(async () => { wake(); }); await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.usageRead).toHaveBeenCalledTimes(2);
        expect(cached.getCurrent().snapshotsByRecordId[snapshot.recordId]).toEqual(snapshot);
        await cached.unmount(); expect(getProviderAccountUsageCacheState().entriesByCredentialScope).toEqual({});
    });

    it('batches records settled in the same turn into one cache publication', async () => {
        const first = makeUsageSnapshot('first'), second = makeUsageSnapshot('second');
        const releases = new Map<string, () => void>();
        boundary.usageRead.mockImplementation(recordId => new Promise<Response>(resolve => {
            releases.set(recordId, () => resolve(Response.json(quotaTestProviderUsageResponse(recordId === first.recordId ? first : second))));
        }));
        const hook = await renderHook(() => useProviderAccountUsageSnapshots([first.recordId, second.recordId]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        const listener = vi.fn(); const release = subscribeProviderAccountUsageCache(listener);
        await act(async () => { for (const finish of releases.values()) finish(); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().snapshotsByRecordId[first.recordId]).toEqual(first);
        expect(hook.getCurrent().snapshotsByRecordId[second.recordId]).toEqual(second);
        release();
    });

    it('publishes a fast record while a slower sibling remains loading', async () => {
        const fast = makeUsageSnapshot('fast'), slow = makeUsageSnapshot('slow');
        let finishSlow!: () => void;
        boundary.usageRead.mockImplementation(async recordId => recordId === fast.recordId
            ? Response.json(quotaTestProviderUsageResponse(fast)) : new Promise<Response>(resolve => {
                finishSlow = () => resolve(Response.json(quotaTestProviderUsageResponse(slow)));
            }));
        const hook = await renderHook(() => useProviderAccountUsageSnapshots([fast.recordId, slow.recordId]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByRecordId[fast.recordId]).toEqual(fast);
        expect(hook.getCurrent().loadingByRecordId[slow.recordId]).toBe(true);
        await act(async () => { finishSlow(); }); await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByRecordId[slow.recordId]).toEqual(slow);
    });
});
