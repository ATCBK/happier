import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, PluginManifestV2Schema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as LIMA_MANIFEST } from '@happier-dev/plugins-machine-lima/manifest';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { logger } from '@/ui/logger';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createDaemonPluginAvailabilityReporter } from '@/plugins/availability/daemonReporter';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

// Model a cold daemon with no last-green UI graph at the filesystem boundary.
// Discovery, runtime construction, source admission and availability stay real.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
    const publication = createBundledPluginPublicationFsFixture(actual);
    return {
        ...publication,
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) => (
            String(args[0]).replaceAll('\\', '/').endsWith('/dist/happier-plugin-ui/ui-artifacts.json')
                ? JSON.stringify({ version: 2, entries: [] })
                : publication.readFileSync(...args)
        ),
    };
});

afterEach(() => vi.restoreAllMocks());

describe('daemon release-less declaration publication', () => {
    it('starts without a last-green UI graph and publishes unaffected declarations without native activation', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-native-declaration-'));
        const manifest = PluginManifestV2Schema.parse(LIMA_MANIFEST);
        expect(manifest.hostAccess.required.some(access => access.capability === 'storage.account')).toBe(false);
        expect(manifest.contributes.accountCollections).toEqual([]);
        const credentials = { token: 'declaration-account', encryption: null } satisfies StoredCredentials;
        const events: string[] = [];
        const claims: unknown[] = [];
        const diagnostics = vi.spyOn(logger, 'debug');
        const controller = createPluginReloadController({ happyHomeDir });
        let owner: ReturnType<typeof createDaemonPluginRuntimeOwner> | undefined;
        try {
            // Substitute only the Availability HTTP boundary; the real reporter,
            // registry, source admission and Account claim owner remain composed.
            vi.spyOn(axios, 'post').mockImplementation(async () => {
                events.push('materializations');
                return { data: { revision: 1, outcome: 'replaced' }, status: 200, statusText: 'OK', headers: {}, config: { headers: new axios.AxiosHeaders() } };
            });
            const reporter = createDaemonPluginAvailabilityReporter({ credentials, getMachineId: () => 'declaration-controller',
                serverFeaturesSnapshotStore: { getSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_declaration' } } }) }) } });
            // Lima declaration publication has no Connected Account purpose.
            // Unrelated bundled startup services see unavailable credentials.
            const unused = async (): Promise<never> => { throw new Error('Unexpected Connected Account operation'); };
            const connectedAccounts: StablePluginConnectedAccountsOwner = {
                getBinding: unused, requestSelection: unused, materialize: unused,
                listAccounts: unused, materializeListedAccount: unused, watch: () => { throw new Error('Unexpected Connected Account watch'); },
            };
            owner = createDaemonPluginRuntimeOwner({ happyHomeDir, staleCandidateCleanup: 'disabled', reloadController: controller,
                connectedAccounts, availabilityReporter: reporter, accountStorageDependencies: {
                    readCredentials: async () => credentials, isCurrentAccount: () => true,
                    resolveAccountScopeKey: () => resolveAccountSettingsScopeKey(credentials),
                    resolveBaseUrl: () => 'https://declaration.example.test',
                    http: {
                        get: async () => { throw new Error('Declaration publication must not read Account data'); },
                        post: async (url, body) => {
                            expect(url).toBe('https://declaration.example.test/v1/plugins/availability/collection-writers/claim');
                            const claim = JSON.parse(body);
                            if (claim.manifest.id === manifest.id) { claims.push(claim); events.push('lima-claim'); }
                            return { status: 200, data: {} };
                        },
                    },
                } });
            await owner.initialize();
            const runtime = controller.getState().activeRegistry;
            expect(runtime).not.toBeNull();
            if (!runtime) throw new Error('Expected a published daemon registry');
            const projection = buildPluginProjectionV2({ registry: runtime.contributes, generation: 1 });
            const ui = projection.familiesById.pluginUi;
            if (ui?.family !== 'pluginUi') throw new Error('Expected the daemon UI projection');
            expect(Object.values(ui.entriesById)).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    pluginId: 'happier.triage', contributionKind: 'reactNativeBundle',
                    runtime: expect.objectContaining({ state: 'blocked',
                        decision: expect.objectContaining({ reason: 'generated_react_native_artifact_missing' }),
                    }),
                }),
            ]));
            await vi.waitFor(() => expect(events, JSON.stringify(diagnostics.mock.calls)).toContain('materializations'));
            await vi.waitFor(() => expect(claims).toEqual([{ manifest }]));
            expect(events.indexOf('lima-claim')).toBeGreaterThan(events.indexOf('materializations'));
            expect(controller.getState().activeRegistry?.activatedPluginIds.has(manifest.id)).toBe(false);
        } finally {
            await owner?.changeService.shutdown();
            await controller.shutdown();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    }, 120_000);
});
