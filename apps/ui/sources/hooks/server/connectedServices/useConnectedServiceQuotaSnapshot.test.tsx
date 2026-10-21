import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceQuotaSnapshotV1Schema, ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema,
    ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema, RPC_METHODS } from '@happier-dev/protocol';
import { createMachineFixture, createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createLegacyQuotaAuthWrapper, createLegacyQuotaTestHarness, plainQuotaResponse,
    resetConnectedServiceQuotaSnapshotsTestState } from './useConnectedServiceQuotaSnapshots.testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

function quotaSnapshot(fetchedAt = 1_000) {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt, staleAfterMs: 60_000,
        planLabel: null, accountLabel: null, meters: [],
        recoveryCredits: { availableCount: 1, credits: [{ id: 'credit-1', kind: 'usage_limit_reset', status: 'available' }] },
    });
}

describe('useConnectedServiceQuotaSnapshot', () => {
    let boundary: Awaited<ReturnType<typeof createLegacyQuotaTestHarness>>;
    const Wrapper = createLegacyQuotaAuthWrapper(() => boundary);
    const params = { serviceId: 'openai-codex', profileId: 'work' } as const;
    const recovery = vi.fn(async (_payload: unknown): Promise<unknown> => ({
        ok: false, errorCode: 'recovery_failed', error: 'consume failed',
    }));
    const recoveryRequests: Array<{ machineId: string; payload: unknown }> = [];

    function seedSession(machineId = 'machine-selected', profileId = 'work') {
        const session = createSessionFixture({ id: 'session-owner', serverId: getActiveServerSnapshot().serverId,
            active: true, activeAt: Date.now(), metadata: { path: '/repo', host: 'tester.local', machineId,
                flavor: 'codex', agentId: 'codex', connectedServices: { v: 2,
                    bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
                        source: 'connected', selection: 'profile', profileId,
                    } },
                } },
        });
        storage.getState().applySessions([session]);
    }

    function installRecoveryBoundary() {
        const describe = boundary.socket.getMockImplementation()!;
        // Keep the canonical daemon-description responder. Only the external
        // recovery RPC gets an exceptional answer; real admission/targeting stay active.
        boundary.socket.mockImplementation(async (machineId: string, method: string, payload: unknown,
            options?: Parameters<typeof describe>[3]) => {
            if (method !== RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME) {
                return describe(machineId, method, payload, options);
            }
            options?.onIssued?.();
            const request = ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema.parse(payload);
            recoveryRequests.push({ machineId, payload: request });
            return ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.parse(await recovery(request));
        });
    }

    async function mount(credentialHealthStatus?: unknown) {
        const { useConnectedServiceQuotaSnapshot } = await import('./useConnectedServiceQuotaSnapshot');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshot({ ...params, credentialHealthStatus }), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        return hook;
    }

    beforeEach(async () => {
        await resetConnectedServiceQuotaSnapshotsTestState();
        boundary = await createLegacyQuotaTestHarness();
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(quotaSnapshot()));
        recovery.mockReset();
        recovery.mockResolvedValue({ ok: false, errorCode: 'recovery_failed', error: 'consume failed' });
        recoveryRequests.length = 0;
        seedSession();
        installRecoveryBoundary();
    });
    afterEach(async () => {
        standardCleanup();
        vi.useRealTimers();
        await boundary.dispose();
        vi.restoreAllMocks();
    });

    it('retains shared polling for the mounted account quota view', async () => {
        vi.useFakeTimers();
        const hook = await mount();
        expect(hook.getCurrent().snapshot).toEqual(quotaSnapshot());
        // Account restoration may deliver a connected wake during the first read.
        // Measure retained polling after that bootstrap has settled.
        const initialReads = boundary.plainRead.mock.calls.length;
        const second = await mount();
        expect(second.getCurrent().snapshot).toEqual(quotaSnapshot());
        expect(boundary.plainRead).toHaveBeenCalledTimes(initialReads);
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(boundary.plainRead).toHaveBeenCalledTimes(initialReads + 1);
        await hook.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(boundary.plainRead).toHaveBeenCalledTimes(initialReads + 2);
        await second.unmount();
        const reads = boundary.plainRead.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(boundary.plainRead).toHaveBeenCalledTimes(reads);
    });

    it('shares refresh admission across observers and cancels it only after the last observer leaves', async () => {
        const first = await mount();
        const second = await mount();
        const respond = boundary.socket.getMockImplementation()!;
        let requestSignal: AbortSignal | undefined;
        let requestIssued = false;
        boundary.socket.mockImplementation(async <R, A>(_machineId: string, _method: string, _payload: A,
            options?: Parameters<typeof respond>[3]): Promise<R> => {
            requestIssued = true;
            requestSignal = options?.signal;
            return new Promise<R>((_resolve, reject) => requestSignal?.addEventListener('abort', () => {
                reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
            }, { once: true }));
        });
        let refresh!: Promise<void>;
        act(() => { refresh = first.getCurrent().refresh(); });
        await vi.waitFor(() => expect(requestIssued).toBe(true));
        await first.unmount();
        expect(requestSignal?.aborted).toBe(false);
        expect(second.getCurrent().isRefreshing).toBe(true);
        await second.unmount();
        expect(requestSignal?.aborted).toBe(true);
        await refresh;
        boundary.socket.mockImplementation(respond);
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(quotaSnapshot(2_000)));
        const retry = await mount();
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(quotaSnapshot(3_000)));
        await act(async () => { await retry.getCurrent().refresh(); });
        expect(retry.getCurrent().isRefreshing).toBe(false);
    });

    it('rekeys its account-mode and polling scope when the same server reconnects', async () => {
        const hook = await mount();
        const first = getActiveServerSnapshot();
        expect(hook.getCurrent().snapshot?.fetchedAt).toBe(1_000);
        await act(async () => {
            await boundary.dispose();
            boundary = await createLegacyQuotaTestHarness();
            boundary.plainRead.mockImplementation(async () => plainQuotaResponse(quotaSnapshot(2_000)));
            seedSession();
            installRecoveryBoundary();
        });
        await hook.rerender();
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(getActiveServerSnapshot().serverId).toBe(first.serverId);
        expect(getActiveServerSnapshot().generation).not.toBe(first.generation);
        expect(boundary.modeRead).toHaveBeenCalled();
        expect(hook.getCurrent().snapshot?.fetchedAt).toBe(2_000);
    });

    it('still retains polling when the credential status is empty/unknown (fails OPEN)', async () => {
        const hook = await mount('');
        expect(hook.getCurrent().snapshot).toEqual(quotaSnapshot());
        expect(hook.getCurrent().canRefresh).toBe(true);
    });

    it('does not retain polling for an explicit needs_reauth credential', async () => {
        vi.useFakeTimers();
        const hook = await mount('needs_reauth');
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(boundary.plainRead).not.toHaveBeenCalled();
        expect(hook.getCurrent().snapshot).toBeNull();
        expect(hook.getCurrent().canRefresh).toBe(false);
    });

    it('clears a transient consume error when a manual refresh starts', async () => {
        const hook = await mount();
        await act(async () => { await hook.getCurrent().consumeRecoveryCredit('credit-1'); });
        expect(hook.getCurrent().error).toBe('consume failed');
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(boundary.refreshRead).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().error).toBeNull();
    });

    it('cancels an unmounted credit request and lets the remounted account retry', async () => {
        const respond = boundary.socket.getMockImplementation()!;
        let requestSignal: AbortSignal | undefined;
        let requestIssued = false;
        let cancelled = false;
        const hook = await mount();
        boundary.socket.mockImplementation(async (machineId: string, method: string, payload: unknown,
            options?: Parameters<typeof respond>[3]) => {
            if (method !== RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME)
                return respond(machineId, method, payload, options);
            requestIssued = true;
            requestSignal = options?.signal;
            return new Promise<never>((_resolve, reject) => requestSignal?.addEventListener('abort', () => {
                cancelled = true;
                reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
            }, { once: true }));
        });
        let consume!: Promise<void>;
        act(() => { consume = hook.getCurrent().consumeRecoveryCredit('credit-1'); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().consumeRecoveryCreditPending).toBe(true);
        await vi.waitFor(() => expect(requestIssued).toBe(true));
        await hook.unmount();
        expect(requestSignal?.aborted).toBe(true);
        await consume;
        expect(cancelled).toBe(true);
        boundary.socket.mockImplementation(respond);
        const retry = await mount();
        await act(async () => { await retry.getCurrent().consumeRecoveryCredit('credit-1'); });
        expect(retry.getCurrent().consumeRecoveryCreditPending).toBe(false);
    });

    it('clears a transient consume error after a successful snapshot update arrives', async () => {
        const hook = await mount();
        await act(async () => { await hook.getCurrent().consumeRecoveryCredit('credit-1'); });
        expect(hook.getCurrent().error).toBe('consume failed');
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(quotaSnapshot(2_000)));
        await act(async () => { publishHomeAccountChange(getActiveServerSnapshot().serverId, undefined); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshot?.fetchedAt).toBe(2_000);
        expect(hook.getCurrent().error).toBeNull();
    });

    it('targets the online machine that owns the connected-service profile when consuming recovery credit', async () => {
        storage.getState().applyMachines([
            createMachineFixture({ id: 'machine-arbitrary', activeAt: Date.now(), isShared: false }),
            createMachineFixture({ id: 'machine-owner', activeAt: Date.now(), isShared: false }),
        ], true, { sourceServerId: getActiveServerSnapshot().serverId });
        seedSession('machine-owner');
        recovery.mockImplementation(async payload => {
            const request = ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema.parse(payload);
            return { ok: true, receipt: { idempotencyKey: request.idempotencyKey, status: 'consumed' },
                snapshot: quotaSnapshot(2_000) };
        });
        const hook = await mount();
        expect(hook.getCurrent().recoveryCreditMachineId).toBe('machine-owner');
        await act(async () => { await hook.getCurrent().consumeRecoveryCredit('credit-1'); });
        expect(recoveryRequests).toEqual([{
            machineId: 'machine-owner', payload: expect.objectContaining({
                serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', providerCreditId: 'credit-1',
            }),
        }]);
        expect(hook.getCurrent().snapshot?.fetchedAt).toBe(2_000);
        expect(hook.getCurrent().error).toBeNull();
    });

    it('does not consume recovery credit on an unrelated active machine', async () => {
        seedSession('machine-selected', 'personal');
        const hook = await mount();
        expect(hook.getCurrent().recoveryCreditMachineId).toBeNull();
        await act(async () => { await hook.getCurrent().consumeRecoveryCredit('credit-1'); });
        expect(recoveryRequests).toEqual([]);
        expect(hook.getCurrent().error).toBeTruthy();
    });
});
