import axios from 'axios';
import nacl from 'tweetnacl';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ApiMachineClient } from '@/api/apiMachine';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createDaemonManagedMachineActionAdapter } from './managedMachineActionAdapter';
import { createDaemonManagedMachinePolicyRuntime, readManagedMachinePolicyCensus } from './managedMachinePolicyRuntime';
import { ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ChangeEntrySchema, type ChangeEntry } from '@happier-dev/protocol/changes';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ManagedPolicyAdmissionInputV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';

// Only the socket transport is substituted. Real RPC decoding produces the
// RpcError consumed by the acquisition driver, adapter and operation store.
const wire = vi.hoisted(() => ({ reads: 0, publications: [] as string[], refusal: 'RPC_FORBIDDEN',
    heldRead: undefined as (() => void) | undefined }));
vi.mock('socket.io-client', async () => {
    const { createSocketIoManagerStub } = await import('@/testkit/backends/apiSessionSocketHarness');
    return { io: () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const socket = { connected: false, io: createSocketIoManagerStub(), emit() {},
        on(event: string, listener: (...args: unknown[]) => void) {
            const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group); return socket;
        },
        off(event: string, listener: (...args: unknown[]) => void) { listeners.get(event)?.delete(listener); return socket; },
        connect() { socket.connected = true; for (const listener of listeners.get('connect') ?? []) listener(); },
        disconnect() { socket.connected = false; }, close() { socket.connected = false; },
        removeAllListeners() { listeners.clear(); }, offAny() {},
        async emitWithAck(event: string, input: { method?: string; daemonState?: string; expectedVersion?: number }) {
            if (event === 'machine-update-state') {
                wire.publications.push(input.daemonState!);
                return { result: 'success', version: input.expectedVersion! + 1, daemonState: input.daemonState };
            }
            if (input.method === 'guest:managed.activity.read' || input.method === 'incumbent-guest:managed.activity.read') {
                wire.reads += 1;
                if (input.method === 'incumbent-guest:managed.activity.read') {
                    await new Promise<void>(resolve => { wire.heldRead = resolve; });
                }
                // An actual asynchronous refusal: the operation is published
                // and waiting before the Home acknowledgement arrives.
                await new Promise<void>(resolve => setImmediate(resolve));
                return { ok: false, error: 'Refused by Home', errorCode: wire.refusal };
            }
            throw new Error(`Unexpected socket boundary: ${event} ${input.method}`);
        },
    };
    return socket;
} };
});

afterEach(() => vi.restoreAllMocks());

it.each(['unreachable', 'refusal', 'read-failure', 'read-abort'] as const)('composes guest readiness and policy failure publication (%s)', async scenario => {
    wire.reads = 0; wire.publications.length = 0; wire.heldRead = undefined;
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0 })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const serverUrl = 'https://policy-readiness.example';
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
        [configuration.activeServerId]: { id: configuration.activeServerId, name: 'Policy Home', serverUrl, webappUrl: serverUrl,
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: serverUrl, revision: 1,
                endpoints: [{ kind: 'https', url: serverUrl }] } },
    } }));
    const signing = nacl.sign.keyPair();
    const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'owner',
        controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
        retention: { kind: 'unused', afterMs: 60_000, effect: scenario === 'refusal' ? 'delete' : 'stop' }, wakeOnAcceptedMessage: false });
    const incumbent = ManagedMachineV1Schema.parse({ ...machine, id: 'incumbent', enrolledMachineId: 'incumbent-guest' });
    const deadline = ManagedMachineV1Schema.parse({ ...machine, id: 'deadline', enrolledMachineId: undefined,
        retention: { kind: 'deadline', at: Date.now() - 1, effect: 'stop', interrupts: true } });
    const cleanup = ManagedMachineV1Schema.parse({ ...machine, id: 'cleanup', enrolledMachineId: undefined,
        creationState: 'canceled', desired: 'delete', allocation: 'may-exist', resource: undefined,
        nativeOperationRef: machine.resource, retention: { kind: 'until-delete' } });
    const rows = new Map([machine, incumbent, deadline, cleanup].map(row => [row.id, row]));
    let censusMachines = scenario === 'read-failure' ? [incumbent]
        : scenario === 'read-abort' ? [machine, deadline, cleanup] : [machine];
    let reachable = scenario !== 'unreachable';
    let unreadable = false;
    const readinessFailure = new Error('Exact guest publication unavailable');
    const readinessReads: string[] = [];
    const policyPreparations: string[] = [];
    const failures: unknown[] = [];
    let readinessPending = false;
    let registered = true;
    let changes: ChangeEntry[] = [];
    let cursor = 0;
    const rawMachine = (id: string) => ({ id, active: id === 'controller' || reachable,
        installationId: id === 'controller' ? 'installation' : 'guest-installation',
        metadata: null, metadataVersion: 0, daemonStateVersion: wire.publications.length,
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        daemonState: id === 'controller' ? wire.publications.at(-1) ?? encodePlainMachineStoredContent({ status: 'running' })
            : encodePlainMachineStoredContent({ status: registered ? 'running' : 'starting', startedAt: 1 }) });
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v2/changes') return { status: 200, data: { changes, nextCursor: cursor } };
        if (path.startsWith('/v1/machines/')) {
            if (path.endsWith('/guest')) expect(new URL(String(url)).origin).toBe(serverUrl);
            if (path.endsWith('/guest') || path.endsWith('/incumbent-guest')) readinessReads.push(path);
            if (unreadable && path.endsWith('/guest')) throw readinessFailure;
            if (scenario === 'read-abort' && path.endsWith('/guest')) {
                return await new Promise<never>((_resolve, reject) => {
                    const signal = options?.signal;
                    if (!(signal instanceof AbortSignal)) throw new Error('Missing readiness cancellation signal');
                    const abort = () => reject(signal.reason);
                    signal.addEventListener('abort', abort, { once: true });
                    readinessPending = true;
                    if (signal.aborted) abort();
                });
            }
            return { status: 200, data: { machine: rawMachine(path.split('/').at(-1)!) } };
        }
        throw new Error(`Unexpected HTTP read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (String(url).endsWith('/controller/policies')) return { status: 200, data: { machines: censusMachines, targets: [] } };
        if (String(url).endsWith('/controller/prepare-policy')) {
            const request = ManagedPolicyAdmissionInputV1Schema.parse(body);
            policyPreparations.push(request.managedId);
            // The Home refuses native admission; no external effect is executed.
            return { status: 503, data: { error: 'admission_unavailable' } };
        }
        if (String(url).endsWith('/controller/report-policy-failure')) return { status: 200, data: {} };
        throw new Error(`Unexpected HTTP mutation: ${url}`);
    });
    const api = await ApiClient.create(credentials);
    const controller = (await api.getMachine('controller'))!;
    const client = new ApiMachineClient(token, controller, undefined, { loadMachine: options => api.getMachine('controller', options) });
    const transport = client as unknown as { socket: unknown; syncChangesOnConnect(options: { reason: 'live' }): Promise<void> };
    const { io } = await import('socket.io-client');
    const socket = io(); socket.connect(); transport.socket = socket;
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential IO'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }) });
    const native = nativeFixture({ privateNative: true });
    const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner' });
    const activity = createManagedActivityInventory({ producers: [operations.activity] });
    const publications: Promise<unknown>[] = [];
    const unsubscribe = activity.subscribe(decision => {
        publications.push(client.updateDaemonState(state => ({ ...(state ?? { status: 'running' }), managedActivity: decision })));
    });
    const adapter = createDaemonManagedMachineActionAdapter({ credentials, machineId: 'controller',
        serverBaseUrl: serverUrl, serverId: configuration.activeServerId,
        installationIdentity: { installationId: 'installation', privateKey: signing.secretKey }, managedProviderOperationAuthority: authority,
        resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl,
            resolveCurrentMachineId: () => 'controller', resolveCurrentServerIdentityId: () => 'srv_home' }),
        acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
        observeActionExecution: request => operations.observeExecution(request), readPolicyCurrent: async id => rows.get(id) ?? null,
        executeManagedPolicyAction: unavailable });
    const runtime = createDaemonManagedMachinePolicyRuntime({ apiMachine: client,
        loadMachine: (id, signal) => runWithServerHttpBaseUrl(serverUrl, () => api.getMachine(id, { signal })),
        readCensus: signal => readManagedMachinePolicyCensus({ homeId: 'srv_home', controller: machine.controller,
            custodianAccountId: 'owner', privateKey: signing.secretKey, token, serverUrl, signal }),
        executePolicy: adapter.executePolicy, onUnavailable: error => { failures.push(error); } });
    const list = async () => ActionOperationListV1ResponseSchema.parse(await operations.handlers.listV2({})).items;
    const drain = () => new Promise<void>(resolve => setImmediate(resolve));
    const sync = async (machineId: string) => {
        changes = [ChangeEntrySchema.parse({ kind: 'machine', entityId: machineId, cursor: ++cursor, changedAt: Date.now(), hint: null })];
        await transport.syncChangesOnConnect({ reason: 'live' }); await drain();
    };
    try {
        await activity.read(); await Promise.all(publications);
        runtime.notifyChanged(); await drain();
        if (scenario === 'read-abort') {
            await vi.waitFor(() => expect(readinessPending).toBe(true));
            await runtime.stop();
            expect(failures).toEqual([]);
            expect(policyPreparations).toEqual([]);
            expect(await list()).toEqual([]);
            expect(wire.reads).toBe(0);
            return;
        }
        if (scenario === 'read-failure') {
            await vi.waitFor(() => expect(wire.heldRead).toBeTypeOf('function'));
            expect(await list()).toMatchObject([{ state: 'running', domainRef: { id: incumbent.id } }]);
            // A failing first guest must neither starve independent policy rows
            // nor prevent retirement of a lifetime omitted from this census.
            unreadable = true;
            censusMachines = [machine, deadline, cleanup];
            runtime.notifyChanged();
            await vi.waitFor(() => expect(failures).toContain(readinessFailure));
            await vi.waitFor(() => expect([...policyPreparations].sort()).toEqual(['cleanup', 'deadline']));
            await vi.waitFor(async () => expect(await list()).toHaveLength(3));
            await vi.waitFor(async () => expect((await list()).find(item => item.domainRef?.kind === 'managedMachine'
                && item.domainRef.id === incumbent.id)).toMatchObject({ state: 'cancelled' }));
            // One exact failed readiness read, no retries, inventory scan or
            // guest activity read for the unreadable row/deadline/cleanup.
            expect(readinessReads.filter(path => path === '/v1/machines/guest')).toHaveLength(1);
            expect(wire.reads).toBe(1);
            expect(failures).toEqual([readinessFailure]);
            return;
        }
        if (scenario === 'unreachable') {
            // Separate, settled invalidations cannot create guest work during enrollment.
            for (let i = 0; i < 32; i++) { runtime.notifyChanged(); await drain(); }
            expect(await list()).toHaveLength(0); expect(wire.reads).toBe(0);
            // A newly connected daemon has not registered its RPCs yet. Neither
            // presence alone nor a stale running state from an offline daemon suffices.
            reachable = true; registered = false;
            await sync('guest');
            expect(await list()).toHaveLength(0); expect(wire.reads).toBe(0);
            registered = true;
            await sync('guest');
        }
        await vi.waitFor(async () => expect(await list()).toMatchObject([{ state: 'failed' }]));
        expect((await list())[0]).toMatchObject({ error: { errorCode: RPC_ERROR_CODES.FORBIDDEN },
            progress: { phase: 'managed.intent.waiting-idle' } });
        expect(wire.reads).toBe(1);
        // Flush the real operation -> activity -> daemon-state -> Account
        // changes consumer after settlement, when the scheduler no longer holds it.
        for (let i = 0; i < 8; i++) { await Promise.all(publications); await sync('controller'); }
        expect(wire.publications.length).toBeGreaterThan(1);
        expect(await list()).toHaveLength(1); expect(wire.reads).toBe(1);
        // A real guest restart still wakes this exact retained policy.
        reachable = false; await sync('guest'); expect(await list()).toHaveLength(1);
        reachable = true; await sync('guest');
        await vi.waitFor(async () => expect(await list()).toHaveLength(2));
        await vi.waitFor(() => expect(wire.reads).toBe(2));
    } finally {
        wire.heldRead?.();
        await runtime.stop(); unsubscribe(); activity.dispose(); await Promise.allSettled(publications);
        transport.socket = null; socket.disconnect(); await client.shutdown();
    }
});
