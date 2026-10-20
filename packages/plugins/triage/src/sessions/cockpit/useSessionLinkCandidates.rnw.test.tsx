// @vitest-environment jsdom
import { act, cloneElement, type ReactElement } from 'react';
import * as React from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiCollectionQuerySnapshot, PluginUiDataClient } from '@happier-dev/plugin-ui/data';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CORPUS_SESSION_LINKS_FIELD } from '../../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef, testkitObservation, TESTKIT_SOURCE_INSTANCE_ID } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { toTriageListWireRows } from '../../projection/listWindowWire.js';
import { acquireTriageListWindow, refreshTriageListWindow, setTriageListWindowLens } from '../../ui/window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from '../../ui/window/ephemeralSharedScope.test-support.js';
import { createTestkitAccountKv } from '../../settings/testkit/accountKv.test-support.js';
import { useTriageSessionLinkCandidates } from './useSessionLinkCandidates.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY = testkitEntryRef();
const SESSION = 'session-link-picker';
const mounted: PluginUiTestkit[] = [];
const releases: Array<() => void> = [];

const probe = defineUiSurface(() => {
    const result = useTriageSessionLinkCandidates(SESSION, 'NORMALIZER repository');
    return <Text value={`${result.status}:${result.candidates.map(({ entry, alreadyLinked }) => `${entry.title}:${alreadyLinked}`).join(',')}`} />;
});

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
    for (const release of releases.splice(0)) release();
});

describe('the mounted Session link candidate reader', () => {
    it.each([false, true])('distinguishes a first acquisition failure from an admitted empty window (failure=%s)', async (failed) => {
        const scope = createTriageEphemeralSharedScopeFixture();
        const corpus = createTestkitCorpusCollections();
        const empty: PluginUiCollectionQuerySnapshot = { status: 'ready', rows: [], hasMore: false };
        const client: PluginUiDataClient = {
            collection: () => corpus.collections.sessionLinks as ReturnType<PluginUiDataClient['collection']>,
            accountKv: createTestkitAccountKv().kv,
            openCollectionQuery: async () => ({
                getSnapshot: () => empty,
                subscribe: () => () => {}, refresh: async () => {}, loadMore: async () => {}, dispose: () => {},
            }),
        };
        const base = createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope });
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({
                identity: { instanceId: 'first-demand', mountNonce: 'first-demand-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: probe,
                surfaceContext: createSurfaceContextFixture(),
                adapter: { mount: async (input) => base.mount({ ...input,
                    surface: (context) => cloneElement(input.surface(context) as ReactElement<{ dataClient?: PluginUiDataClient }>, { dataClient: client }),
                }) },
                handlers: { executeAction: async () => {
                    if (failed) throw Object.assign(new Error('Aggregate unavailable'), { code: 'unavailable' });
                    return { v: 1, configuredSources: [], configuredSourcesStatus: 'complete',
                        window: { v: 1, rows: [], lanes: [], coverage: 'complete', assembledAtMs: Date.now() } };
                } },
            });
        });
        mounted.push(fixture);
        await vi.waitFor(() => fixture.getByText(failed ? 'unavailable:' : 'ready:'));
    });

    it('searches the retained acquisition outside the page lens and finishes Session paging before saying not linked', async () => {
        const scope = createTriageEphemeralSharedScopeFixture();
        const lane = { sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, source: ENTRY.source,
            health: { kind: 'walkFinished' as const }, exhausted: true };
        const folded = foldTriageListWindow({ observations: [{ ...testkitObservation(), entryRef: ENTRY }], lanes: [lane],
            activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: Date.now() });
        const seedHost = { executeAction: async () => ({ v: 1,
            configuredSources: [{ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, source: ENTRY.source, available: true }],
            configuredSourcesStatus: 'complete',
            window: { v: 1, rows: toTriageListWireRows(folded), lanes: [lane], coverage: 'complete', assembledAtMs: Date.now() },
        }) };
        const lease = acquireTriageListWindow(seedHost, scope);
        releases.push(() => lease.release());
        await refreshTriageListWindow('manual', seedHost, scope);
        setTriageListWindowLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'hides-every-row' }, seedHost, scope);

        const corpus = createTestkitCorpusCollections();
        const row = (entryId: string, index: number) => {
            const linkTag = String(index).repeat(43);
            const entryTag = String(index + 2).repeat(43);
            const seeded = corpus.control.sessionLinks.seed(toCorpusStoredValue({
                linkTag, entryTag, sessionId: SESSION, linkedAtMs: index,
                entryRef: { ...ENTRY, entryId }, identityEntryRef: { ...ENTRY, entryId },
                displayPathAtLink: `example/repository #${entryId}`,
            }));
            return { context: { collection: { pluginId: 'happier.triage', collectionId: 'session-links' }, ...seeded },
                fields: { [CORPUS_SESSION_LINKS_FIELD.sessionId]: SESSION,
                    [CORPUS_SESSION_LINKS_FIELD.entryTag]: entryTag, [CORPUS_SESSION_LINKS_FIELD.linkedAtMs]: index } };
        };
        const first = row('18', 1);
        const second = row(ENTRY.entryId, 2);
        let snapshot: PluginUiCollectionQuerySnapshot = { status: 'ready', rows: [first], hasMore: true };
        const listeners = new Set<() => void>();
        const publish = (next: PluginUiCollectionQuerySnapshot) => {
            snapshot = next;
            for (const listener of listeners) listener();
        };
        let finishPage!: () => void;
        const page = new Promise<void>((resolve) => { finishPage = resolve; });
        let pending: Promise<void> | undefined;
        const client: PluginUiDataClient = {
            // This is the Account Collection transport boundary; its codec and hydration stay real.
            collection: () => corpus.collections.sessionLinks as ReturnType<PluginUiDataClient['collection']>,
            accountKv: createTestkitAccountKv().kv,
            openCollectionQuery: async () => ({ getSnapshot: () => snapshot,
                subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
                refresh: async () => {},
                loadMore: () => pending ??= page.then(() => { publish({ status: 'ready', rows: [first, second], hasMore: false }); }),
                dispose: () => { listeners.clear(); },
            }),
        };
        const base = createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope });
        let sourceReads = 0;
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({
                identity: { instanceId: 'session-link-probe', mountNonce: 'session-link-probe-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: probe,
                surfaceContext: createSurfaceContextFixture({ targetedContributions: {
                    ...createSurfaceContextFixture().targetedContributions!,
                    points: [{ pointId: 'sources', protocols: [{ protocol: { id: 'happier.triage/sources', version: 1 },
                        contributions: [{
                            contributor: { pluginId: ENTRY.source.pluginId, contributionId: ENTRY.source.localId,
                                occurrenceId: 'picker-source-1', sourceCustody: { kind: 'development', registeredRootId: 'picker-root' } },
                            protocol: { id: 'happier.triage/sources', version: 1 },
                            descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge',
                                kinds: [{ id: ENTRY.kindId, workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
                            operations: [], surfaces: [],
                        }],
                    }] }],
                } }),
                adapter: { mount: async (input) => base.mount({ ...input,
                    surface: (context) => cloneElement(input.surface(context) as ReactElement<{ dataClient?: PluginUiDataClient }>, { dataClient: client }),
                }) },
                handlers: { executeAction: async () => { sourceReads += 1; throw new Error('Picker mount must not refresh sources'); } },
            });
        });
        mounted.push(fixture);
        await expect(fixture.getByText('loading:')).resolves.toEqual({ content: 'loading:' });
        await act(async () => { finishPage(); await page; });
        await expect(fixture.getByText('ready:Replace the duplicated normalizer:true')).resolves
            .toEqual({ content: 'ready:Replace the duplicated normalizer:true' });
        expect(sourceReads).toBe(0);
    });
});
