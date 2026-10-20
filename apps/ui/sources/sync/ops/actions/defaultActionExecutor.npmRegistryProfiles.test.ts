import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { DaemonNpmRegistryProfileMutationRequestV1Schema,
    DaemonNpmRegistryProfileMutationResponseV1Schema, DaemonNpmRegistryProfilesGetResponseV1Schema } from '@happier-dev/protocol/rpc/npmRegistryProfiles';
import { NpmRegistryProfileActionOutputSchemasV1 } from '@happier-dev/protocol/actions/npmRegistryProfileActionFamily';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc.machine }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { storage } = await import('@/sync/domains/state/storageStore');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
let restorePolicy: (() => void) | null = null;

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); rpc.machine.mockReset(); });
afterEach(async () => { restorePolicy?.(); restorePolicy = null; await disconnectActiveServerConnection(); await homes.reset(); });

describe('npm registry profiles through the registered Account Action host', () => {
    it('keeps revisioned requests below admission and consumes strict daemon results without leaking native credentials', async () => {
        const serverIdentityId = 'srv_npm_registry';
        const serverId = await homes.addHome({ name: 'Registry Home', serverUrl: 'https://npm-action.test',
            serverIdentityId, accountId: 'registry-account', currentAccount: true });
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'registry-account' };
        const machine = createMachineFixture({ id: 'registry-machine', active: true, activeAt: Date.now(), installationId: 'npm-installation' });
        storage.setState({ profileScope: scope, settingsScope: scope, settingsVersion: 1, isDataReady: true,
            machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] },
            machineListStatusByServerId: { [serverId]: 'idle' } });
        const target = { serverIdentityId, machineId: machine.id };
        const context = { surface: 'ui' as const, serverId, expectedAccountId: scope.accountId };
        const snapshot = { protocolVersion: 1 as const, revision: 8, profiles: [], pausedSources: [] };
        let issued = 0;
        rpc.machine.mockImplementation(async request => {
            if (request.method === RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET)
                return DaemonNpmRegistryProfilesGetResponseV1Schema.parse({ status: 'success', snapshot });
            expect(request.method).toBe(RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE);
            const mutation = DaemonNpmRegistryProfileMutationRequestV1Schema.parse(request.payload);
            expect(mutation).toMatchObject({ machineId: target.machineId, expectedRevision: 7 });
            request.onIssued?.(); issued++;
            return DaemonNpmRegistryProfileMutationResponseV1Schema.parse({ status: 'success', snapshot });
        });
        const { resolveFreshMachineAdministrationExecutionTarget } = await import('@/sync/domains/machines/administration/useTargetSelection');
        const selected = resolveFreshMachineAdministrationExecutionTarget(target, { accountScope: scope });
        expect(selected).not.toBeNull();
        expect(await createDefaultActionExecutor().execute('plugins.npm_registry_profiles.list', { target }, context))
            .toEqual({ ok: true, result: { status: 'success', snapshot } });
        let current = true;
        let activeMutationId = 'registry-login';
        let acquisitions = 0;
        const executor = createDefaultActionExecutor({ npmRegistryProfileDelivery: {
            resolveExecutionTarget: () => selected, isCurrent: mutationId => current && mutationId === activeMutationId,
            acquireCredential: async () => { acquisitions++; return { kind: 'bearer_token', secret: 'private-native-token' }; },
        } });
        const input = { target, profileId: 'work', expectedRevision: 7, mutationId: 'registry-login' };
        const result = await executor.execute('plugins.npm_registry_profiles.login', input, context);
        expect(result).toEqual({ ok: true, result: { status: 'success', snapshot } });
        if (!result.ok) throw new Error(result.errorCode);
        expect(NpmRegistryProfileActionOutputSchemasV1['plugins.npm_registry_profiles.login'].safeParse(result.result).success).toBe(true);
        expect(JSON.stringify(result)).not.toContain('private-native-token');
        expect(acquisitions).toBe(1);
        expect(issued).toBe(1);
        const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
        const originalPolicy = storage.getState().settings.actionsSettingsV1;
        restorePolicy = () => storage.getState().applySettingsLocal({ actionsSettingsV1: originalPolicy });
        const disabledPolicy = normalizeActionsSettingsV1({ v: 1,
            actions: { 'plugins.npm_registry_profiles.login': { disabledSurfaces: ['ui'] } } });
        // This fixture restored settingsScope, so its live Account settings are
        // authoritative over the HTTP baseline, exactly as in a mounted app.
        storage.getState().applySettingsLocal({ actionsSettingsV1: disabledPolicy });
        homes.answer(serverId, '/v2/account/settings', { body: { version: 2, content: { t: 'plain', v: {
            actionsSettingsV1: disabledPolicy,
        } } } });
        expect(await executor.execute('plugins.npm_registry_profiles.login', input, context)).toMatchObject({ ok: false });
        expect(acquisitions).toBe(1);
        expect(issued).toBe(1);
        restorePolicy();
        homes.answer(serverId, '/v2/account/settings', { body: { version: 3, content: { t: 'plain', v: {} } } });
        // A late approval for an old A selection cannot borrow a new A invocation's token.
        activeMutationId = 'registry-login-new';
        expect(await executor.execute('plugins.npm_registry_profiles.login', input, context))
            .toMatchObject({ ok: false, errorCode: 'npm_registry_target_not_current' });
        expect(acquisitions).toBe(1);
        expect(issued).toBe(1);
        activeMutationId = input.mutationId;
        current = false;
        expect(await executor.execute('plugins.npm_registry_profiles.login', input, context))
            .toMatchObject({ ok: false, errorCode: 'npm_registry_target_not_current' });
        expect(acquisitions).toBe(1);
        expect(issued).toBe(1);
    });
});
