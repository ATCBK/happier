import type { Machine } from '@/sync/domains/state/storageTypes';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { MachineAgentInventoryItemSchema, type CapabilitiesDetectResponse } from '@happier-dev/protocol/capabilities';

/** Daemon declarations and native probe facts; catalog/admission projections stay real. */
export function createReadyMachineAgentInventoryFixture(agents: readonly Readonly<{ agentId: string; title: string }>[]) {
    const items = agents.map(agent => MachineAgentInventoryItemSchema.parse({ ...agent,
        installed: true, version: '1.0.0', latestVersion: null, update: { supported: false, command: null },
        signIn: { status: 'signedIn', loginSupport: 'status_only' }, platform: { supported: true },
        install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
    }));
    return {
        projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: Object.fromEntries(items.map(item => [item.agentId, {
            id: item.agentId, title: item.title, isBuiltIn: true, providerOwnedEnvironmentKeys: [],
            capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }])) }),
        capabilities: { protocolVersion: 1, results: Object.fromEntries(items.map(item => [`cli.${item.agentId}`, {
            ok: true, checkedAt: 1, data: { ...item, isLoggedIn: true, authStatus: { state: 'logged_in', checkedAt: 1 } },
        }])) } satisfies CapabilitiesDetectResponse,
    };
}

/** Already-hydrated client row; pending/locked fixtures override its admitted availability. */
export function createMachineFixture(overrides: Partial<Machine> = {}): Machine {
    const createdAt = overrides.createdAt ?? 1;
    const updatedAt = overrides.updatedAt ?? createdAt;

    return {
        id: 'machine-1',
        seq: 1,
        createdAt,
        updatedAt,
        active: true,
        activeAt: updatedAt,
        metadata: {
            host: 'tester.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happy-dev',
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        availability: { kind: 'available' },
        ...overrides,
    };
}

export function createMachineListByServerIdFixture(
    machines: Machine[],
    serverId: string = 'server-a',
): Record<string, Machine[]> {
    return {
        [serverId]: machines,
    };
}

/** A Home census row, not an already-opened client projection. */
export function createPlainMachineRowFixture(input: Readonly<{ id: string; accountId: string }>): FetchedMachineRow {
    const machine = createMachineFixture({ id: input.id, activeAt: Date.now() });
    return {
        id: machine.id, kind: 'persistent', seq: machine.seq,
        createdAt: machine.createdAt, updatedAt: machine.updatedAt,
        active: machine.active, activeAt: machine.activeAt,
        metadata: encodePlainMachineStoredContent(machine.metadata), metadataVersion: machine.metadataVersion,
        daemonState: null, daemonStateVersion: machine.daemonStateVersion,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        revokedAt: null, replacedByMachineId: null, installationId: 'test-installation',
        access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId: input.accountId, displayName: 'Test Account' },
            role: 'manage', resourceMode: 'plain', accessState: 'ready' }),
    };
}
