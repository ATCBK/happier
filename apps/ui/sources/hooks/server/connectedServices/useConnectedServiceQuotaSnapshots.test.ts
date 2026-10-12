import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createDeferredResponse, createLegacyQuotaAuthWrapper, createLegacyQuotaTestHarness, makeQuotaSnapshot,
    plainQuotaResponse, resetConnectedServiceQuotaSnapshotsTestState, stableCredentials } from './useConnectedServiceQuotaSnapshots.testkit';

describe('useConnectedServiceQuotaSnapshots credential authority', () => {
    let boundary: Awaited<ReturnType<typeof createLegacyQuotaTestHarness>>;
    const Wrapper = createLegacyQuotaAuthWrapper(() => boundary);
    beforeEach(async () => { await resetConnectedServiceQuotaSnapshotsTestState(); boundary = await createLegacyQuotaTestHarness(); });
    afterEach(async () => { standardCleanup(); await boundary.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });

    it.each(['token', 'secret'] as const)('refetches and rejects an old in-flight read when %s changes', async field => {
        const held = createDeferredResponse();
        boundary.plainRead.mockImplementationOnce(() => held.promise);
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.plainRead).toHaveBeenCalledTimes(1);
        const nextCredentials = field === 'token'
            ? { ...stableCredentials, token: stableCredentials.token + '-renewed' }
            : { ...stableCredentials, secret: Buffer.from(new Uint8Array(32).fill(4)).toString('base64url') };
        const basis = getActiveServerSnapshot();
        // InjectedAuthProvider is the real controlled-credential boundary. Keep
        // Home generation fixed so reconnect invalidation cannot prove this test.
        boundary.account.credentials = nextCredentials;
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'new-credential' })));
        await hook.rerender(); await flushHookEffects({ cycles: 8, turns: 8 });
        expect(getActiveServerSnapshot()).toEqual(basis);
        expect(boundary.plainRead).toHaveBeenCalled();
        expect(new Headers(boundary.plainRead.mock.lastCall?.[1]?.headers).get('Authorization')).toBe(`Bearer ${nextCredentials.token}`);
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('new-credential');
        await act(async () => { held.resolve(plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'old-credential' }))); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('new-credential');
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
    });

    it('withdraws a cached snapshot in the first render after credential replacement', async () => {
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'old-account' })));
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const rendered: Array<string | null> = [];
        let capture = false;
        const hook = await renderHook(() => {
            const result = useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]);
            if (capture) rendered.push(result.snapshotsByKey['anthropic/work']?.meters[0]?.meterId ?? null);
            return result;
        }, { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('old-account');
        const held = createDeferredResponse();
        boundary.account.credentials = { ...stableCredentials, token: stableCredentials.token + '-new' };
        boundary.plainRead.mockImplementation(() => held.promise.then(response => response.clone())); capture = true;
        await hook.rerender();
        expect(rendered[0]).toBeNull();
        await act(async () => { held.resolve(plainQuotaResponse(null)); });
    });

    it('does not let an old account-mode response choose the endpoint of replacement credentials', async () => {
        const heldMode = createDeferredResponse();
        boundary.modeRead.mockImplementation(() => heldMode.promise.then(response => response.clone()));
        const basis = getActiveServerSnapshot();
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.modeRead).toHaveBeenCalled();
        expect(boundary.plainRead).not.toHaveBeenCalled();
        boundary.account.credentials = { ...stableCredentials, token: stableCredentials.token + '-new' };
        boundary.modeRead.mockImplementation(async () => Response.json({ mode: 'plain', updatedAt: 2 }));
        await hook.rerender(); await flushHookEffects({ cycles: 8, turns: 8 });
        expect(getActiveServerSnapshot()).toEqual(basis);
        expect(boundary.plainRead).toHaveBeenCalled();
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'anthropic', fetchedAt: Date.now() + 1 })));
        await act(async () => { heldMode.resolve(Response.json({ mode: 'e2ee', updatedAt: 1 })); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(boundary.sealedRead).not.toHaveBeenCalled();
    });

    it('treats a plaintext miss as authoritative without trying a sealed representation', async () => {
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(null));
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.plainRead).toHaveBeenCalledTimes(1);
        expect(boundary.sealedRead).not.toHaveBeenCalled();
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']).toBeNull();
        expect(hook.getCurrent().readByKey['anthropic/work']).toBe(true);
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
    });
});
