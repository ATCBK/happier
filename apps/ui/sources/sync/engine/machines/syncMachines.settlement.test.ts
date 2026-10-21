import { afterEach, describe, expect, it, vi } from 'vitest';
import * as platformCrypto from 'rn-encryption';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

import { createDeferred, createMachineFixture } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { hasCurrentMachineContent, readLiveMachineInventoryRows, resolveServerScopedMachineInventory } from '@/sync/domains/machines/resolveServerScopedMachines';
import { resolveAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/machineInventorySnapshots';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';
import { InvalidateSync } from '@/utils/sessions/sync';

import { buildUpdatedMachineFromSocketUpdate, fetchAndApplyMachines, type FetchedMachineRow } from './syncMachines';

const credentials = { token: 'header.eyJzdWIiOiJhY2NvdW50LTEifQ==.signature' };
const initialState = storage.getState();

afterEach(() => {
    vi.restoreAllMocks();
    storage.setState(initialState, true);
});

function createInventory() {
    const serverId = resolveServerProfileScopeIdForIdentifier(getActiveServerSnapshot().serverId);
    storage.setState({ machines: {}, machineDisplayById: {}, machinePresenceById: {},
        machinePresenceByServerId: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
    const read = () => resolveServerScopedMachineInventory({ serverId, activeServerId: serverId,
        activeMachines: Object.values(storage.getState().machines),
        machineListByServerId: storage.getState().machineListByServerId,
        machineListStatusByServerId: storage.getState().machineListStatusByServerId });
    return { serverId, read, callbacks: {
        sourceServerId: serverId,
        getExistingMachine: (id: string) => storage.getState().machines[id],
        getMachineSnapshot: () => storage.getState().machines,
        applyMachines: (machines: Parameters<typeof initialState.applyMachines>[0], replace: boolean) =>
            storage.getState().applyMachines(machines, replace, { sourceServerId: serverId }),
        onListComplete: () => storage.getState().markMachineListSettled(serverId),
        onListUnavailable: () => storage.getState().markMachineListUnavailable(serverId),
    } };
}

describe('Machine-list settlement through sync and the real store', () => {
    it('retains already opened eligibility when list hydration catches up behind a newer same-key hint', async () => {
        const inventory = createInventory();
        const row = { ...createPlainMachineRowFixture({ id: 'opening', accountId: 'account-1' }),
            keyBasis: { dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadataVersion: 1, daemonStateVersion: 1 } };
        const params = { ...inventory.callbacks, credentials, expectedAccountMode: 'plain' as const,
            encryption: null, machineDataKeys: new Map(),
            applyMachineDisplayEntries: (machines: Parameters<typeof initialState.replaceMachineDisplays>[0], options: Parameters<typeof initialState.replaceMachineDisplays>[1]) =>
                storage.getState().replaceMachineDisplays(machines, { ...options, sourceServerId: inventory.serverId }),
        };
        await fetchAndApplyMachines({ ...params, request: async () => Response.json([row]) });
        expect(storage.getState().machines.opening?.availability).toEqual({ kind: 'available' });
        const entered = createDeferred<void>(), release = createDeferred<void>();
        const pending = fetchAndApplyMachines({ ...params, request: async () => {
            entered.resolve(); await release.promise; return Response.json([row]);
        } });
        try {
            await entered.promise;
            const opened = storage.getState().machines.opening!;
            storage.getState().applyMachines([{ ...opened,
                keyBasis: { ...row.keyBasis, daemonStateVersion: 2 },
            }], false, { sourceServerId: inventory.serverId });
            release.resolve(); await pending;
            const retained = storage.getState().machines.opening!;
            expect(retained).toMatchObject({ metadata: opened.metadata, availability: { kind: 'available' },
                daemonStateVersion: 1, keyBasis: { daemonStateVersion: 2 } });
            expect(hasCurrentMachineContent(retained)).toBe(false);
        } finally { release.resolve(); await pending; }
    });

    it.each(['same-key', 'newer-content-hint', 'different-owner-key'] as const)('hydrates a presence shell while socket hints advance during the list read: %s', async (hint) => {
        const inventory = createInventory();
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const dataKey = new Uint8Array(32).fill(23);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64');
        const otherEnvelope = encodeBase64(await encryption.encryptEncryptionKey(new Uint8Array(32).fill(29)), 'base64');
        await encryption.initializeMachines(new Map([['online', dataKey]]));
        const machine = createMachineFixture({ id: 'online', active: true, activeAt: Date.now(),
            metadataVersion: 2, daemonStateVersion: 0, dataEncryptionKey: envelope });
        const row: FetchedMachineRow = { ...machine,
            metadata: await encryption.getMachineEncryption('online')!.encryptMetadata(machine.metadata!),
            daemonState: null, daemonStateVersion: 0,
            keyBasis: { dataEncryptionKey: envelope, metadataVersion: 2, daemonStateVersion: 0 } };
        encryption.removeMachineEncryption('online');
        const seed = { ...createMachineFixture({ id: 'online', active: true, activeAt: machine.activeAt,
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
            dataEncryptionKey: envelope }), availability: undefined,
            keyBasis: { dataEncryptionKey: envelope, metadataVersion: 1, daemonStateVersion: 0 } };
        const shell = (await buildUpdatedMachineFromSocketUpdate({ existingMachine: seed,
            machineUpdate: { machineId: 'online' }, updateSeq: 1, updateCreatedAt: seed.updatedAt,
            keyBasis: seed.keyBasis, getMachineEncryption: id => encryption.getMachineEncryption(id) }))!;
        storage.getState().applyMachines([shell], false, { sourceServerId: inventory.serverId });
        const entered = createDeferred<void>(), release = createDeferred<void>();
        const pending = fetchAndApplyMachines({ ...inventory.callbacks,
            credentials: { ...credentials, secret: encodeBase64(secret, 'base64url') }, expectedAccountMode: 'e2ee',
            encryption, machineDataKeys: new Map(), request: async () => {
                entered.resolve(); await release.promise; return Response.json([row]);
            }, applyMachineDisplayEntries: (machines, options) => storage.getState().replaceMachineDisplays(machines,
                { sourceServerId: inventory.serverId, ...options }),
        });
        try {
            await entered.promise;
            const updated = await buildUpdatedMachineFromSocketUpdate({
                existingMachine: storage.getState().machines.online,
                machineUpdate: { machineId: 'online' }, updateSeq: 2, updateCreatedAt: shell.updatedAt + 1,
                keyBasis: { ...row.keyBasis!, metadataVersion: hint === 'newer-content-hint' ? 3 : 2,
                    dataEncryptionKey: hint === 'different-owner-key' ? otherEnvelope : envelope },
                getMachineEncryption: id => encryption.getMachineEncryption(id),
            });
            storage.getState().applyMachines([updated!], false, { sourceServerId: inventory.serverId });
            release.resolve(); await pending;
            expect(storage.getState().machines.online).toMatchObject(hint === 'same-key'
                ? { metadata: machine.metadata, metadataVersion: 2, availability: { kind: 'available' } }
                : hint === 'newer-content-hint'
                ? { metadata: machine.metadata, metadataVersion: 2, availability: undefined,
                    keyBasis: { metadataVersion: 3 } }
                : { metadata: null, metadataVersion: 0, keyBasis: { dataEncryptionKey: otherEnvelope } });
        } finally { release.resolve(); await pending; }
    });

    it('opens online content without joining an offline peer data-key batch', async () => {
        const inventory = createInventory();
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        const rows: FetchedMachineRow[] = [];
        for (const [index, id] of ['offline-key', 'online-key'].entries()) {
            const key = new Uint8Array(32).fill(23 + index);
            const envelope = encodeBase64(await encryption.encryptEncryptionKey(key), 'base64');
            await encryption.initializeMachines(new Map([[id, key]]));
            const machine = createMachineFixture({ id, active: id === 'online-key', activeAt: id === 'online-key' ? Date.now() : 1,
                metadataVersion: 1, daemonStateVersion: 0, dataEncryptionKey: envelope });
            rows.push({ ...machine, metadata: await encryption.getMachineEncryption(id)!.encryptMetadata(machine.metadata!),
                daemonState: null, daemonStateVersion: 0 });
            encryption.removeMachineEncryption(id);
        }
        const offlineEnvelope = rows[0]!.dataEncryptionKey;
        const entered = createDeferred<void>(), release = createDeferred<void>();
        const worker = createFakeCryptoWorker();
        // The native batch is the boundary: one slow batch must not hold online content.
        encryption.configureNativeCryptoWorker({ routing: { mode: 'require', minPayloadBytes: 0 }, worker: {
            ...worker, decryptDataKeyEnvelopeV1: async request => {
                if (request.items.some(item => item.envelopeBase64 === offlineEnvelope)) {
                    entered.resolve(); await release.promise;
                }
                return worker.decryptDataKeyEnvelopeV1(request);
            },
        } });
        const pending = fetchAndApplyMachines({ ...inventory.callbacks,
            credentials: { ...credentials, secret: encodeBase64(secret, 'base64url') }, expectedAccountMode: 'e2ee',
            encryption, machineDataKeys: new Map(), request: async () => Response.json(rows),
            applyMachineDisplayEntries: (machines, options) => storage.getState().replaceMachineDisplays(machines,
                { sourceServerId: inventory.serverId, ...options }),
        });
        try {
            await entered.promise;
            await vi.waitFor(() => expect(storage.getState().machines['online-key']).toMatchObject({
                metadata: createMachineFixture().metadata, availability: { kind: 'available' },
            }));
            expect(storage.getState().machines['offline-key']?.metadata).toBeNull();
            expect(inventory.read().status).toBe('loading');
        } finally { release.resolve(); await pending; }
    });

    it('finishes current metadata hydration when a socket has already opened newer daemon state', async () => {
        const inventory = createInventory();
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const key = new Uint8Array(32).fill(23);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(key), 'base64');
        await encryption.initializeMachines(new Map([['online', key]]));
        const cipher = encryption.getMachineEncryption('online')!;
        const machine = createMachineFixture({ id: 'online', metadataVersion: 2, daemonStateVersion: 1,
            dataEncryptionKey: envelope, storageMode: 'e2ee', active: true });
        const rows: FetchedMachineRow[] = [{ ...machine, metadata: await cipher.encryptMetadata(machine.metadata!),
            daemonState: await cipher.encryptDaemonState({ status: 'running', httpPort: 3000 }) }];
        const socketState = { status: 'running', httpPort: 4000 };
        const socketCiphertext = await cipher.encryptDaemonState(socketState);
        const entered = createDeferred<void>(), release = createDeferred<void>();
        const decrypt = platformCrypto.decryptAsyncAES;
        // Only hold the platform metadata decode; the socket, cipher and store remain real.
        vi.spyOn(platformCrypto, 'decryptAsyncAES').mockImplementationOnce(async (...args) => {
            entered.resolve(); await release.promise; return decrypt(...args);
        });
        const pending = fetchAndApplyMachines({ ...inventory.callbacks,
            credentials: { ...credentials, secret: encodeBase64(secret, 'base64url') }, expectedAccountMode: 'e2ee',
            encryption, machineDataKeys: new Map(), request: async () => Response.json(rows),
            applyMachineDisplayEntries: (machines, options) => storage.getState().replaceMachineDisplays(machines,
                { sourceServerId: inventory.serverId, ...options }),
        });
        try {
            await entered.promise;
            const update = await buildUpdatedMachineFromSocketUpdate({ existingMachine: storage.getState().machines.online,
                machineUpdate: { machineId: 'online', daemonState: { version: 2, value: socketCiphertext } },
                updateSeq: 2, updateCreatedAt: machine.updatedAt + 1,
                getMachineEncryption: id => encryption.getMachineEncryption(id) });
            expect(update).not.toBeNull();
            storage.getState().applyMachines([update!], false, { sourceServerId: inventory.serverId });
            release.resolve(); await pending;
            expect(storage.getState().machines.online).toMatchObject({ metadata: machine.metadata, metadataVersion: 2,
                daemonState: socketState, daemonStateVersion: 2, availability: { kind: 'available' } });
        } finally { release.resolve(); await pending; }
    });

    it.each(['cold', 'retained', 'refreshing'] as const)('admits a hydrated active row before an offline peer completes, starting %s', async (initial) => {
        const inventory = createInventory();
        const profile = { id: inventory.serverId, serverIdentityId: inventory.serverId, name: 'Test Home',
            serverUrl: 'https://census.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
        const snapshot = () => resolveAllProfileMachineInventorySnapshots({ profiles: [profile],
            activeServerId: inventory.serverId, activeMachines: Object.values(storage.getState().machines),
            machineListByServerId: storage.getState().machineListByServerId,
            machineListStatusByServerId: storage.getState().machineListStatusByServerId,
            accountScopesByServerId: new Map([[inventory.serverId, { serverId: inventory.serverId, accountId: 'account-1' }]]),
            loadWarmEntries: () => ({}) })[0];
        const liveRows = () => readLiveMachineInventoryRows({ profile, serverIdentityId: inventory.serverId,
            activeServerId: inventory.serverId, activeMachines: Object.values(storage.getState().machines),
            machineListByServerId: storage.getState().machineListByServerId,
            machineListStatusByServerId: storage.getState().machineListStatusByServerId });
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const dataKey = new Uint8Array(32).fill(23);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64');
        const rows: FetchedMachineRow[] = [];
        for (const id of ['offline', 'active']) {
            const machine = createMachineFixture({ id, active: id === 'active', activeAt: id === 'active' ? Date.now() : 1, metadataVersion: 2 });
            await encryption.initializeMachines(new Map([[id, dataKey]]));
            rows.push({ ...machine, metadata: await encryption.getMachineEncryption(id)!.encryptMetadata(machine.metadata!),
                daemonState: null, daemonStateVersion: 0, dataEncryptionKey: envelope });
        }
        if (initial !== 'cold') storage.getState().applyMachines([createMachineFixture({ id: 'active',
            activeAt: Date.now(), daemonStateVersion: 0, storageMode: 'e2ee', dataEncryptionKey: envelope, availability: { kind: 'available' } })],
            false, { sourceServerId: inventory.serverId });
        if (initial === 'refreshing') storage.getState().markMachineListSettled(inventory.serverId);
        const inventoryStatus = initial === 'refreshing' ? 'idle' : 'loading';
        const activeStarted = createDeferred<void>();
        const offlineStarted = createDeferred<void>();
        const releaseActive = createDeferred<void>();
        const releaseOffline = createDeferred<void>();
        let decryptions = 0;
        const decrypt = platformCrypto.decryptAsyncAES;
        // Hold only native crypto; real sync ordering, admission, encryption and store remain composed.
        vi.spyOn(platformCrypto, 'decryptAsyncAES').mockImplementation(async (...args) => {
            const active = decryptions++ === 0;
            (active ? activeStarted : offlineStarted).resolve();
            await (active ? releaseActive : releaseOffline).promise;
            return decrypt(...args);
        });
        const pending = fetchAndApplyMachines({ ...inventory.callbacks,
            credentials: { ...credentials, secret: encodeBase64(secret, 'base64url') }, expectedAccountMode: 'e2ee',
            encryption, machineDataKeys: new Map(), replace: true, machineDisplayHydrationConcurrencyLimit: 1,
            request: async () => Response.json(rows),
            applyMachineDisplayEntries: (machines, options) => storage.getState().replaceMachineDisplays(machines,
                { sourceServerId: inventory.serverId, ...options }),
        });
        try {
            await activeStarted.promise;
            expect(inventory.read().machines).toHaveLength(2);
            expect(snapshot()).toMatchObject({ inventoryStatus, executionEligibleMachineIds: [] });
            expect(liveRows().size).toBe(0);
            releaseActive.resolve();
            await offlineStarted.promise;
            // Input order was offline first: the existing owner hydrated the active row first.
            expect(storage.getState().machines.active).toMatchObject({ metadataVersion: 2, availability: { kind: 'available' } });
            expect(storage.getState().machines.offline?.metadata).toBeNull();
            expect(inventory.read().status).toBe(inventoryStatus);
            expect([...liveRows()].map(machine => machine.id)).toEqual(['active']);
            expect(snapshot()).toMatchObject({ inventoryStatus, executionEligibleMachineIds: ['active'] });
            for (const status of ['error', 'signedOut'] as const) {
                storage.setState({ machineListStatusByServerId: { [inventory.serverId]: status } });
                expect(liveRows().size).toBe(0);
                expect(snapshot()).toMatchObject({ executionEligibleMachineIds: [] });
            }
        } finally {
            releaseActive.resolve();
            releaseOffline.resolve();
            await pending;
        }
        expect(inventory.read().status).toBe('idle');
    });

    it('does not settle on a socket row while the full Home list is still in flight', async () => {
        const inventory = createInventory();
        const response = createDeferred<Response>();
        const rows = ['first', 'last'].map(id => createPlainMachineRowFixture({ id, accountId: 'account-1' }));
        const pending = fetchAndApplyMachines({ ...inventory.callbacks, credentials,
            encryption: null, machineDataKeys: new Map(), replace: true, request: () => response.promise });
        try {
            storage.getState().applyMachines([createMachineFixture({ id: 'socket-first' })], false,
                { sourceServerId: inventory.serverId });
            expect(inventory.read().machines).toHaveLength(1);
            expect(inventory.read().status).not.toBe('idle');
            response.resolve(Response.json(rows));
            await pending;
            expect(inventory.read().status).toBe('idle');
            expect(inventory.read().machines?.map(machine => machine.id)).toEqual(['first', 'last']);
            // Once a full read has completed, incremental updates retain its settled fact.
            storage.getState().applyMachines([createMachineFixture({ id: 'later-socket' })]);
            expect(inventory.read().status).toBe('idle');
        } finally {
            response.resolve(Response.json(rows));
            await pending;
        }
    });

    it.each(['success', 'failure'] as const)('keeps display-first hydration joined before a newer list %s', async (outcome) => {
        const inventory = createInventory();
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const machine = createMachineFixture({ id: 'slow-machine' });
        const dataKey = new Uint8Array(32).fill(23);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64');
        await encryption.initializeMachines(new Map([[machine.id, dataKey]]));
        const ciphertext = await encryption.getMachineEncryption(machine.id)!.encryptMetadata(machine.metadata!);
        const rows: FetchedMachineRow[] = [{ ...machine, metadata: ciphertext, daemonState: null,
            dataEncryptionKey: envelope, daemonStateVersion: 0 }];
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        let reads = 0;
        const refresh = new InvalidateSync(async () => {
            const first = reads++ === 0;
            await fetchAndApplyMachines({ ...inventory.callbacks,
                credentials: { ...credentials, secret: encodeBase64(secret, 'base64url') },
                expectedAccountMode: 'e2ee', encryption, machineDataKeys: new Map(), replace: true,
                request: async () => first ? Response.json(rows) : outcome === 'failure'
                    ? Response.json({}, { status: 503 }) : Response.json([]),
                applyMachineDisplayEntries: (machines, options) => storage.getState().replaceMachineDisplays(machines,
                    { sourceServerId: inventory.serverId, ...options }),
            });
        });
        const decrypt = platformCrypto.decryptAsyncAES;
        // Gate only the native crypto boundary; the list, encryption, and store owners stay real.
        vi.spyOn(platformCrypto, 'decryptAsyncAES').mockImplementationOnce(async (...args) => {
            started.resolve();
            await release.promise;
            return decrypt(...args);
        });
        const first = refresh.invalidateAndAwait();
        let next: Promise<void> | undefined;
        try {
            await started.promise;
            expect(inventory.read().machines).toHaveLength(1);
            expect(inventory.read().machines?.[0]?.metadata).toBeNull();
            expect(inventory.read().status).not.toBe('idle');
            next = refresh.invalidateAndAwait();
            // Drain the next event-loop turn: a detached first read would let
            // the real invalidation owner run the second list before release.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            expect(reads).toBe(1);
            release.resolve();
            await first;
            await next;
            expect(reads).toBe(2);
            expect(inventory.read().status).toBe(outcome === 'failure' ? 'error' : 'idle');
            if (outcome === 'failure') {
                expect(inventory.read().machines?.[0]?.metadata?.host).toBe(machine.metadata?.host);
            } else {
                expect(inventory.read().machines).toEqual([]);
            }
        } finally {
            release.resolve();
            await first;
            await next;
            refresh.stop();
        }
    });

    it('settles a completed empty list', async () => {
        const inventory = createInventory();
        await fetchAndApplyMachines({ ...inventory.callbacks, credentials,
            encryption: null, machineDataKeys: new Map(), request: async () => Response.json([]) });
        expect(inventory.read()).toEqual({ machines: [], status: 'idle' });
    });

    it('does not report completion for a retired read or clear a list failure on an incremental row', async () => {
        const inventory = createInventory();
        const response = createDeferred<Response>();
        let current = true;
        const pending = fetchAndApplyMachines({ ...inventory.callbacks, credentials, encryption: null,
            machineDataKeys: new Map(), shouldContinue: () => current, request: () => response.promise });
        current = false;
        response.resolve(Response.json([]));
        await pending;
        expect(inventory.read().status).not.toBe('idle');
        await fetchAndApplyMachines({ ...inventory.callbacks, credentials, encryption: null,
            machineDataKeys: new Map(), request: async () => Response.json({}, { status: 503 }) });
        storage.getState().applyMachines([createMachineFixture()], false, { sourceServerId: inventory.serverId });
        expect(inventory.read().status).toBe('error');
        // Recovery also uses a completed read, including an empty response.
        await fetchAndApplyMachines({ ...inventory.callbacks, credentials, encryption: null,
            machineDataKeys: new Map(), replace: true, request: async () => Response.json([]) });
        expect(inventory.read()).toEqual({ machines: [], status: 'idle' });
    });
});
