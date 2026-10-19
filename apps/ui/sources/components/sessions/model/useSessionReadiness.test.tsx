import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { useSessionReadiness } = await import('./useSessionReadiness');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiSessionStatusGet } = await import('@/sync/ops/actions/sessionStatusAction');

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); network.resetRequests(); });
afterAll(() => network.dispose());

it('demands the exact Session only while open and keeps an offline Bot visible with its cause', async () => {
    const home = await network.addHome('https://readiness-row.test', 'alice');
    const scope = { serverId: home.id, accountId: 'alice' };
    const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const session = createSessionFixture({ id: 'offline-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex' }, access: createSessionAccessFixture('owner') });
    storage.setState({ machineListByServerId: { [home.id]: [createMachineFixture({ id: 'sleeping', active: false, activeAt: 0 })] } });
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${session.id}`
        ? Response.json(createPlainSessionByIdResponseFixture(session)) : null);
    let renders = 0;
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => {
        renders += 1;
        return useSessionReadiness({ accountLifetime, sessionId: session.id, enabled });
    }, { initialProps: { enabled: false } });
    expect(hook.getCurrent().readiness).toBeNull();
    expect(network.httpRequests).toEqual([]);
    expect(network.requests).toEqual([]);
    expect(network.credentialRequests).toEqual([]);
    await hook.rerender({ enabled: true });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ configured: true,
        status: 'unavailable', cause: 'machine', machine: { status: 'offline', machineId: 'sleeping' } }));
    expect(hook.getCurrent().repair).toBeNull();
    expect(network.requests).toEqual([]);
    const requested = network.httpRequests.length;
    const openedRenders = renders;
    await act(async () => { storage.setState({ socketStatus: 'connecting' }); });
    expect(renders).toBe(openedRenders);
    expect(network.httpRequests).toHaveLength(requested);
    await hook.rerender({ enabled: false });
    const closedRenders = renders;
    await act(async () => { storage.setState({ socketStatus: 'disconnected' }); });
    expect(renders).toBe(closedRenders);
    await hook.getCurrent().refresh();
    expect(network.httpRequests).toHaveLength(requested);
});

it('shares exact native repair facts with the status Action and refreshes through the inventory owner', async () => {
    const home = await network.addHome('https://readiness-native.test', 'alice');
    const scope = { serverId: home.id, accountId: 'alice' };
    const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const session = createSessionFixture({ id: 'native-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'native-machine', path: '/work', host: 'server', flavor: 'codex' }, access: createSessionAccessFixture('owner') });
    const machine = createMachineFixture({ id: 'native-machine', active: true, activeAt: Date.now(),
        access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId: 'alice', displayName: 'Alice' },
            role: 'manage', resourceMode: 'plain', accessState: 'ready' }) });
    storage.setState({ machineListByServerId: { [home.id]: [machine] } });
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${session.id}`
        ? Response.json(createPlainSessionByIdResponseFixture(session)) : null);
    const native = createReadyMachineAgentInventoryFixture([{ agentId: 'codex', title: 'Codex' }]);
    let signedIn = false;
    network.setRpcAckResponder(async request => {
        if (request.method.includes('contributionRegistryProjection.describe')) return { ok: true,
            result: { protocolVersion: 1, projection: native.projection } };
        if (request.method === 'daemon.agents.install.list') return { ok: true, result: { jobs: [] } };
        if (request.method === 'capabilities.detect') return { ok: true, result: { protocolVersion: 1, results: { 'cli.codex': {
            ...native.capabilities.results['cli.codex'], data: { ...native.capabilities.results['cli.codex']!.data,
                signIn: { status: signedIn ? 'signedIn' : 'signedOut', loginSupport: 'login_terminal' },
                isLoggedIn: signedIn, authStatus: { state: signedIn ? 'logged_in' : 'logged_out', checkedAt: 1 } },
        } } } };
        throw new Error(`Unexpected readiness effect ${request.method}`);
    });
    const hook = await renderHook(() => useSessionReadiness({ accountLifetime, sessionId: session.id, enabled: true }));
    const repair = { actionId: 'machines.agents.signIn.start', input: { machineId: machine.id, agentId: 'codex', method: 'native' } };
    await vi.waitFor(() => expect(hook.getCurrent().repair).toEqual(repair));
    const account = await captureLazyActionAccountContext(home.id);
    try {
        expect(await createUiSessionStatusGet(account)({ sessionId: session.id, readiness: true }))
            .toMatchObject({ ok: true, readiness: { cause: 'agent', agent: { state: 'needsSignIn', repair } } });
    } finally { account.dispose(); }
    signedIn = true; // Native acknowledgement supplied by the real inventory transport boundary.
    await act(async () => { await hook.getCurrent().refresh(); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.status).toBe('ready'));
    expect(network.requests.some(request => request.method === 'daemon.agents.signIn.prepare')).toBe(false);
});

it('discards a late exact-Session response after the readiness detail closes', async () => {
    const home = await network.addHome('https://readiness-close.test', 'alice');
    const accountLifetime = { scope: { serverId: home.id, accountId: 'alice' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) };
    const gate = createDeferred<void>();
    const session = createSessionFixture({ id: 'late-bot', encryptionMode: 'plain', access: createSessionAccessFixture('view') });
    network.resetRequests();
    network.setHttpResponder(async input => {
        if (new URL(String(input)).pathname !== `/v2/sessions/${session.id}`) return null;
        await gate.promise;
        return Response.json(createPlainSessionByIdResponseFixture(session));
    });
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => useSessionReadiness({ accountLifetime,
        sessionId: session.id, enabled }), { initialProps: { enabled: true } });
    await vi.waitFor(() => expect(network.httpRequests.some(request => request.url.endsWith(`/v2/sessions/${session.id}`))).toBe(true));
    await hook.rerender({ enabled: false });
    await act(async () => { gate.resolve(); });
    expect(hook.getCurrent().readiness).toBeNull();
    expect(hook.getCurrent().repair).toBeNull();
    expect(network.requests).toEqual([]);
});
