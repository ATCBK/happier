import { createServer } from 'node:http';
import { Server } from 'socket.io';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MachineVitalsGetInputV1Schema, MachineVitalsSnapshotV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { MachineGuardViewV1Schema } from '@happier-dev/protocol/machines/guard/guardRpcV1';
import { MachineVitalsHistoryV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import { createMachineGuardViewFixture } from '../guard/guardViewFixtures';
import { MachineGuardActivityListV1Schema } from '@happier-dev/protocol/machines/guard/activityV1';
import { HappierStorageSummaryV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { MachineProcessesAnswerV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

// HTTP/auth are the Home boundary; the Action, route, codec and Socket.IO path stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { fetchMachineVitalsViaMachineRpc, watchMachineVitalsViaMachineRpc } = await import('./machineRpc');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { fetchMachineGuardViewViaAction } = await import('../guard/machineGuardRpc');
const { machineResourceStore } = await import('./machineResourceStore');
const { useMachineVitalsOverview } = await import('./useMachineVitalsOverview');
const { useMachineResourceSummary } = await import('./useMachineResourceSummary');
const { useMachineResourceLiveDemand } = await import('./useMachineResourceLiveDemand');
const { useMachineDaemonReadTarget, useMachineDaemonReadTargets } = await import('../useMachineDaemonReadTarget');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { useMachineStorageSummary } = await import('../storage/useMachineStorageSummary');
const { machineStorageStore } = await import('../storage/machineStorageStore');
const { useMachineProcesses } = await import('../processes/useMachineProcesses');
const { machineProcessesStore } = await import('../processes/machineProcessesStore');
const { useMachineGuardView, useMachineGuardActivity, useMachinesGuardActivity } = await import('../guard/useMachineGuardView');
const { machineGuardStore } = await import('../guard/machineGuardStore');
const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
const { subscribeLocalServiceInventoryStore, getLocalServiceInventoryState, resetLocalServiceInventoryStoreForTests } = await import('@/sync/domains/local/services/inventory/sharedStore');
const { DEFAULT_BROWSER_CAPABILITIES } = await import('@happier-dev/protocol/features/payload/capabilities/browserCapabilities');
const { useLocalServiceInventoryState } = await import('@/sync/domains/local/services/inventory/useLocalServiceInventoryState');

type MachineCall = Readonly<{ method: string; requestId: string; params: unknown; reply(value: unknown): Promise<void> }>;

// This is the existing family harness: physical Home readiness, real Socket.IO, codec and Action wiring.
async function withMachineHome(run: (home: Readonly<{
    serverId: string; calls: MachineCall[]; cancellations: string[];
    setAnswer(answer: (call: MachineCall) => Promise<void>): void;
}>) => Promise<void>) {
    await loadSyncSingletonForTests();
    let serverUrl = '';
    const http = createServer(async (request, response) => {
        if (request.url === '/health' || request.url === '/v1/auth/ping') {
            response.setHeader('content-type', 'application/json'); response.end('{}'); return;
        }
        try {
            const answer = await homes.request(new URL(request.url ?? '/', serverUrl), {
                method: request.method, headers: request.headers.authorization ? { Authorization: request.headers.authorization } : {},
            });
            response.writeHead(answer.status, { 'content-type': 'application/json' }); response.end(await answer.text());
        } catch (error) {
            // A simulated lost HTTP connection must reach fetch, not leave its socket parked.
            response.destroy(error instanceof Error ? error : undefined);
        }
    });
    const server = new Server(http, { path: '/v1/updates/' });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback Home');
    serverUrl = `http://127.0.0.1:${address.port}`;
    const serverId = await homes.addHome({ name: 'Resources seam', serverUrl, accountId: 'owner', currentAccount: true });
    const machine = createPlainMachineRowFixture({ id: 'shared-machine', accountId: 'owner' });
    homes.answer(serverId, '/v1/machines/shared-machine', { body: { machine } });
    const calls: MachineCall[] = [];
    const cancellations: string[] = [];
    let answer: (call: MachineCall) => Promise<void> = async () => {};
    server.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CANCEL, (raw: { requestId: string }) => { cancellations.push(raw.requestId); });
        socket.on(SOCKET_RPC_EVENTS.CALL, async (raw: { method: string; params: unknown; requestId: string }, acknowledge: (reply: unknown) => void) => {
            const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, raw.params, raw.method);
            const call: MachineCall = { method: raw.method.split(':').slice(1).join(':'), requestId: raw.requestId, params: request.params,
                reply: async value => { acknowledge({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, value, request.callId) }); } };
            calls.push(call);
            await answer(call);
        });
    });
    try { await run({ serverId, calls, cancellations, setAnswer: next => { answer = next; } }); }
    finally { await serverScopedRpcSocketPool.stopAll(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

function vitals(sampledAt = Date.now()) {
    return MachineVitalsSnapshotV1Schema.parse({ state: 'reporting', sample: {
        v: 1, sampledAt, intervalMs: 15_000, cpu: { reported: true, busyPct: 20 },
        memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
        disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 },
    }, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
}

function ResourceProbe({ serverId, overview, expectedAccountId }: { serverId: string; overview: boolean; expectedAccountId?: string }) {
    const key = { serverId, machineId: 'shared-machine', expectedAccountId };
    useMachineResourceLiveDemand([key], { detail: 'summary', enabled: !overview });
    const details = useMachineVitalsOverview({ ...key, range: '1h', enabled: overview });
    const summary = useMachineResourceSummary(key);
    const target = useMachineDaemonReadTarget(key);
    const targets = useMachineDaemonReadTargets({ serverId, machineIds: [key.machineId] });
    return React.createElement('ResourceProbe', { details, summary, target, targets });
}

function destination(serverId: string, visible: boolean, focused = visible, overview = true, expectedAccountId?: string) {
    return React.createElement(DestinationInstanceHost, {
        tabId: 'retained-machines', ref: { kind: 'settings', params: {} }, pathname: '/settings', visible, focused,
        children: React.createElement(ResourceProbe, { serverId, overview, expectedAccountId }),
    });
}

function OtherResourcesProbe({ serverId }: { serverId: string }) {
    const key = { serverId, machineId: 'shared-machine' };
    const storage = useMachineStorageSummary(key);
    const processes = useMachineProcesses({ ...key, scope: 'happier', view: 'tree' });
    const guard = useMachineGuardView(key);
    const activity = useMachineGuardActivity({ ...key, range: 'today', filter: 'all' });
    const fleetActivity = useMachinesGuardActivity({ serverId, machineIds: [key.machineId], range: 'today', filter: 'all' });
    return React.createElement('OtherResourcesProbe', { storage, processes, guard, activity, fleetActivity });
}

afterEach(async () => {
    resetLocalServiceInventoryStoreForTests();
    machineResourceStore.reset();
    machineStorageStore.reset(); machineProcessesStore.reset(); machineGuardStore.reset();
    await serverScopedRpcSocketPool.stopAll();
    resetScopedMachineTransportCacheForTests();
    await homes.reset();
});

it('cancels a parked inventory snapshot at last unsubscribe and loads again on new demand', async () => {
    await withMachineHome(async home => {
        const key = { machineId: 'shared-machine', serverId: home.serverId };
        const unsubscribe = subscribeLocalServiceInventoryStore(key, () => {});
        await vi.waitFor(() => expect(home.calls.some(call => call.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH)).toBe(true));
        const parked = home.calls.find(call => call.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH)!;
        unsubscribe();
        await vi.waitFor(() => expect(home.cancellations).toContain(parked.requestId));
        home.setAnswer(async call => {
            if (call.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) await call.reply({ protocolVersion: 1, snapshot: {
                v: 1, machineId: key.machineId, generatedAt: 1000, refreshState: 'idle', entries: [], diagnostics: [],
            } });
        });
        const stop = subscribeLocalServiceInventoryStore(key, () => {});
        try { await vi.waitFor(() => expect(getLocalServiceInventoryState(key).generatedAt).toBe(1000)); }
        finally { stop(); }
    });
});

it('releases a parked inventory read when its retained destination is hidden', async () => {
    await withMachineHome(async home => {
        function Probe() {
            useLocalServiceInventoryState({ machineId: 'shared-machine', serverId: home.serverId });
            return React.createElement('InventoryProbe');
        }
        const content = (visible: boolean) => React.createElement(DestinationInstanceHost, {
            tabId: 'retained-inventory', ref: { kind: 'settings', params: {} }, pathname: '/settings', visible, focused: visible,
            children: React.createElement(Probe),
        });
        const screen = await renderScreen(content(true));
        try {
            await vi.waitFor(() => expect(home.calls.some(call => call.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH)).toBe(true));
            const parked = home.calls.find(call => call.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH)!;
            await screen.update(content(false));
            await vi.waitFor(() => expect(home.cancellations).toContain(parked.requestId));
            await screen.update(content(true));
            await vi.waitFor(() => expect(home.calls.filter(call => call.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH)).toHaveLength(2));
        } finally { await screen.unmount(); }
    });
});

it('retires shared install-job discovery only after its last reader leaves and retries fresh', async () => {
    const { ensureMachineAgentInstallJobs } = await import('@/agents/machineAgents/installJobs/installJobStore');
    await withMachineHome(async home => {
        const target = { machineId: 'shared-machine', serverId: home.serverId, accountId: 'owner' };
        const firstController = new AbortController();
        const secondController = new AbortController();
        let firstState = 'pending';
        let secondState = 'pending';
        const first = ensureMachineAgentInstallJobs(target, { signal: firstController.signal }).then(() => { firstState = 'ready'; }, () => { firstState = 'cancelled'; });
        const second = ensureMachineAgentInstallJobs(target, { signal: secondController.signal }).then(() => { secondState = 'ready'; }, () => { secondState = 'cancelled'; });
        await vi.waitFor(() => expect(home.calls.some(call => call.method === RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST)).toBe(true));
        const parked = home.calls.find(call => call.method === RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST)!;
        expect(home.calls.filter(call => call.method === RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST)).toHaveLength(1);
        firstController.abort();
        await vi.waitFor(() => expect(firstState).toBe('cancelled'));
        expect(secondState).toBe('pending');
        expect(home.cancellations).not.toContain(parked.requestId);
        secondController.abort();
        await Promise.all([first, second]);
        await vi.waitFor(() => expect(home.cancellations).toContain(parked.requestId));
        home.setAnswer(async call => { if (call.method === RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST) await call.reply({ ok: true, jobs: [] }); });
        await ensureMachineAgentInstallJobs(target, { signal: new AbortController().signal });
        expect(home.calls.filter(call => call.method === RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST)).toHaveLength(2);
        expect(home.calls.some(call => call.method === RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL)).toBe(false);
    });
});

it.each(['preview', 'publicPreview', 'diagnostics', 'simulator'] as const)('releases a parked %s snapshot when its effect signal retires', async family => {
    await withMachineHome(async home => {
        const controller = new AbortController();
        const request = { machineId: 'shared-machine', serverId: home.serverId, signal: controller.signal };
        const call = family === 'preview'
            ? () => import('@/sync/domains/local/services/preview/machineRpc').then(module => module.fetchLocalServicePreviewSnapshotViaMachineRpc(request))
            : family === 'publicPreview'
                ? () => import('@/sync/domains/local/services/publicPreview/machineRpc').then(module => module.fetchLocalServicePublicPreviewStatusViaMachineRpc({ ...request, request: { machineId: request.machineId } }))
                : family === 'diagnostics'
                    ? () => import('@/sync/domains/browser/diagnostics/machineRpc').then(module => module.fetchBrowserDiagnosticsSnapshotViaMachineRpc(request))
                    : () => import('@/sync/domains/devices/simulator/machineRpc').then(module => module.fetchSimulatorPreviewSnapshotViaMachineRpc(request));
        const pending = call();
        await vi.waitFor(() => expect(home.calls).toHaveLength(1));
        controller.abort();
        await vi.waitFor(() => expect(home.cancellations).toContain(home.calls[0].requestId));
        expect(await pending).toMatchObject({ ok: false, reason: 'request_failed' });
    });
});

it('reports actual watch dispatch through the real scoped transport before its parked reply', async () => {
    await withMachineHome(async home => {
        const dispatched = createDeferred<void>();
        const issued = createDeferred<MachineCall>();
        home.setAnswer(async call => { issued.resolve(call); });
        let settled = false;
        const reply = watchMachineVitalsViaMachineRpc({ serverId: home.serverId, expectedAccountId: 'owner',
            machineId: 'shared-machine', view: 'overview', onDispatched: () => dispatched.resolve() });
        void reply.then(() => { settled = true; });
        await dispatched.promise;
        expect(settled).toBe(false);
        await (await issued.promise).reply({ changed: false });
        expect(await reply).toEqual({ ok: true, value: { changed: false } });
    });
});

it('preserves an HTTP Machine-row failure through the real RPC seam and recovers on the next read', async () => {
    await withMachineHome(async home => {
        homes.answer(home.serverId, '/v1/machines/shared-machine', { dispatchThenFail: true });
        const input = { serverId: home.serverId, accountId: 'owner', machineId: 'shared-machine',
            method: 'machines.vitals.get', payload: { machineId: 'shared-machine', view: 'summary' }, preferScoped: true } as const;
        await expect(machineRpcWithServerScope(input)).rejects.toThrow(/fetch failed|Failed to fetch/u);
        expect(home.calls).toHaveLength(0);
        homes.answer(home.serverId, '/v1/machines/shared-machine', { body: {
            machine: createPlainMachineRowFixture({ id: 'shared-machine', accountId: 'owner' }),
        } });
        const snapshot = vitals();
        home.setAnswer(async call => { await call.reply(snapshot); });
        expect(MachineVitalsSnapshotV1Schema.parse(await machineRpcWithServerScope(input))).toEqual(snapshot);
    });
});

it('suspends Storage, Processes, Guard and Activity through their retained destination and real Action doors', async () => {
    await withMachineHome(async home => {
        const storage = HappierStorageSummaryV1Schema.parse({ revision: 1, sizedAt: Date.now(), volumes: [], categories: [], suggestionsTop: [],
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } });
        const processes = MachineProcessesAnswerV1Schema.parse({ v: 1, machineId: 'shared-machine', capturedAtMs: Date.now(), state: 'live',
            platform: 'linux', evidenceModel: 'fenced', owners: [], leftBehind: [],
            totals: { happier: { processCount: 0, memoryBytes: 0 }, leftBehind: { processCount: 0, memoryBytes: 0 } } });
        const activity = MachineGuardActivityListV1Schema.parse({ entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: Date.now() });
        home.setAnswer(async call => {
            if (call.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) await call.reply(storage);
            if (call.method === 'machines.processes.list') await call.reply(processes);
            if (call.method === 'machines.guard.get') await call.reply(MachineGuardViewV1Schema.parse(createMachineGuardViewFixture()));
            if (call.method === 'machines.guard.activity.list') await call.reply(activity);
        });
        const content = (visible: boolean) => React.createElement(DestinationInstanceHost, {
            tabId: 'retained-resources', ref: { kind: 'settings', params: {} }, pathname: '/settings', visible, focused: false,
            children: React.createElement(OtherResourcesProbe, { serverId: home.serverId }),
        });
        const screen = await renderScreen(content(true));
        try {
            await act(async () => { await vi.waitFor(() => {
                const state = screen.findByType('OtherResourcesProbe').props;
                expect([state.storage.status, state.processes.status, state.guard.status, state.activity.status, state.fleetActivity[0].status])
                    .toEqual(['ready', 'ready', 'ready', 'ready', 'ready']);
                expect(home.calls.filter(call => call.method.endsWith('.watch'))).toHaveLength(3);
            }); });
            const watches = home.calls.filter(call => call.method.endsWith('.watch'));
            await screen.update(content(false));
            await vi.waitFor(() => expect(watches.every(call => home.cancellations.includes(call.requestId))).toBe(true));
            const count = home.calls.length;
            await screen.update(content(false));
            expect(home.calls).toHaveLength(count);
            await screen.update(content(true));
            await act(async () => { await vi.waitFor(() => expect(home.calls.filter(call => call.method.endsWith('.watch'))).toHaveLength(6)); });
        } finally { await screen.unmount(); }
    });
});

it.each([true, false])('releases retained destination demand when hidden and reacquires it when shown (overview=%s)', async overview => {
    await withMachineHome(async home => {
        home.setAnswer(async call => {
            if (call.method === 'machines.vitals.get') await call.reply(vitals());
            if (call.method === 'machines.vitals.history.get') await call.reply(MachineVitalsHistoryV1Schema.parse({
                range: '1h', bucketMs: 60_000, points: [], today: { rxBytes: 0, txBytes: 0 },
            }));
        });
        const screen = await renderScreen(destination(home.serverId, true, true, overview));
        const probe = () => screen.findByType('ResourceProbe').props;
        try {
            await act(async () => { await vi.waitFor(() => expect(home.calls.some(call => call.method === 'daemon.vitals.watch')).toBe(true)); });
            expect(probe().target.enabled).toBe(true);
            expect(probe().targets[0].enabled).toBe(true);
            const watch = home.calls.find(call => call.method === 'daemon.vitals.watch')!;
            await screen.update(destination(home.serverId, false, false, overview));
            expect(probe().target.enabled).toBe(false);
            expect(probe().targets[0].enabled).toBe(false);
            await vi.waitFor(() => expect(home.cancellations).toContain(watch.requestId));
            const count = home.calls.length;
            await screen.update(destination(home.serverId, false, false, overview));
            expect(home.calls).toHaveLength(count);
            // A visible second split pane still owns demand without keyboard focus.
            await screen.update(destination(home.serverId, true, false, overview));
            await act(async () => { await vi.waitFor(() => expect(home.calls.filter(call => call.method === 'daemon.vitals.watch')).toHaveLength(2)); });
            expect(probe().target.enabled).toBe(true);
            expect(probe().targets[0].enabled).toBe(true);
        } finally { await screen.unmount(); }
    });
});

it('accepts a Guard read after the generic UI response deadline through the real Action transport', async () => {
    await withMachineHome(async home => {
        const issued = createDeferred<MachineCall>();
        home.setAnswer(async call => { issued.resolve(call); });
        const pending = fetchMachineGuardViewViaAction({ serverId: home.serverId, machineId: 'shared-machine', expectedAccountId: 'owner' });
        const call = await issued.promise;
        expect(call.method).toBe('machines.guard.get');
        await new Promise(resolve => setTimeout(resolve, 31_000));
        const view = MachineGuardViewV1Schema.parse(createMachineGuardViewFixture());
        await call.reply(view);
        expect(await pending).toEqual({ ok: true, value: view });
    });
}, 60_000);

it('cancels an issued Guard read and rejects a late reply through the real UI Action transport', async () => {
    await withMachineHome(async home => {
        const issued = createDeferred<MachineCall>();
        home.setAnswer(async call => { issued.resolve(call); });
        const controller = new AbortController();
        const pending = fetchMachineGuardViewViaAction({ serverId: home.serverId, machineId: 'shared-machine', expectedAccountId: 'owner', signal: controller.signal });
        const call = await issued.promise;
        controller.abort();
        await call.reply(MachineGuardViewV1Schema.parse(createMachineGuardViewFixture()));
        expect(await pending).toEqual({ ok: false, reason: 'request_failed' });
        await vi.waitFor(() => expect(home.cancellations).toContain(call.requestId));
    });
});

it('does not disclose a Guard answer after its captured Account retires', async () => {
    await withMachineHome(async home => {
        const issued = createDeferred<MachineCall>();
        home.setAnswer(async call => { issued.resolve(call); });
        const pending = fetchMachineGuardViewViaAction({ serverId: home.serverId, machineId: 'shared-machine', expectedAccountId: 'owner' });
        const call = await issued.promise;
        await homes.switchAccount(home.serverId, 'next-owner', { currentAccount: true });
        await call.reply(MachineGuardViewV1Schema.parse(createMachineGuardViewFixture()));
        expect(await pending).toEqual({ ok: false, reason: 'request_failed' });
    });
});

it('retires same-Home Account reads and never selects another Account’s retained Vitals', async () => {
    await withMachineHome(async home => {
        const first = vitals();
        let accountB = false;
        home.setAnswer(async call => {
            if (!accountB && call.method === 'machines.vitals.get') await call.reply(first);
            if (call.method === 'machines.vitals.history.get') await call.reply(MachineVitalsHistoryV1Schema.parse({
                range: '1h', bucketMs: 60_000, points: [], today: { rxBytes: 0, txBytes: 0 },
            }));
        });
        const screen = await renderScreen(destination(home.serverId, true));
        const dialog = await renderScreen(destination(home.serverId, true, true, true, 'owner'));
        const probe = () => screen.findByType('ResourceProbe').props;
        try {
            await act(async () => { await vi.waitFor(() => expect(probe().summary?.summary?.sampledAt).toBe(first.sample?.sampledAt)); });
            const watch = home.calls.find(call => call.method === 'daemon.vitals.watch')!;
            accountB = true;
            await act(async () => { await homes.switchAccount(home.serverId, 'next-owner', { currentAccount: true }); });
            await vi.waitFor(() => expect(home.cancellations).toContain(watch.requestId));
            expect(probe().summary?.summary ?? null).toBeNull();
            expect(probe().details.snapshot).toBeNull();
            expect(dialog.findByType('ResourceProbe').props.details.snapshot).toBeNull();
            expect(dialog.findByType('ResourceProbe').props.summary).toBeNull();
            await watch.reply({ changed: true, samples: [first.sample] });
            expect(probe().details.snapshot).toBeNull();
            await act(async () => { await vi.waitFor(() => expect(home.calls.filter(call => call.method === 'machines.vitals.get')).toHaveLength(2)); });
            const next = home.calls.filter(call => call.method === 'machines.vitals.get').at(-1)!;
            const second = vitals((first.sample?.sampledAt ?? 0) + 1);
            await act(async () => { await next.reply(second); });
            await act(async () => { await vi.waitFor(() => expect(probe().details.snapshot).toEqual(second)); });
            expect(probe().summary?.summary?.sampledAt).toBe(second.sample?.sampledAt);
            const count = home.calls.length;
            expect(await fetchMachineVitalsViaMachineRpc({ serverId: home.serverId, machineId: 'shared-machine', expectedAccountId: 'owner', view: 'summary' }))
                .toMatchObject({ ok: false, reason: 'request_failed' });
            expect(home.calls).toHaveLength(count);
        } finally { await screen.unmount(); await dialog.unmount(); }
        // The real Sync Account reset clears retained samples even when no surface is mounted.
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        getSyncSingleton().disconnectServer();
        for (const expectedAccountId of ['owner', 'next-owner']) {
            expect(machineResourceStore.getState({ serverId: home.serverId, machineId: 'shared-machine', expectedAccountId, view: 'overview' }).snapshot).toBeNull();
            expect(machineResourceStore.getHistory({ serverId: home.serverId, machineId: 'shared-machine', expectedAccountId, range: '1h' }).history).toBeNull();
        }
    });
});

it('reads a newly registered reachable machine through the Action and real Socket.IO route', async () => {
    await withMachineHome(async home => {
        const snapshot = MachineVitalsSnapshotV1Schema.parse({ state: 'reporting', sample: null,
            series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
        home.setAnswer(async call => { await call.reply(snapshot); });
        expect(await fetchMachineVitalsViaMachineRpc({ serverId: home.serverId, machineId: 'shared-machine', view: 'summary' }))
            .toEqual({ ok: true, value: snapshot });
        expect(home.calls.map(call => ({ method: call.method, input: MachineVitalsGetInputV1Schema.parse(call.params) })))
            .toEqual([{ method: 'machines.vitals.get', input: { serverId: home.serverId, machineId: 'shared-machine', view: 'summary' } }]);
    });
});
