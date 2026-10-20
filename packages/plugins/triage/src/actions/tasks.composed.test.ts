import { definePlugin, type JsonValue, type PluginServices } from '@happier-dev/plugin-sdk';
import type { StorageService } from '@happier-dev/plugin-sdk/storage';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import {
    TriageGetResultV1Schema,
    TriageSourceDescriptorV1Schema,
    TriageSourcesContributionProtocolV1,
    TriageTaskWriteResultV1Schema,
    type TriageTaskWriteResultV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';
import { activate } from '../activate.js';
import { PLUGIN_MANIFEST, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SESSION_LINKS_INDEX_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { TriageListEntriesResultV1Schema } from './listEntriesProtocol.js';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 } from './sessionLinksProtocol.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from '../projection/listWindow.js';

const fixture = createTriageSourceV1Fixture();
const configured = fixture.configuredInstance;
const source = configured.instance.source;
const instanceId = configured.instance.sourceInstanceId;
const secondInstanceId = 'ba9752ad-48f8-4a4c-9054-a9ff99a1fc12';
const protocol = TriageSourcesContributionProtocolV1;
const base = TriageGetResultV1Schema.parse(fixture.getResult);
if (base.kind !== 'present') throw new Error('The public fixture must provide a present entry');
const initialTask = { ...base, localRef: { ...base.localRef, kindId: 'issue', entryId: 'task-1' },
    snapshot: { ...base.snapshot, dueDate: '2026-10-25' } };
const entryRef = { source, ...initialTask.localRef };

/** A separately authored source: no aggregate imports or bundled source implementation. */
async function withExternalTaskSource(
    run: (fixture: Readonly<{
        aggregate: PluginTestkit;
        contributor: PluginTestkit;
        corpus: ReturnType<typeof createTestkitCorpusCollections>;
        writes: readonly Readonly<{ role: string; input: JsonValue }>[];
        readRequests: readonly string[];
        setWriteResult: (result: TriageTaskWriteResultV1 | null) => void;
    }>) => Promise<void>,
    options: Readonly<{ readOnly?: boolean; retired?: boolean; secondInstance?: boolean; initialTaskPage?: boolean; firstInstanceKeepsPaging?: boolean; scopeSelection?: boolean; completedScan?: boolean; completedScanSupport?: boolean; unboundedCompleted?: boolean }> = {},
) {
    const descriptor = TriageSourceDescriptorV1Schema.parse({
        ...fixture.descriptor,
        ...(options.scopeSelection ? { scopeUnit: { singularLabel: 'Team', pluralLabel: 'teams' } } : {}),
        kinds: [fixture.descriptor.kinds[0], {
            id: 'issue', workflowSubject: 'issue', displayName: 'Issue', task: true,
            taskCapabilities: {
                ...(options.completedScanSupport === false ? {} : { completedScan: true }),
                createFields: ['title'], editFields: ['title'],
                completingTransitionId: 'finish',
                transitions: [{ id: 'begin', label: 'Begin', state: { presentation: 'active', nativeLabel: 'Started', stage: 'started' } },
                    { id: 'finish', label: 'Finish', state: { presentation: 'resolved', completionReason: 'completed' } }],
            },
        }],
    });
    let task = initialTask;
    const writes: { role: string; input: JsonValue }[] = [];
    const readRequests: string[] = [];
    let writeResult: TriageTaskWriteResultV1 | null = null;
    const definition = definePlugin({
        id: source.pluginId, version: '0.0.0',
        actions: {
            discover: { title: 'Discover', surfaces: protocol.operations.listInstances.declaration.surfaces,
                dangerLevel: protocol.operations.listInstances.declaration.dangerLevel,
                inputSchema: protocol.operations.listInstances.declaration.input.schema,
                resultSchema: protocol.operations.listInstances.declaration.resultSchema,
                run: async () => fixture.listInstancesResult },
            scan: { title: 'Scan', surfaces: protocol.operations.scan.declaration.surfaces,
                dangerLevel: protocol.operations.scan.declaration.dangerLevel,
                inputSchema: protocol.operations.scan.declaration.input.schema,
                resultSchema: protocol.operations.scan.declaration.resultSchema,
                run: async (input) => {
                    if (options.completedScan || options.unboundedCompleted) {
                        const selected = options.unboundedCompleted || input.completed?.kindIds.length === 1
                            && input.completed.kindIds[0] === 'issue' && input.completed.sinceMs <= 100;
                        return { kind: 'complete', observations: selected ? [{ ...task, snapshot: { ...task.snapshot,
                            state: { presentation: 'resolved', completionReason: 'completed' }, completedAtMs: 100 } }] : [],
                            evidence: { kind: 'walkFinished' } };
                    }
                    const selectedTask = input.instance.instance.sourceInstanceId === instanceId ? task
                        : { ...task, localRef: { ...task.localRef, entryId: 'task-2' } };
                    const observedTask = options.scopeSelection ? { ...selectedTask, snapshot: {
                        ...selectedTask.snapshot,
                        scopeUnitId: input.instance.instance.sourceInstanceId === instanceId ? 'team-a' : 'team-b',
                    } } : selectedTask;
                    if (options.firstInstanceKeepsPaging && input.instance.instance.sourceInstanceId === instanceId) {
                        return { kind: 'page', observations: [observedTask], evidence: { kind: 'partial', reason: 'pageLimit' },
                            continuation: { v: 1, token: input.page.kind === 'initial' ? 'after-task' : `${input.page.continuation.token}/next` } };
                    }
                    return input.page.kind === 'initial' && !options.initialTaskPage ? {
                        kind: 'page', observations: [base], evidence: { kind: 'partial', reason: 'pageLimit' },
                        continuation: { v: 1, token: 'after-pr' },
                    } : { kind: 'complete', observations: [observedTask], evidence: { kind: 'walkFinished' } };
                } },
            get: { title: 'Get', surfaces: protocol.operations.get.declaration.surfaces,
                dangerLevel: protocol.operations.get.declaration.dangerLevel,
                inputSchema: protocol.operations.get.declaration.input.schema,
                resultSchema: protocol.operations.get.declaration.resultSchema,
                run: async () => { readRequests.push('get'); return task; } },
            ...(options.scopeSelection ? {
                scopes: { title: 'List teams', surfaces: protocol.operations.listScopeUnits.declaration.surfaces,
                    dangerLevel: protocol.operations.listScopeUnits.declaration.dangerLevel,
                    inputSchema: protocol.operations.listScopeUnits.declaration.input.schema,
                    resultSchema: protocol.operations.listScopeUnits.declaration.resultSchema,
                    run: async (input) => {
                        readRequests.push(`scope:${input.mode}`);
                        if (input.mode !== 'configured') throw new Error('The aggregate must never discover provider units');
                        return { kind: 'page' as const, status: 'complete' as const,
                            selection: { kind: 'selected' as const, unitIds: ['team-a', 'team-b'] },
                            units: [{ id: 'team-a', label: 'Platform' }, { id: 'team-b', label: 'Mobile' }] };
                    } },
            } : {}),
            ...(!options.readOnly ? {
                create: { title: 'Create', surfaces: protocol.operations.create.declaration.surfaces,
                    dangerLevel: protocol.operations.create.declaration.dangerLevel,
                    inputSchema: protocol.operations.create.declaration.input.schema,
                    resultSchema: protocol.operations.create.declaration.resultSchema,
                    confirmation: { title: 'Create issue?', body: 'Creates one provider issue.' },
                    run: async (input) => {
                        writes.push({ role: 'create', input });
                        if (writeResult) return writeResult;
                        task = { ...task, snapshot: { ...task.snapshot, title: input.fields.title } };
                        return { kind: 'applied', observation: task };
                    } },
                edit: { title: 'Edit', surfaces: protocol.operations.edit.declaration.surfaces,
                    dangerLevel: protocol.operations.edit.declaration.dangerLevel,
                    inputSchema: protocol.operations.edit.declaration.input.schema,
                    resultSchema: protocol.operations.edit.declaration.resultSchema,
                    confirmation: { title: 'Edit issue?', body: 'Edits the selected provider issue.' },
                    run: async (input) => {
                        writes.push({ role: 'edit', input });
                        if (writeResult) return writeResult;
                        task = { ...task, snapshot: { ...task.snapshot, title: input.fields.title ?? task.snapshot.title } };
                        return { kind: 'applied', observation: task };
                    } },
                transition: { title: 'Transition', surfaces: protocol.operations.transition.declaration.surfaces,
                    dangerLevel: protocol.operations.transition.declaration.dangerLevel,
                    inputSchema: protocol.operations.transition.declaration.input.schema,
                    resultSchema: protocol.operations.transition.declaration.resultSchema,
                    confirmation: { title: 'Change issue status?', body: 'Changes the native provider status.' },
                    run: async (input) => {
                        writes.push({ role: 'transition', input });
                        if (writeResult) return writeResult;
                        task = { ...task, snapshot: { ...task.snapshot,
                            ...(input.transitionId === 'finish' ? { completedAtMs: 100 } : {}),
                            state: input.transitionId === 'finish' ? { presentation: 'resolved', completionReason: 'completed' }
                                : { presentation: 'active', nativeLabel: input.transitionId, stage: 'started' } } };
                        return { kind: 'applied', observation: task };
                    } },
            } : {}),
        },
        ui: { renderers: [{ id: 'detail', kind: 'declarative', root: { kind: 'text', text: 'External task' } }] },
        contributesTo: { 'happier.triage': { sources: { [source.localId]: protocol.contribute({
            descriptor,
            operations: {
                listInstances: protocol.operations.listInstances.bind('discover'),
                scan: protocol.operations.scan.bind('scan'),
                get: protocol.operations.get.bind('get'),
                ...(options.scopeSelection ? { listScopeUnits: protocol.operations.listScopeUnits.bind('scopes') } : {}),
                ...(!options.readOnly ? {
                    create: protocol.operations.create.bind('create'),
                    edit: protocol.operations.edit.bind('edit'),
                    transition: protocol.operations.transition.bind('transition'),
                } : {}),
            },
            surfaces: { detail: { renderer: 'detail' } },
        }) } } },
    });
    const contributor = await createPluginTestkit({ manifest: definition.manifest, module: definition });
    const corpus = createTestkitCorpusCollections();
    corpus.control.sourceInstances.seed(toCorpusStoredValue({
        instanceTag: 'a'.repeat(43), sourceQualifiedId: `${source.pluginId}/${source.localId}`,
        lifecycle: options.retired ? CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired : CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1, configured,
        ...(options.retired ? { retiredReason: 'userRemoved' as const } : {}),
    }));
    if (options.secondInstance) {
        corpus.control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: 'b'.repeat(43), sourceQualifiedId: `${source.pluginId}/${source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 2,
            configured: {
                ...configured, instance: { ...configured.instance, sourceInstanceId: secondInstanceId },
                localInstanceKey: `${configured.localInstanceKey}/second`,
                configuration: { v: 1, token: 'second-configuration-token' },
            },
        }));
    }
    const storage = { account: { collection: (definition: { id: string }) => {
        if (definition.id === 'source-instances') return corpus.collections.sourceInstances;
        if (definition.id === 'session-links') return corpus.collections.sessionLinks;
        if (definition.id === 'user-marks') return corpus.collections.userMarks;
        throw new Error(`Unexpected Collection ${definition.id}`);
    } } } as unknown as StorageService;
    let aggregate!: PluginTestkit;
    // The host service is a genuine boundary. The SDK issues and dispatches its
    // original opaque handles from the real source declaration + registration;
    // this adapter adds only descriptor semantics, which the testkit omits.
    const targetedContributions = { observeForSelf: () => ({
        readCurrent: async () => {
            const snapshot = aggregate.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
            return { ...snapshot, contributions: snapshot.contributions.map((entry) => {
                const contributorManifest = [definition.manifest, PLUGIN_MANIFEST].find(
                    (manifest) => manifest.id === entry.contributor.pluginId,
                );
                const declaration = contributorManifest?.contributes?.targetedPluginContributions?.find(
                    (candidate) => candidate.id === entry.contributor.contributionId,
                );
                return { ...entry, descriptor: TriageSourceDescriptorV1Schema.parse(declaration?.descriptor), surfaces: {} };
            }) };
        }, dispose: () => {},
    }) } as unknown as PluginServices['targetedContributions'];
    try {
        aggregate = await createPluginTestkit({
            manifest: PLUGIN_MANIFEST, module: { activate }, targetedContributionContributors: [contributor],
            services: { storage },
        });
        // Structural fixtures issue the actual opaque operation handles. Their
        // descriptor semantics are supplied at the invocation boundary, where
        // the public testkit supports an individual host-service fixture.
        const aggregateWithSourceSemantics: PluginTestkit = {
            ...aggregate,
            invokeAction: async (localId, input, invocation = {}) => await aggregate.invokeAction(localId, input, {
                ...invocation,
                services: { ...invocation.services, targetedContributions },
            }),
        };
        await run({ aggregate: aggregateWithSourceSemantics, contributor, corpus, writes, readRequests, setWriteResult: (result) => { writeResult = result; } });
    } finally {
        await aggregate?.dispose();
        await contributor.dispose();
    }
}

describe('Tasks through a separately authored source and registered aggregate Actions', () => {
    it('sends the agent task lens completion boundary only to declared task kinds through admitted scan wiring', async () => {
        await withExternalTaskSource(async ({ aggregate }) => {
            const input = { v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest', tasks: { completedSinceMs: 100 } };
            const taskRead = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', input, { surface: 'agent' }));
            expect(taskRead.window.rows).toMatchObject([{ observation: { outcome: { kind: 'present', snapshot: { completedAtMs: 100 } } } }]);
            const ordinary = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('entries/list-v1', input, { surface: 'agent' }));
            expect(ordinary.window.rows).toEqual([]);
        }, { completedScan: true });
    });
    it('keeps completion coverage partial when an external task source has not declared the read capability', async () => {
        await withExternalTaskSource(async ({ aggregate }) => {
            const read = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest', tasks: { completedSinceMs: 100 },
            }, { surface: 'agent' }));
            expect(read.window.coverage).toBe('partial');
            expect(read.window.lanes).toMatchObject([{ exhausted: false,
                health: { kind: 'partial', reason: 'completedScanUnavailable' } }]);
            const older = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest', tasks: { completedSinceMs: 101 },
            }, { surface: 'agent' }));
            expect(older.window.rows).toEqual([]);
        }, { unboundedCompleted: true, completedScanSupport: false });
    });
    it('completes once through the declared role and rereads due/completion facts through the same strict list consumer', async () => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const result = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/transition-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'finish',
            }, { surface: 'agent' }));
            expect(result).toMatchObject({ kind: 'applied', observation: { snapshot: {
                state: { presentation: 'resolved', completionReason: 'completed' }, dueDate: '2026-10-25', completedAtMs: 100,
            } } });
            const read = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest',
            }, { surface: 'agent' }));
            expect(read.window.rows[0]?.observation.outcome).toMatchObject({ kind: 'present',
                snapshot: { dueDate: '2026-10-25', completedAtMs: 100 } });
            expect(writes.map(write => write.role)).toEqual(['transition']);
        }, { initialTaskPage: true });
    });
    it('projects configured scope choices before scanning and applies the same unit filter through agent admission', async () => {
        await withExternalTaskSource(async ({ aggregate, readRequests }) => {
            const input = { v: 1, sources: { kind: 'allConfigured' }, limit: 0, order: 'newest' };
            const cold = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', input, { surface: 'agent' }));
            expect(cold.window.rows).toEqual([]);
            expect(cold.configuredSources[0]?.scope).toMatchObject({
                unit: { singularLabel: 'Team', pluralLabel: 'teams' },
                projection: { selection: { kind: 'selected', unitIds: ['team-a', 'team-b'] },
                    units: [{ id: 'team-a', label: 'Platform' }, { id: 'team-b', label: 'Mobile' }] },
            });
            expect(readRequests).toEqual(['scope:configured', 'scope:configured']);
            const filtered = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                ...input, limit: 10, filters: { ...TRIAGE_LIST_NO_FILTERS_V1,
                    scopes: [{ source, sourceInstanceId: instanceId, unitId: 'team-a' }] },
            }, { surface: 'agent' }));
            expect(filtered.window.rows.map((row) => row.entryRef.entryId)).toEqual(['task-1']);
            expect(filtered.window.lanes).toHaveLength(2);
        }, { scopeSelection: true, secondInstance: true, initialTaskPage: true });
    });

    it('applies an agent instance filter after scanning both separately admitted source instances', async () => {
        await withExternalTaskSource(async ({ aggregate }) => {
            const result = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest',
                filters: { ...TRIAGE_LIST_NO_FILTERS_V1, sources: [{ source, sourceInstanceId: secondInstanceId }] },
            }, { surface: 'agent' }));
            expect(result.window.rows.map((row) => row.entryRef.entryId)).toEqual(['task-2']);
            expect(result.window.lanes.map((lane) => [lane.sourceInstanceId, lane.health.kind]))
                .toEqual([[instanceId, 'walkFinished'], [secondInstanceId, 'walkFinished']]);
            expect(result.configuredSources.map((summary) => summary.sourceInstanceId)).toEqual([instanceId, secondInstanceId]);
        }, { secondInstance: true, initialTaskPage: true });
    });

    it('lists tasks after an entire non-task page through the shared scan and strict result consumer', async () => {
        await withExternalTaskSource(async ({ aggregate }) => {
            const result = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                v: 1, sources: { kind: 'allConfigured' }, limit: 1, order: 'newest',
            }, { surface: 'agent' }));
            expect(result.window.rows.map((row) => row.entryRef)).toEqual([entryRef]);
            expect(result.window.coverage).toBe('complete');
        });
    });

    it.each([false, true])('reaches both source lanes at limit one when the first keeps paging: %s', async (firstInstanceKeepsPaging) => {
        await withExternalTaskSource(async ({ aggregate }) => {
            const input = { v: 1, sources: { kind: 'allConfigured' }, limit: 1, order: 'newest' };
            const first = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', input, { surface: 'agent' }));
            const second = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                ...input, resume: first.window.continuations ?? [],
            }, { surface: 'agent' }));
            expect(new Set([...first.window.rows, ...second.window.rows].map((row) => row.entryRef.entryId)))
                .toEqual(new Set(['task-1', 'task-2']));
        }, { secondInstance: true, initialTaskPage: true, firstInstanceKeepsPaging });
    });

    it.each(['agent', 'mcp', 'cli'] as const)('creates, edits and uses a native transition through real source role handles from %s', async (surface) => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const created = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Created task' },
            }, { surface }));
            expect(created).toMatchObject({ kind: 'applied', observation: { snapshot: { title: 'Created task' } } });
            const edited = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/edit-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, fields: { title: 'Edited task' },
            }, { surface }));
            expect(edited).toMatchObject({ kind: 'applied', observation: { snapshot: { title: 'Edited task' } } });
            // Entry-specific native workflows stay source-owned; a stale static
            // descriptor must not map or suppress the selected native id.
            const transitioned = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/transition-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'newly-available-native-transition',
            }, { surface }));
            expect(transitioned).toMatchObject({ kind: 'applied', observation: {
                snapshot: { state: { nativeLabel: 'newly-available-native-transition', stage: 'started' } },
            } });
            expect(writes.map((write) => write.role)).toEqual(['create', 'edit', 'transition']);
            expect(writes[0]?.input).toEqual({ v: 1, instance: configured, kindId: 'issue', fields: { title: 'Created task' } });
        });
    });

    it('preserves uncertain writes without issuing a second create or a confirming aggregate read', async () => {
        await withExternalTaskSource(async ({ aggregate, writes, readRequests, setWriteResult }) => {
            const uncertain = { kind: 'uncertain', failure: { class: 'transient', code: 'responseLost' } } as const;
            setWriteResult(uncertain);
            expect(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Maybe created' },
            }, { surface: 'agent' })).toEqual(uncertain);
            expect(writes).toHaveLength(1);
            expect(readRequests).toEqual([]);
        });
    });

    it.each(['create', 'edit', 'transition'] as const)('keeps a miscorrelated applied %s result uncertain without replaying the write', async (role) => {
        await withExternalTaskSource(async ({ aggregate, writes, setWriteResult }) => {
            const localRef = role === 'create'
                ? { ...initialTask.localRef, kindId: 'pull-request' }
                : { ...initialTask.localRef, entryId: 'another-task' };
            setWriteResult({ kind: 'applied', observation: { ...initialTask, localRef } });
            const input = role === 'create'
                ? { v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Create' } }
                : role === 'edit'
                    ? { v: 1, entryRef, sourceInstanceId: instanceId, fields: { title: 'Edit' } }
                    : { v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'begin' };
            const result = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction(`tasks/${role}-v1`, input, { surface: 'agent' }));
            expect(result).toEqual({ kind: 'uncertain', failure: { class: 'unsupportedContract', code: 'taskObservationMismatch' } });
            expect(writes).toHaveLength(1);
        });
    });

    it.each([{ retired: true }, { readOnly: true }])('does not write without current configuration and an admitted role: %j', async (options) => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const result = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Refused' },
            }, { surface: 'agent' }));
            expect(['refused', 'failed']).toContain(result.kind);
            expect(writes).toEqual([]);
        }, options);
    });

    it('rejects a forged configuration, foreign source, non-task kind and unsupported field before writing', async () => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const input = { v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'No write' } };
            await expect(aggregate.invokeAction('tasks/create-v1', { ...input, instance: configured }, { surface: 'agent' })).rejects.toThrow();
            for (const invalid of [
                { ...input, source: { ...source, pluginId: 'example.foreign.source' } },
                { ...input, kindId: 'pull-request' },
                { ...input, fields: { title: 'No write', priority: 1 } },
            ]) {
                const result = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/create-v1', invalid, { surface: 'agent' }));
                expect(['refused', 'failed']).toContain(result.kind);
            }
            expect(writes).toEqual([]);
        });
    });

    it('links through the existing relation writer, so repeating through either Action produces one row', async () => {
        await withExternalTaskSource(async ({ aggregate, corpus }) => {
            const input = { v: 1, entryRef, sessionId: 'task-session', display: {
                locator: initialTask.locator, scopeLabel: initialTask.snapshot.scopeLabel,
            } };
            expect(await aggregate.invokeAction('tasks/link-v1', input, { surface: 'agent' })).toEqual({ v: 1, status: 'linked' });
            expect(await aggregate.invokeAction(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, input, { surface: 'agent' })).toEqual({ v: 1, status: 'linked' });
            const rows = await corpus.collections.sessionLinks.query({
                index: CORPUS_SESSION_LINKS_INDEX_ID.bySession, prefix: ['task-session'], order: 'asc', limit: 10,
            });
            expect(rows.rows).toHaveLength(1);
            expect(rows.rows[0]?.revision).toBe(1);
        });
    });
});
