import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    DaemonLocalServiceInventorySnapshotResponseV1Schema,
    DaemonLocalServiceInventoryWatchResponseV1Schema,
    LocalServiceInventorySnapshotV1Schema,
} from '@happier-dev/protocol/local/services/inventory/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { installLocalServiceCensusFixture, localServiceProcfsFixture } from './censusFixture.testkit';
import { scanPlatformLocalServices } from './scan';

// Only OS process files are substituted; platform scanning, census, normalization,
// registry/routes and strict RPC projection all use their production implementations.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
});

const pid = 1234567;
const workspace = { id: 'accepted-checkout', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo/web', createdAtMs: 1 };
const tcpHeader = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';

beforeEach(() => {
    const rows = [{ pid, command: ['node', 'vite'], cwd: workspace.rootPath }];
    installLocalServiceCensusFixture(rows);
    const processFiles = localServiceProcfsFixture(rows);
    vi.mocked(fs.readFile).mockImplementation(async path => {
        if (String(path) === '/proc/net/tcp') return `${tcpHeader}\n0: 0100007F:1435 00000000:0000 0A 0:0 00:0 0 501 0 12345`;
        if (String(path) === '/proc/net/tcp6') return tcpHeader;
        return processFiles.readFile(String(path));
    });
    vi.mocked(fs.readdir).mockImplementation(async path => (
        String(path) === `/proc/${pid}/fd` ? ['3'] : await processFiles.readdir(String(path))
    ) as never);
    vi.mocked(fs.readlink).mockImplementation(async path => (
        String(path) === `/proc/${pid}/fd/3` ? 'socket:[12345]' : await processFiles.readlink(String(path))
    ));
});
afterEach(() => vi.restoreAllMocks());

describe('Linux inventory scan to Inventory V1 RPC', () => {
    it('retains accepted-checkout rows while keeping native connection observations inside the daemon', async () => {
        const runtime = createLocalServicesDaemonRuntime({ machineId: workspace.machineId, startLoop: false,
            processEnv: {}, now: () => 1_000, scan: scanPlatformLocalServices,
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                features: { localServices: { enabled: true, inventory: { enabled: true } } }, capabilities: {},
            }) }),
            // The Account-row source is a transport boundary, with no credentials from a live stack.
            workspaceFacts: () => ({ facts: [{ id: workspace.id, path: workspace.rootPath }],
                acceptedWorkspaceRefs: [workspace], diagnostics: [] }),
        });
        try {
            const internal = await runtime.inventoryRoutes.refreshSnapshot();
            expect(internal.diagnostics).toEqual([]);
            expect(internal.entries).toEqual([expect.objectContaining({ port: 5173, establishedConnections: 0,
                provenance: expect.objectContaining({ workspace: { id: workspace.id, path: workspace.rootPath, association: 'cwd_containment' } }),
            })]);
            // Reproduce the actual originating failure, rather than guessing a procfs diagnostic.
            const unprojected = LocalServiceInventorySnapshotV1Schema.safeParse(internal);
            expect(unprojected.success).toBe(false);
            if (unprojected.success) throw new Error('Expected a private native observation to fail closed Inventory V1');
            expect(unprojected.error.issues).toContainEqual(expect.objectContaining({ code: 'unrecognized_keys',
                path: ['entries', 0], keys: ['establishedConnections'] }));

            const rpc = new RpcHandlerManager({ scopePrefix: workspace.machineId, encryptionMode: 'plain', logger() {} });
            registerDaemonLocalServicesMachineRpcHandlers(rpc, { accountId: 'account-a', machineId: workspace.machineId,
                serverId: workspace.serverId, localServicesInventory: runtime.inventoryRoutes });
            for (const method of [RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
                RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH, RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH]) {
                const response = await rpc.invokeLocal(method, { machineId: workspace.machineId,
                    ...(method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? { sinceGeneratedAt: 0 } : {}) });
                const parsed = method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH
                    ? DaemonLocalServiceInventoryWatchResponseV1Schema.parse(response)
                    : DaemonLocalServiceInventorySnapshotResponseV1Schema.parse(response);
                if (!('snapshot' in parsed)) throw new Error('Expected the current inventory snapshot');
                expect(parsed.snapshot.entries).toHaveLength(1);
                expect(parsed.snapshot.entries[0]?.provenance?.workspace?.id).toBe(workspace.id);
                expect(parsed.snapshot.entries[0]).not.toHaveProperty('establishedConnections');
            }
            expect(runtime.inventoryRegistry.getSnapshot().entries[0]?.establishedConnections).toBe(0);
        } finally { await runtime.stop(); }
    });
});
