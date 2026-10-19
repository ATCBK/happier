import type { PluginClientActionContext } from '@happier-dev/plugin-sdk/actions';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { PluginSearchResultV1Schema } from '@happier-dev/protocol';
import { PluginUiTargetedContributionsV1Schema } from '@happier-dev/protocol/plugins/ui';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../corpus/testkit/observations.test-support.js';
import { parseTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import { TRIAGE_APP_PAGE_LOCAL_ID_V1 } from '../composer/openEntryDetails.js';
import { TRIAGE_LIST_DEFAULT_LENS_V1 } from '../projection/listWindow.js';
import { createTriageEphemeralSharedScopeFixture } from '../ui/window/ephemeralSharedScope.test-support.js';
import {
    acquireTriageListWindow,
    readTriageListWindowSnapshot,
    refreshTriageListWindow,
    setTriageListWindowLens,
} from '../ui/window/mountedWindow.js';
import { createTriageListEntriesActionHandler } from './listEntries.js';
import { createTriageSearchEntriesActionHandler } from './searchEntries.js';
import * as searchActionArtifact from './searchEntries.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { createPluginRegistrationScope } from '@happier-dev/plugin-sdk/host/registration';
import { derivePluginClientContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { TriageAdmittedSourceV1 } from './listEntries.js';

/**
 * The first real producer of `contributes.searchProviders`.
 *
 * It proves the whole vertical from the plugin's side: the declared query
 * Action answers the canonical `{ query, limit }` input with rows that satisfy
 * the canonical result schema, the rows come from the SAME canonical matcher
 * the list and Composer picker use, and each row's activation is the incumbent
 * open owner's exact launch input rather than a route the host would have to
 * understand.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_DESCRIPTOR = {
    v: 1, purpose: 'triage-source', displayName: 'Example forge',
    kinds: [
        { id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
        { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' },
    ],
};

type SearchEntryFixture = Readonly<{
    entryId: string;
    title: string;
    collisionScope?: string;
    scopeLabel?: string;
    present?: boolean;
    kindId?: string;
    designation?: string;
}>;

function createDaemonContext(snapshots: readonly SearchEntryFixture[]): PluginInvocationContext {
    const { collections, control } = createTestkitCorpusCollections();
    control.sourceInstances.seed(toCorpusStoredValue({
        instanceTag: `a${'0'.repeat(42)}`,
        sourceQualifiedId: `${SOURCE.pluginId}/${SOURCE.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1,
        configured: TriageConfiguredSourceInstanceV1Schema.parse({
            v: 1,
            instance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
            binding: {
                purpose: 'triage-source',
                account: { service: { pluginId: SOURCE.pluginId, localId: 'accounts' }, accountId: 'account-1' },
            },
            localInstanceKey: 'example/repository',
            configuration: { v: 1, token: 'routing-token' },
        }),
    }));

    const admitted = [{
        contributor: {
            pluginId: SOURCE.pluginId,
            contributionId: SOURCE.localId,
            immutableGenerationId: 'generation-1',
        },
        protocol: {
            id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
            version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        },
        descriptor: SOURCE_DESCRIPTOR,
        operations: { listInstances: {}, scan: { role: 'scan' }, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];

    return {
        signal: new AbortController().signal,
        services: {
            storage: {
                account: {
                    collection: (definition: PluginAccountCollectionDefinition) => (
                        definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
                            ? collections.sourceInstances
                            : collections.userMarks
                    ),
                },
            },
            targetedContributions: {
                observeForSelf: () => ({
                    readCurrent: async () => ({ generation: 'generation-1', contributions: admitted }),
                    dispose: () => {},
                }),
            },
            actions: {
                // The source honours the page limit it is asked for, the way a
                // real one must: a page larger than requested breaks the scan
                // contract and the lane is refused, not silently truncated.
                executeAdmittedTargetedOperation: async (
                    _operation: unknown,
                    scanInput: { page: { kind: string; limit?: number } },
                ): Promise<TriageScanResultV1> => {
                    const pageLimit = scanInput.page.kind === 'initial'
                        ? scanInput.page.limit ?? snapshots.length
                        : snapshots.length;
                    const page = snapshots.slice(0, pageLimit);
                    return {
                        kind: 'complete',
                        observations: page.map((entry) => {
                            const localRef = {
                                kindId: entry.kindId ?? 'pull-request',
                                collisionScope: entry.collisionScope ?? 'example/repository',
                                entryId: entry.entryId,
                            };
                            return entry.present === false
                                ? { kind: 'absent' as const, localRef }
                                : {
                                    kind: 'present' as const,
                                    localRef,
                                    locator: testkitLocator(),
                                    snapshot: testkitSnapshot({
                                        title: entry.title,
                                        ...(entry.designation === undefined ? {} : { designation: entry.designation }),
                                        ...(entry.scopeLabel === undefined ? {} : { scopeLabel: entry.scopeLabel }),
                                    }),
                                    viewer: testkitViewer(),
                                };
                        }),
                        // A source that stopped at the page bound has NOT walked
                        // to the end, and saying otherwise here would let the
                        // window claim a coverage the reader does not have.
                        evidence: page.length === snapshots.length
                            ? { kind: 'walkFinished' }
                            : { kind: 'partial', reason: 'page-bound' },
                    };
                },
            },
        },
    } as unknown as PluginInvocationContext;
}

function createContext(snapshots: readonly SearchEntryFixture[]): PluginClientActionContext {
    const daemonContext = createDaemonContext(snapshots);
    const listEntries = createTriageListEntriesActionHandler();
    const executeAction = (async (
        action: string,
        input?: unknown,
        options?: Readonly<{ signal?: AbortSignal }>,
    ) => {
        expect(action).toBe('entries/list-v1');
        return await listEntries(input as never, {
            ...daemonContext,
            signal: options?.signal ?? daemonContext.signal,
        });
    }) as PluginClientActionContext['ui']['executeAction'];
    return {
        plugin: { id: 'happier.triage', version: '1.0.0' },
        contribution: {
            id: 'entries/search-v1',
            qualifiedId: 'happier.triage/actions/entries/search-v1',
        },
        invocationSurface: 'ui',
        signal: new AbortController().signal,
        ui: Object.freeze({ executeAction, openSurface: async () => {}, context: async () => ({
            targetedContributions: PluginUiTargetedContributionsV1Schema.parse({
                target: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, occurrenceId: 'triage-1',
                    sourceCustody: { kind: 'development', registeredRootId: 'triage-root' } },
                points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{
                    protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 },
                    contributions: [{ contributor: { pluginId: SOURCE.pluginId, contributionId: SOURCE.localId,
                        occurrenceId: 'source-1', sourceCustody: { kind: 'development', registeredRootId: 'source-root' } },
                        protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 },
                        descriptor: SOURCE_DESCRIPTOR, operations: [], surfaces: [] }],
                }] }],
            }),
        }) }),
        ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
    };
}

describe('the Triage universal-search query Action', () => {
    it('keeps retained entries searchable when the host has no admitted contribution snapshot', async () => {
        const base = createContext([{ entryId: '17', title: 'Fix the transcript crash' }]);
        const context: PluginClientActionContext = {
            ...base,
            ui: {
                ...base.ui,
                context: async (request) => ({
                    ...await base.ui.context(request),
                    targetedContributions: null,
                }),
            },
        };

        const result = PluginSearchResultV1Schema.parse(await createTriageSearchEntriesActionHandler()({
            query: 'crash', limit: 8,
        }, context));

        expect(result.items).toEqual([
            expect.objectContaining({ title: 'Fix the transcript crash', icon: 'info' }),
        ]);
        expect(result.items[0]?.command.kind).toBe('openSurface');
    });

    it('uses the source-declared kind glyph and designation through the strict search consumer', async () => {
        const result = PluginSearchResultV1Schema.parse(await createTriageSearchEntriesActionHandler()({ query: 'cedar', limit: 8 },
            createContext([
                { entryId: '554', title: 'Cedar issue', kindId: 'issue', designation: '#554', scopeLabel: 'happier-dev/happier' },
                { entryId: '555', title: 'Cedar change', designation: '#555', scopeLabel: 'happier-dev/happier' },
            ])));
        expect(result.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ title: 'Cedar issue', icon: 'issue', subtitle: 'happier-dev/happier · #554' }),
            expect.objectContaining({ title: 'Cedar change', icon: 'change-open', subtitle: 'happier-dev/happier · #555' }),
        ]));
    });
    it.each(['root_not_found', 'ROOT_NOT_FOUND', 'unavailable', 'auth_required'])(
        'preserves a typed %s acquisition failure through the shared window and search result', async (code) => {
            const base = createContext([]);
            const context = { ...base, ui: { ...base.ui,
                executeAction: async () => { throw new PluginError({ code }); },
            } };
            const result = await createTriageSearchEntriesActionHandler()({ query: 'needle', limit: 8 }, context);
            expect(result).toEqual({ items: [], truncated: false,
                failure: { code: code === 'ROOT_NOT_FOUND' ? 'root_not_found' : code } });
            expect(PluginSearchResultV1Schema.safeParse(result).success).toBe(true);
        },
    );

    it('reuses the shared mounted window without rescanning or changing the shell lens', async () => {
        const daemonContext = createDaemonContext([
            { entryId: '17', title: 'Fix the transcript crash' },
            { entryId: '18', title: 'Document the release flow' },
        ]);
        const listEntries = createTriageListEntriesActionHandler();
        const executeAction = vi.fn(async (action: string, input: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
            expect(action).toBe('entries/list-v1');
            return await listEntries(input as never, {
                ...daemonContext,
                signal: options?.signal ?? daemonContext.signal,
            });
        });
        const ui = Object.freeze({
            executeAction,
            openSurface: vi.fn(async () => {}),
            context: createContext([]).ui.context,
        }) as PluginClientActionContext['ui'];
        const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
        const shellLease = acquireTriageListWindow(ui, ephemeralSharedScope);
        try {
            await refreshTriageListWindow('view', ui, ephemeralSharedScope);
            setTriageListWindowLens({
                ...TRIAGE_LIST_DEFAULT_LENS_V1,
                query: 'release',
            }, ui, ephemeralSharedScope);
            const shellSnapshot = readTriageListWindowSnapshot(ui, ephemeralSharedScope);
            expect(shellSnapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['18']);
            const callsBeforeSearch = executeAction.mock.calls.length;

            const result = await createTriageSearchEntriesActionHandler()({
                query: 'crash',
                limit: 8,
            }, {
                plugin: { id: 'happier.triage', version: '1.0.0' },
                contribution: {
                    id: 'entries/search-v1',
                    qualifiedId: 'happier.triage/actions/entries/search-v1',
                },
                invocationSurface: 'ui',
                signal: new AbortController().signal,
                ui,
                ephemeralSharedScope,
            } satisfies PluginClientActionContext);

            expect(result.items.map((item) => item.title)).toEqual(['Fix the transcript crash']);
            expect(executeAction).toHaveBeenCalledTimes(callsBeforeSearch);
            expect(readTriageListWindowSnapshot(ui, ephemeralSharedScope)).toBe(shellSnapshot);
        } finally {
            shellLease.release();
        }
    });

    it('activates its declared client search handler before any plugin page opens', async () => {
        const context = createContext([
            { entryId: '17', title: 'Fix the transcript crash' },
            { entryId: '18', title: 'Document the release flow' },
        ]);

        const action = PLUGIN_MANIFEST.contributes.actions.find(entry => entry.id === 'entries/search-v1');
        if (action?.execution.target !== 'client') throw new Error('Missing declared client search Action');
        const target = { ...action.execution.client, platform: 'web' as const };
        const scope = createPluginRegistrationScope({
            pluginId: PLUGIN_MANIFEST.id,
            target: { realm: 'client', ...target },
            rights: derivePluginClientContributionRegistrationRights(PLUGIN_MANIFEST.contributes, target),
        });
        const exported: unknown = Reflect.get(searchActionArtifact, target.exportName);
        if (typeof exported !== 'function') throw new Error('Missing declared client activation export');
        await Reflect.apply(exported, undefined, [scope.api]);
        const registration = scope.commit().find(entry => entry.family === 'actions' && entry.localId === action.id);
        if (registration?.family !== 'actions') throw new Error('Client search handler was not registered');
        // The exact client target and Action right above prove this opaque SDK capture's realm.
        const handler = registration.value as unknown as ReturnType<typeof createTriageSearchEntriesActionHandler>;
        const result = PluginSearchResultV1Schema.parse(await handler({
            query: 'crash',
            limit: 8,
        }, context));

        // The universal boundary parses this exact value, so the handler's own
        // answer has to satisfy it here.
        expect(PluginSearchResultV1Schema.safeParse(result).success).toBe(true);
        // One matcher: the entry whose title the reader typed part of, and only
        // that one — no second narrowing rule in the search path.
        expect(result.items.map((item) => item.title)).toEqual(['Fix the transcript crash']);
        expect(result.truncated).toBe(false);
    });

    it('activates through the incumbent open owner, carrying its exact launch input', async () => {
        const context = createContext([{ entryId: '17', title: 'Fix the transcript crash' }]);

        const result = await createTriageSearchEntriesActionHandler()({
            query: 'crash',
            limit: 8,
        }, context);

        const command = result.items[0]!.command;
        expect(command.kind).toBe('openSurface');
        if (command.kind !== 'openSurface') throw new Error('unreachable');
        // The one Triage destination, spelled as a same-plugin local id that the
        // host qualifies. No route, URL or callback crosses the wire.
        expect(command.destination).toBe(TRIAGE_APP_PAGE_LOCAL_ID_V1);
        // Admitted by the SAME parser `openTriageEntryDetails` uses.
        const parsed = parseTriageEntryDetailLaunchInput(command.input);
        expect(parsed.status).toBe('valid');
        if (parsed.status !== 'valid') throw new Error('unreachable');
        expect(parsed.input.entryRef.entryId).toBe('17');
        expect(parsed.input.sourceInstance.sourceInstanceId).toBe(INSTANCE_ID);
    });

    it('reports a bounded answer as bounded rather than complete', async () => {
        const context = createContext([
            { entryId: '17', title: 'Crash one' },
            { entryId: '18', title: 'Crash two' },
            { entryId: '19', title: 'Crash three' },
        ]);

        const result = await createTriageSearchEntriesActionHandler()({
            query: 'crash',
            limit: 1,
        }, context);

        expect(result.items).toHaveLength(1);
        expect(result.truncated).toBe(true);
    });

    it('derives fixed digest ids while preserving full search display text', async () => {
        const context = createContext([
            {
                entryId: 'e'.repeat(128),
                collisionScope: 's'.repeat(192),
                title: 'needle identity',
            },
            {
                entryId: 'display-entry',
                title: `needle ${'😀'.repeat(100)}${'a'.repeat(100)}`,
                scopeLabel: `scope ${'z'.repeat(300)}`,
            },
        ]);

        const result = await createTriageSearchEntriesActionHandler()({
            query: 'needle',
            limit: 8,
        }, context);

        expect(result.items).toHaveLength(2);
        expect(result.items.map((item) => item.id)).toEqual([
            expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        ]);
        expect(new Set(result.items.map((item) => item.id))).toHaveProperty('size', 2);
        expect(result.items).toContainEqual(expect.objectContaining({
            title: `needle ${'😀'.repeat(100)}${'a'.repeat(100)}`,
            subtitle: `scope ${'z'.repeat(300)}`,
        }));
        expect(PluginSearchResultV1Schema.safeParse(result).success).toBe(true);
        expect(result.truncated).toBe(false);
    });

    it('does not call a complete window truncated merely because an unopenable row is omitted', async () => {
        const context = createContext([{
            entryId: 'unopenable-entry',
            title: 'unused',
            present: false,
        }]);

        const result = await createTriageSearchEntriesActionHandler()({
            query: 'unopenable-entry',
            limit: 8,
        }, context);

        expect(result.items).toEqual([]);
        expect(result.truncated).toBe(false);
    });

    it('returns no rows for a query nothing matches', async () => {
        const context = createContext([{ entryId: '17', title: 'Fix the transcript crash' }]);

        const result = await createTriageSearchEntriesActionHandler()({
            query: 'nothing-matches-this',
            limit: 8,
        }, context);

        expect(result.items).toEqual([]);
    });

    it('releases its lease promptly when aborted during a cold shared refresh', async () => {
        let settleRead: ((value: unknown) => void) | undefined;
        const ui = Object.freeze({
            executeAction: vi.fn(() => new Promise<unknown>((resolve) => { settleRead = resolve; })),
            openSurface: vi.fn(async () => {}),
        }) as PluginClientActionContext['ui'];
        const baseScope = createTriageEphemeralSharedScopeFixture();
        let leases = 0;
        const ephemeralSharedScope = Object.freeze({
            acquire<T>(key: string, create: Parameters<typeof baseScope.acquire<T>>[1]) {
                const lease = baseScope.acquire(key, create);
                if (lease === null) return null;
                leases += 1;
                let released = false;
                return Object.freeze({
                    value: lease.value,
                    release() {
                        if (released) return;
                        released = true;
                        leases -= 1;
                        lease.release();
                    },
                });
            },
        });
        const shellLease = acquireTriageListWindow(ui, ephemeralSharedScope);
        expect(leases).toBe(1);
        const cancellation = new AbortController();
        const pending = createTriageSearchEntriesActionHandler()({ query: 'crash', limit: 8 }, {
            plugin: { id: 'happier.triage', version: '1.0.0' },
            contribution: {
                id: 'entries/search-v1',
                qualifiedId: 'happier.triage/actions/entries/search-v1',
            },
            invocationSurface: 'ui',
            signal: cancellation.signal,
            ui,
            ephemeralSharedScope,
        });
        await vi.waitFor(() => expect(settleRead).toBeDefined(), { timeout: 5_000 });
        cancellation.abort();

        await expect(Promise.race([
            pending.then(() => 'resolved', () => 'rejected'),
            new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 50)),
        ])).resolves.toBe('rejected');
        // Search released only its lease. The shell still owns the shared pass,
        // so its transport remains unsettled and the shared value stays alive.
        expect(leases).toBe(1);
        shellLease.release();
        expect(leases).toBe(0);
        settleRead?.({});
    });
});
