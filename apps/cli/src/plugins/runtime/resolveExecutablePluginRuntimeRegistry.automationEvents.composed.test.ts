import { setImmediate } from 'node:timers/promises';
import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, type PluginServices } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionForDefinition } from '@happier-dev/plugin-sdk/collections';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import {
    createPluginEventAutomationSetupResultV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/events';
import {
    AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
    AutomationEventStoredDefinitionsReadHttpRequestV1Schema,
    AutomationEventStoredDefinitionsReadResultV1Schema,
    AutomationEventActionHttpPathsV1,
    AutomationEventActionHttpRequestSchemasV1,
} from '@happier-dev/protocol/automations/event';

import * as persistence from '@/persistence';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createGithubAutomationEventCheckpointedPullObserver } from '../../../../../packages/plugins/scm-github/src/observations/githubAutomationEventObserver';
import { GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION } from '../../../../../packages/plugins/scm-github/src/observations/githubAutomationEventCheckpoint';

const pluginId = 'happier.scm.forge.github';
const machineId = 'machine-automation-observer';
const listInput = { transport: { kind: 'checkpointedPull' } } as const;
const sourceConfigSchema = { type: 'object' } as const;

function httpResponse<T>(data: T): AxiosResponse<T> {
    return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

afterEach(() => vi.restoreAllMocks());

describe('admitted Automation Event background caller composition', () => {
    it('adopts an empty catalog with authorized status writes and parks, without lending successor authority', async () => {
        // HTTP and OS persistence are boundaries; signing, source admission,
        // caller stamping, Action execution and definition adoption stay real.
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, machineId });
        const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/encryption/currentness')) return httpResponse({
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
            });
            if (String(url).endsWith('/v1/account/profile')) return httpResponse({ id: 'account-observer' });
            throw new Error(`Unexpected GET ${url}`);
        });
        const callers: Array<ReturnType<typeof AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse>['caller']> = [];
        const catalogStates: string[] = [];
        const accountSettings = accountSettingsParse({ actionsSettingsV1: {
            v: 1, actions: {},
            approvalWaivedSurfaces: { 'automation.event.source.status.report': ['plugin'] },
        } });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith(AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1)) {
                callers.push(AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse(body).caller);
                return httpResponse(AutomationEventStoredDefinitionsReadResultV1Schema.parse({
                    kind: 'page', revision: '7', definitions: [], nextCursor: null,
                    eventDeclarationRelease: {
                        release: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    },
                }));
            }
            if (String(url).endsWith(AutomationEventActionHttpPathsV1['automation.event.source.status.report'])) {
                const request = AutomationEventActionHttpRequestSchemasV1['automation.event.source.status.report'].parse(body);
                if (request.input.kind === 'catalogReconciliation') catalogStates.push(request.input.state);
                return httpResponse({});
            }
            throw new Error(`Unexpected POST ${url}`);
        });

        const createOccurrence = async (predecessor?: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>) => {
            const sleep = vi.fn(async (_delay: number, signal: AbortSignal) => {
                await new Promise<void>(resolve => {
                    if (signal.aborted) resolve();
                    else signal.addEventListener('abort', () => resolve(), { once: true });
                });
            });
            const observer = createGithubAutomationEventCheckpointedPullObserver({ sleep });
            const checkpointTable = {
                query: async () => ({ rows: [], changeCursor: 0 }),
            } satisfies Pick<PluginAccountCollectionForDefinition<typeof GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION>, 'query'>;
            const observed: { actions?: PluginServices['actions']; page?: unknown; error?: unknown; completed: boolean } = { completed: false };
            const plugin = definePlugin({
                id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
                actions: {
                    setup: { title: 'Setup', surfaces: ['plugin'], dangerLevel: 'safe',
                        inputSchema: sourceConfigSchema,
                        resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceConfigSchema),
                        run: () => { throw new Error('Empty catalog must not run setup'); } },
                    reset: { title: 'Reset', surfaces: ['plugin'], dangerLevel: 'safe',
                        inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
                        resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
                        run: () => { throw new Error('Empty catalog must not reset a source'); } },
                },
                events: { changed: { declaration: {
                    kind: 'event', title: 'Changed', payloadSchema: { type: 'object' },
                    automation: { v: 1, eligible: true, source: {
                        sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
                        sourceConfigSchema,
                        setupActionRef: { pluginId, localId: 'setup' },
                        historyGapResetActionRef: { pluginId, localId: 'reset' },
                        connectedAccountPurposeBindings: [],
                    } },
                } } },
                backgroundServices: [{ declaration: { id: 'observer', title: 'Observer' }, runner: async context => {
                    observed.actions = context.services.actions;
                    try {
                        observed.page = await context.services.actions.execute('automation.event.sources.list', listInput);
                        // Only the empty persistent checkpoint table is substituted.
                        // Its query is outside this caller/adoption wiring contract.
                        const storage = { ...context.services.storage, account: { collection(definition: { id: string }) {
                            if (definition.id !== GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION.id) throw new Error('Unexpected Collection');
                            return checkpointTable;
                        } } } as unknown as PluginServices['storage'];
                        await observer.run({ ...context, services: { ...context.services, storage } });
                    } catch (error) {
                        observed.error = error;
                    } finally {
                        observed.completed = true;
                    }
                } }],
            });
            const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
                ...(predecessor ? { happyHomeDir: predecessor.happyHomeDir, controller: predecessor.controller } : {}),
                plugins: [{ manifest: plugin.manifest,
                    files: { 'daemon.mjs': `export function activate() {} // ${predecessor ? 'successor' : 'incumbent'}` },
                    replaceExisting: predecessor !== undefined,
                    instantiateCommittedModule: () => ({ activate: plugin.activate }),
                }],
                async resolveContributes(happyHomeDir) {
                    return createResolvedContributionRegistry(projectLoadedPluginContributes({
                        loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'builtin',
                    }));
                },
                runtimeOptions: {
                    scopedActionRuntime: {
                        credentials: { token: 'fixture-account-token', encryption: null },
                        // This Account has explicitly allowed automatic source
                        // status writes; defaults would correctly request Ask.
                        actionsSettingsProvider: createActionSettingsProvider({
                            getAccountSettings: () => accountSettings,
                            allowEnvironmentOverride: false,
                        }),
                    },
                    resolveCurrentMachineId: () => machineId,
                    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'server-observer', machineId }),
                },
            });
            return { fixture, observed, sleep };
        };

        const incumbent = await createOccurrence();
        let successor: Awaited<ReturnType<typeof createOccurrence>> | undefined;
        try {
            incumbent.fixture.registry.startAdoptedBackgroundServices?.();
            await vi.waitFor(() => {
                if (incumbent.observed.error) throw incumbent.observed.error;
                expect(incumbent.observed.page).toEqual({ kind: 'page', revision: '7', definitions: [], nextCursor: null });
            });
            await vi.waitFor(() => {
                if (incumbent.observed.error) throw incumbent.observed.error;
                expect(incumbent.sleep.mock.calls).toEqual([]);
                expect(catalogStates).toContain('current');
            });
            await setImmediate();
            expect(incumbent.observed.completed).toBe(false);
            expect(incumbent.sleep).not.toHaveBeenCalled();
            expect(callers[0]).toMatchObject({ pluginId, occurrenceId: expect.any(String),
                sourceCustody: { kind: 'managed' },
                materialization: incumbent.fixture.registry.resolveCurrentPluginMaterializationRef?.(pluginId) });
            const oldOccurrenceId = callers[0]!.occurrenceId;

            const currentReports = catalogStates.filter(state => state === 'current').length;
            successor = await createOccurrence(incumbent.fixture);
            expect(callers.at(-1)?.occurrenceId).not.toBe(oldOccurrenceId);
            await vi.waitFor(() => {
                if (successor?.observed.error) throw successor.observed.error;
                expect(successor?.observed.page).toMatchObject({ kind: 'page', revision: '7', definitions: [] });
            });
            await vi.waitFor(() => {
                expect(catalogStates.filter(state => state === 'current')).toHaveLength(currentReports + 1);
                expect(incumbent.observed.completed).toBe(true);
            });
            await setImmediate();
            expect(successor.sleep).not.toHaveBeenCalled();
            expect(successor.observed.completed).toBe(false);
            const before = { get: get.mock.calls.length, post: post.mock.calls.length };
            await expect(incumbent.observed.actions!.execute('automation.event.sources.list', listInput,
                { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
            expect({ get: get.mock.calls.length, post: post.mock.calls.length }).toEqual(before);
        } finally {
            // Drain both idempotent leases before stopping their shared owner;
            // borrowed-fixture disposal must not publish another runtime.
            await successor?.fixture.lease.release();
            await incumbent.fixture.lease.release();
            await incumbent.fixture.controller.shutdown();
            await successor?.fixture.dispose();
            await incumbent.fixture.dispose();
        }
    });
});
