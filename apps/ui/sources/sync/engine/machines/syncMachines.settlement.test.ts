import { afterEach, describe, expect, it, vi } from 'vitest';
import * as platformCrypto from 'rn-encryption';

import { createDeferred, createMachineFixture } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveServerScopedMachineInventory } from '@/sync/domains/machines/resolveServerScopedMachines';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { InvalidateSync } from '@/utils/sessions/sync';

import { fetchAndApplyMachines, type FetchedMachineRow } from './syncMachines';

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
