import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { configuration } from '@/configuration';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { createNativeUsageDaemonRuntime } from './nativeUsageDaemonRuntime';
import { createNativeUsageCaptureStore } from './nativeUsageCaptureState';
import { deriveNativeUsageAccountingIdentity } from './nativeUsageAccountingIdentity';

describe('native usage daemon lifetime', () => {
    it('retains declared Settings wakes after restoring consent without explicit discovery', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-settings-'));
        await mkdir(join(directory, 'pi', 'sessions'), { recursive: true });
        const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
        const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
        const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
        const { resolveBuiltInContributions } = await import('@/plugins/projection/registry/resolveBuiltInContributions');
        const admitted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { contributes: createResolvedContributionRegistry(resolveBuiltInContributions()), pluginIds: ['happier.agent.pi'] } });
        const observation = createExternalSessionObservationDaemonProjection({
            publishField: async () => { throw new Error('Native accounting cannot fabricate Sessions'); },
            watchFile: () => () => {},
            watchTopologyDirectory: () => () => {},
        });
        let runtime: ReturnType<typeof createNativeUsageDaemonRuntime> | undefined;
        resetActiveAccountSettingsSnapshotForTests();
        const base = { source: 'network' as const, scopeKey: 'native-settings-account', settingsVersion: 1,
            loadedAtMs: 1, settings: accountSettingsParse({ piAgentDir: join(directory, 'pi') }), settingsSecretsReadKeys: [] };
        setActiveAccountSettingsSnapshot(base);
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
            const readCredentials = vi.fn(async () => ({ token, encryption: null }));
            const create = () => createNativeUsageDaemonRuntime({
                authority: { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine' },
                installationId: 'installation', activeServerDir: directory, serverHttpBaseUrl: 'https://server.test',
                token, storage, observation, readCredentials,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
            });
            runtime = create();
            const sources = await runtime.owner.service.discover();
            const selected = sources.find(source => source.agent.pluginId === 'happier.agent.pi');
            if (!selected) throw new Error('Admitted Pi source was not discovered');
            await runtime.owner.service.setConsent(selected.sourceId, true);
            await runtime.dispose();
            runtime = create();
            await runtime.flushPending();
            await new Promise<void>(resolve => setImmediate(resolve));
            const reads = readCredentials.mock.calls.length;
            for (let index = 0; index < 25; index++) setActiveAccountSettingsSnapshot({ ...base,
                settingsVersion: index + 2, settings: accountSettingsParse({ ...base.settings, analyticsOptOut: index % 2 === 0 }) });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(readCredentials).toHaveBeenCalledTimes(reads);
            setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 27,
                settings: accountSettingsParse({ ...base.settings, piAgentDir: join(directory, 'replacement-pi') }) });
            await vi.waitFor(() => expect(readCredentials.mock.calls.length).toBeGreaterThan(reads));
        } finally {
            await runtime?.dispose(); await observation.dispose(); await admitted.dispose();
            resetActiveAccountSettingsSnapshotForTests(); await rm(directory, { recursive: true, force: true });
        }
    });
    it('starts and reconnects an empty custody scope without discovering or opening native sources', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-daemon-'));
        const observation = createExternalSessionObservationDaemonProjection({
            publishField: async () => { throw new Error('No native Session may be fabricated'); },
            // OS observation boundary: empty, unrequested startup must never acquire a watch.
            watchFile: () => { throw new Error('No native watch may start without consent'); },
        });
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const runtime = createNativeUsageDaemonRuntime({
                authority: { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine' },
                installationId: 'installation', activeServerDir: directory, serverHttpBaseUrl: 'https://server.test',
                token: 'token', storage, observation,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                // Auth boundary: initial state loading is not an inventory/disclosure request.
                readCredentials: async () => { throw new Error('No source discovery may run unrequested'); },
            });
            try {
                expect(await runtime.owner.service.get()).toEqual([]);
                await runtime.flushPending();
                expect(await runtime.owner.service.get()).toEqual([]);
            } finally { await runtime.dispose(); }
        } finally {
            await observation.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('restores consented custody truthfully when its current plugin runtime is unavailable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-unavailable-'));
        const observation = createExternalSessionObservationDaemonProjection({
            publishField: async () => { throw new Error('No native Session may be fabricated'); },
            watchFile: () => { throw new Error('Unavailable sources cannot acquire a watch'); },
        });
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine' };
            const custodyKey = storage.deriveOpaqueIdentity({ purpose: 'usage_accounting_identity',
                value: JSON.stringify(['capture', authority.serverId, authority.accountId, authority.machineId]) });
            const descriptor = { agent: { pluginId: 'fixture.unavailable', localId: 'agent' },
                source: { kind: 'fixture' }, sourceKey: 'fixture-root', root: directory, supported: true };
            const sourceId = deriveNativeUsageAccountingIdentity({ authority, storage, ...descriptor }).sourceRootKey;
            const store = createNativeUsageCaptureStore({ path: join(directory, 'usage', `${custodyKey}.sealed`), authority, storage });
            await store.save({ v: 1, authority, sources: [{ ...descriptor, sourceId, consented: true, pending: [] }] });
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
            const settledSources: Promise<unknown>[] = [];
            resetActiveAccountSettingsSnapshotForTests();
            const settings = { source: 'network' as const, scopeKey: 'native-account', settingsVersion: 1,
                loadedAtMs: 1, settings: accountSettingsParse({}), settingsSecretsReadKeys: [] };
            setActiveAccountSettingsSnapshot(settings);
            const readCredentials = vi.fn(async () => ({ token, encryption: null }));
            const runtime = createNativeUsageDaemonRuntime({
                authority, installationId: 'installation', activeServerDir: directory, serverHttpBaseUrl: 'https://server.test',
                token, storage, observation,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                readCredentials,
                invalidateSources: () => { settledSources.push(runtime.owner.service.get(sourceId)); },
            });
            try {
                await runtime.flushPending();
                expect(await runtime.owner.service.get(sourceId)).toEqual([expect.objectContaining({
                    consent: 'enabled', status: 'unavailable', errorCode: 'source_unavailable', pendingCount: 0,
                })]);
                expect(await Promise.all(settledSources)).toContainEqual([expect.objectContaining({
                    status: 'unavailable', errorCode: 'source_unavailable', pendingCount: 0,
                })]);
                const reads = readCredentials.mock.calls.length;
                for (let index = 0; index < 25; index++) setActiveAccountSettingsSnapshot({ ...settings,
                    settingsVersion: index + 2, settings: accountSettingsParse({ analyticsOptOut: index % 2 === 0 }) });
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(readCredentials).toHaveBeenCalledTimes(reads);
                setActiveAccountSettingsSnapshot({ ...settings, settingsVersion: 27, source: 'cache' });
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(readCredentials.mock.calls.length).toBeGreaterThan(reads);
            } finally { await runtime.dispose(); resetActiveAccountSettingsSnapshotForTests(); }
        } finally {
            await observation.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
