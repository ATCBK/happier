import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { assertActionOutputContract } from '@/testkit/actionOutputContract';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createLocalServicesDaemonRuntimeActionExecutor } from '../../actions/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from '../../featureGate';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

// Only OS process files are substituted; platform scanning, census, normalization,
// registry/routes and strict RPC projection all use their production implementations.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
});

const pid = 1234567;
const workspace = { id: 'accepted-checkout', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo/web', createdAtMs: 1 };
const tcpHeader = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';

function installScan(command: readonly string[], bind: string) {
    const rows = [{ pid, command, cwd: workspace.rootPath }];
    installLocalServiceCensusFixture(rows);
    const processFiles = localServiceProcfsFixture(rows);
    vi.mocked(fs.readFile).mockImplementation(async path => {
        if (String(path) === '/proc/net/tcp') return `${tcpHeader}\n0: ${bind}:1435 00000000:0000 0A 0:0 00:0 0 501 0 12345`;
        if (String(path) === '/proc/net/tcp6') return tcpHeader;
        return processFiles.readFile(String(path));
    });
    vi.mocked(fs.readdir).mockImplementation(async path => (
        String(path) === `/proc/${pid}/fd` ? ['3'] : await processFiles.readdir(String(path))
    ) as never);
    vi.mocked(fs.readlink).mockImplementation(async path => (
        String(path) === `/proc/${pid}/fd/3` ? 'socket:[12345]' : await processFiles.readlink(String(path))
    ));
}
afterEach(() => vi.restoreAllMocks());

describe('Linux inventory scan to Inventory V1 RPC', () => {
    it.each([
        { name: 'long unicode command and wildcard bind', command: ['node', 'serve', '界🚀'.repeat(700)], bind: '00000000' },
        { name: 'empty argv and loopback bind', command: [], bind: '0100007F' },
        { name: 'ordinary listener with missing optional facts', command: ['node', 'vite'], bind: '0100007F' },
    ])('emits registered inventory/refresh/launcher outputs for $name without leaking collector fields', async ({ command, bind }) => {
        installScan(command, bind);
        const runtime = createLocalServicesDaemonRuntime({ machineId: workspace.machineId, startLoop: false,
            processEnv: {}, now: () => 1_000, scan: scanPlatformLocalServices,
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                features: { localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true } } }, capabilities: {},
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

            const featureGate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({
                    status: 'ready', features: FeaturesResponseSchema.parse({ features: {
                        localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true },
                            managed: { enabled: true }, preview: { enabled: true }, actions: { enabled: true } },
                        browser: { enabled: true, viewTargets: { enabled: true } },
                    }, capabilities: {} }),
                }) });
            await featureGate.refresh();
            const actionProducer = createLocalServicesDaemonRuntimeActionExecutor({
                routes: { inventoryRoutes: runtime.inventoryRoutes, launcherRoutes: runtime.launcherRoutes }, featureGate,
            });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), runtimeActionExecute: actionProducer });
            for (const actionId of ['localServices.inventory.list', 'localServices.inventory.refresh', 'localServices.launcher.snapshot'] as const) {
                const output = await actionProducer({ actionId, input: { machineId: workspace.machineId }, context: { surface: 'cli' } });
                expect(output).not.toHaveProperty('errorCode');
                assertActionOutputContract(actionId, output);
                expect(await executor.execute(actionId, { machineId: workspace.machineId }, { surface: 'cli' }))
                    .toMatchObject({ ok: true, result: output });
            }

            const rpc = new RpcHandlerManager({ scopePrefix: workspace.machineId, encryptionMode: 'plain', logger() {} });
            registerDaemonLocalServicesMachineRpcHandlers(rpc, { accountId: 'account-a', machineId: workspace.machineId,
                serverId: workspace.serverId, localServicesInventory: runtime.inventoryRoutes, localServicesLauncher: runtime.launcherRoutes });
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
                assertActionOutputContract(method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH
                    ? 'localServices.inventory.refresh' : 'localServices.inventory.list', parsed.snapshot);
            }
            const launcher = DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(await rpc.invokeLocal(
                RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT, { machineId: workspace.machineId },
            ));
            assertActionOutputContract('localServices.launcher.snapshot', launcher.snapshot);
            expect(launcher.snapshot.targets).toEqual([expect.objectContaining({
                sourceClass: { kind: 'inventory_entry', inventoryEntryId: internal.entries[0]!.id },
            })]);
            expect(runtime.inventoryRegistry.getSnapshot().entries[0]?.establishedConnections).toBe(0);
        } finally { await runtime.stop(); }
    });
});
