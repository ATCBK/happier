import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { TriageGetResultV1Schema, TriageScanResultV1Schema, TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { TriageSourceDescriptorV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { TriageListEntriesResultV1Schema } from '../actions/listEntriesProtocol.js';
import { executeInternalTaskAction, executeInternalTaskReorder, type AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { applyTodoSessionLinkV1, TodoSessionLinkInputV1Schema } from '@happier-dev/protocol/todos/todoSessionLinkV1';

const scope = { serverId: 'home', accountId: 'account' };
// Captured shape from ../0.2 todoOps.ts addTodo/updateTodoLinkedSessions at
// f16a3759a3944bc4be4bbb7e14a3e6a01397f7b5; the host normalizes only state.
const predecessor = { id: 'old-task', title: 'Keep my existing task', done: false,
  createdAt: 17, updatedAt: 18, linkedSessions: { 'session-old': { title: 'Existing work', linkedAt: 19 } } };
const source = { pluginId: 'happier.triage', localId: 'internal' };
const instance = { v: 1, instance: { source, sourceInstanceId: '6a741117-c35d-47ee-9060-efb56c6ea275' },
  binding: { purpose: 'tasks', source: 'accountData' }, localInstanceKey: 'personal',
  configuration: { v: 1, token: 'happier-tasks-v1' } };
const localRef = { kindId: 'task', collisionScope: 'personal', entryId: predecessor.id };

async function withSource(run: (kit: Awaited<ReturnType<typeof createPluginTestkit>>, calls: { id: string; input: unknown }[]) => Promise<void>,
  list: unknown = { status: 'ok', scope, todos: [{ ...predecessor, state: 'unstarted' }], undoneOrder: [predecessor.id], completedOrder: [] }) {
  const calls: { id: string; input: unknown }[] = [];
  // The plugin-to-host Action transport is a genuine process boundary. Host
  // Account-mode, CAS and predecessor preservation are exercised at its owner.
  const actions = { execute: async (id: string, input: unknown) => {
    calls.push({ id, input });
    if (id === 'tasks.internal.list') return list;
    if (id === 'tasks.internal.edit') return { status: 'uncertain', reason: 'lost_response' };
    if (id === 'tasks.internal.session.link') return { status: 'linked' };
    throw new Error(`Unexpected host Action ${id}`);
  } } as unknown as PluginServices['actions'];
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN, services: { actions } });
  try { await run(kit, calls); } finally { await kit.dispose(); }
}

describe('registered internal Happier task source', () => {
  it('reads active and recently completed personal tasks from the same Account list without inferring unknown completion dates', async () => {
    const todos = [
      { ...predecessor, id: 'active', state: 'unstarted' },
      { ...predecessor, id: 'recent', state: 'completed', done: true, completedAt: 100 },
      { ...predecessor, id: 'old', state: 'completed', done: true, completedAt: 99 },
      { ...predecessor, id: 'unknown', state: 'completed', done: true },
    ];
    await withSource(async kit => {
      const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, completed: { kindIds: ['task'], sinceMs: 100 }, page: { kind: 'initial', limit: 20 },
      }));
      expect(scan.kind === 'complete' && scan.observations.map(row => row.localRef.entryId)).toEqual(['active', 'recent']);
    }, { status: 'ok', scope, todos, undoneOrder: ['active'], completedOrder: ['recent', 'old', 'unknown'] });
  });
  it('projects personal due/completion facts and the declared one-step completion through registered scan admission', async () => {
    await withSource(async kit => {
      const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, page: { kind: 'initial', limit: 20 },
      }));
      expect(scan).toMatchObject({ kind: 'complete', observations: [{ snapshot: { dueDate: new Date(30).toISOString(), completedAtMs: 25 } }] });
      const declaration = PLUGIN_MANIFEST.contributes?.targetedPluginContributions?.find(entry => entry.id === 'internal');
      expect(declaration?.descriptor).toMatchObject({ kinds: [{ taskCapabilities: { completingTransitionId: 'completed' } }] });
    }, { status: 'ok', scope, todos: [{ ...predecessor, done: true, state: 'completed', dueAt: 30, completedAt: 25 }],
      undoneOrder: [], completedOrder: [predecessor.id] });
  });
  it('returns complete editable values only on an exact read of the existing task', async () => {
    const title = '界'.repeat(1000);
    const notes = 'Task notes\n\nPreserve whitespace.  \n';
    await withSource(async kit => {
      const exact = await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef });
      expect(exact).toMatchObject({ kind: 'present', snapshot: { projectionTruncated: true },
        taskFields: { title, body: notes, assigneeIds: [], labelIds: [], dueDate: null, parent: null, blockedBy: [] } });
      expect(TriageGetResultV1Schema.safeParse(exact).success).toBe(true);
      const scan = await kit.invokeAction('internal/tasks/scan-v1', { v: 1, instance, page: { kind: 'initial', limit: 20 } });
      expect(JSON.stringify(scan)).not.toContain(notes);
      expect(TriageScanResultV1Schema.safeParse(scan).success).toBe(true);
    }, { status: 'ok', scope, todos: [{ ...predecessor, title, notes, state: 'unstarted' }], undoneOrder: [predecessor.id], completedOrder: [] });
  });
  it('creates, edits, transitions and reopens the same raw Account record with one link writer', async () => {
    const rows = new Map<string, { value: unknown; version: number }>([
      ['todo.old-task', { value: predecessor, version: 1 }],
      ['todo.index', { value: { undoneOrder: ['old-task'], completedOrder: [] }, version: 1 }],
    ]);
    // Only persistence is substituted; the real host domain owns CAS inputs,
    // field updates, completion/index semantics and qualified linking.
    const port: AccountJsonKvCollectionPort = {
      read: async key => structuredClone(rows.get(key) ?? { value: null, version: -1 }),
      list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, row]) => ({ key, ...structuredClone(row) })),
      mutate: async mutations => {
        const errors = mutations.filter(mutation => mutation.version !== (rows.get(mutation.key)?.version ?? -1))
          .map(mutation => ({ key: mutation.key, ...structuredClone(rows.get(mutation.key) ?? { value: null, version: -1 }) }));
        if (errors.length) return { success: false, errors };
        const results = mutations.map(mutation => {
          const version = mutation.version + 1;
          rows.set(mutation.key, { value: structuredClone(mutation.value), version });
          return { key: mutation.key, version };
        });
        return { success: true, results };
      },
    };
    const actions = { execute: async (id: string, input: unknown) => {
      if (id === 'tasks.internal.reorder') return executeInternalTaskReorder({ input, scope, port, requireCurrent: () => {} });
      if (id === 'tasks.internal.list' || id === 'tasks.internal.create' || id === 'tasks.internal.edit' || id === 'tasks.internal.transition') {
        return executeInternalTaskAction({ actionId: id, input, scope, port, requireCurrent: () => {}, createId: () => 'new-task' });
      }
      if (id !== 'tasks.internal.session.link') throw new Error(`Unexpected host Action ${id}`);
      const intent = TodoSessionLinkInputV1Schema.parse(input);
      const key = `todo.${intent.taskId}`;
      await applyTodoSessionLinkV1(intent, { read: () => port.read(key), compareAndSet: async (value, version) => {
        const result = await port.mutate([{ key, value, version }]);
        return result.success ? { success: true, version: result.results[0]!.version }
          : { success: false, ...(await port.read(key)) };
      } }, { requireCurrent: () => {} });
      return { status: intent.linked === false ? 'unlinked' : 'linked' };
    } } as unknown as PluginServices['actions'];
    const corpus = createTestkitCorpusCollections();
    corpus.control.sourceInstances.seed(toCorpusStoredValue({
      instanceTag: 'a'.repeat(43), sourceQualifiedId: `${source.pluginId}/${source.localId}`,
      lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured: instance,
    }));
    // Account persistence and host Actions are genuine boundaries; admission,
    // opaque operation handles, aggregate dispatch and the todo CAS owner stay real.
    const storage = { account: { collection: (definition: { id: string }) => {
      if (definition.id === 'source-instances') return corpus.collections.sourceInstances;
      if (definition.id === 'session-links') return corpus.collections.sessionLinks;
      if (definition.id === 'user-marks') return corpus.collections.userMarks;
      throw new Error(`Unexpected Collection ${definition.id}`);
    } } } as unknown as PluginServices['storage'];
    const open = () => createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN,
      services: { actions, storage }, resolveCurrentPluginMaterializationRef: () => null });
    let kit = await open();
    const invocation = () => ({ surface: 'agent' as const, services: {
      targetedContributions: { observeForSelf: () => ({ readCurrent: async () => {
        const snapshot = kit.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
        return { ...snapshot, contributions: snapshot.contributions.map(entry => ({ ...entry,
          descriptor: TriageSourceDescriptorV1Schema.parse(PLUGIN_MANIFEST.contributes.targetedPluginContributions
            .find(candidate => candidate.id === entry.contributor.contributionId)?.descriptor), surfaces: {},
        })) };
      }, dispose: () => {} }) } as unknown as PluginServices['targetedContributions'],
    } });
    try {
      const created = TriageTaskWriteResultV1Schema.parse(await kit.invokeAction('tasks/create-v1', {
        v: 1, source, sourceInstanceId: instance.instance.sourceInstanceId, kindId: 'task',
        fields: { title: 'New work', body: 'Keep the whole\nmultiline note', parent: { source, ...localRef }, labelIds: ['personal'] },
      }, invocation()));
      expect(created).toMatchObject({ kind: 'applied', observation: { localRef: { entryId: 'new-task' } } });
      const address = { v: 1, instance, localRef: { ...localRef, entryId: 'new-task' } };
      const aggregateAddress = { v: 1, sourceInstanceId: instance.instance.sourceInstanceId, entryRef: { source, ...address.localRef } };
      expect(TriageTaskWriteResultV1Schema.parse(await kit.invokeAction('tasks/edit-v1', { ...aggregateAddress,
        fields: { title: 'Edited once', blockedBy: [{ source, ...localRef }] } }, invocation())).kind).toBe('applied');
      expect(await actions.execute('tasks.internal.reorder', { scope, sourceId: 'new-task',
        position: { anchorId: 'old-task', placement: 'before' } })).toEqual({ status: 'applied' });
      expect(rows.get('todo.index')?.value).toEqual({ undoneOrder: ['new-task', 'old-task'], completedOrder: [] });
      await kit.dispose();
      kit = await open();
      expect(await actions.execute('tasks.internal.list', {})).toMatchObject({ undoneOrder: ['new-task', 'old-task'] });
      const oldest = TriageListEntriesResultV1Schema.parse(await kit.invokeAction('tasks/list-v1', {
        v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'oldest',
      }, invocation()));
      // Source order persists; the Triage lens still owns its explicit sort.
      expect(oldest.window.rows.map(row => row.entryRef.entryId)).toEqual(['old-task', 'new-task']);
      expect(TriageTaskWriteResultV1Schema.parse(await kit.invokeAction('tasks/transition-v1', { ...aggregateAddress,
        transitionId: 'completed' }, invocation()))).toMatchObject({ kind: 'applied', observation: { snapshot: { state: { presentation: 'resolved' } } } });
      expect(await kit.invokeAction('internal/tasks/link-session-v1', { ...address, sessionId: 'work-session', linked: true })).toEqual({ status: 'linked' });
      await kit.dispose();
      kit = await open();
      const listed = TriageListEntriesResultV1Schema.parse(await kit.invokeAction('tasks/list-v1', {
        v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest',
      }, invocation()));
      expect(listed.window.rows.map(row => row.entryRef.entryId).sort()).toEqual(['new-task', 'old-task']);
      expect(await kit.invokeAction('entries/read-detail-v1', aggregateAddress, invocation())).toMatchObject({
        kind: 'read', instance, linkedSessions: [{ sessionId: 'work-session' }],
      });
      expect(TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', address))).toMatchObject({ kind: 'present',
        snapshot: { title: 'Edited once', relations: { parent: { entryId: 'old-task' }, blockedBy: [{ entryId: 'old-task' }] } } });
      expect(await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance, sessionId: 'work-session' })).toMatchObject({ kind: 'complete', links: [{ localRef: address.localRef }] });
      expect(await kit.invokeAction('internal/tasks/link-session-v1', { ...address, sessionId: 'work-session', linked: false })).toEqual({ status: 'unlinked' });
      expect(rows.get('todo.old-task')?.value).toEqual(predecessor);
      expect(rows.get('todo.new-task')?.value).toMatchObject({ id: 'new-task', title: 'Edited once', done: true,
        notes: 'Keep the whole\nmultiline note', parentId: 'old-task', blockedBy: ['old-task'], labels: ['personal'], linkedSessions: {} });
      expect(rows.get('todo.index')?.value).toEqual({ undoneOrder: ['old-task'], completedOrder: ['new-task'] });
      expect([...rows.keys()].sort()).toEqual(['todo.index', 'todo.new-task', 'todo.old-task']);
    } finally { await kit.dispose(); }
  });
  it('discovers a credentialless source and reads predecessor tasks through the admitted host owner', async () => {
    await withSource(async (kit, calls) => {
      expect(await kit.invokeAction('internal/tasks/list-instances-v1', { v: 1 })).toMatchObject({ kind: 'complete',
        candidates: [{ binding: instance.binding, localInstanceKey: 'personal' }] });
      const page = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', { v: 1, instance, page: { kind: 'initial', limit: 10 } }));
      expect(page).toMatchObject({ kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [{ kind: 'present', localRef,
        snapshot: { title: predecessor.title, state: { presentation: 'active', stage: 'unstarted' } } }] });
      const exact = TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef }));
      expect(exact).toMatchObject({ kind: 'present', localRef });
      expect(calls.every(call => call.id === 'tasks.internal.list')).toBe(true);
    });
  });

  it('preserves missing/unknown reads and write uncertainty without replay or task copies', async () => {
    await withSource(async (kit, calls) => {
      const result = TriageTaskWriteResultV1Schema.parse(await kit.invokeAction('internal/tasks/edit-v1', { v: 1, instance, localRef,
        fields: { title: 'One committed edit', blockedBy: [{ source, kindId: 'task', collisionScope: 'personal', entryId: 'dependency' }] } }));
      expect(result.kind).toBe('uncertain');
      expect(calls.filter(call => call.id === 'tasks.internal.edit')).toHaveLength(1);
      expect(calls.find(call => call.id === 'tasks.internal.edit')?.input).toMatchObject({ scope, taskId: predecessor.id,
        fields: { title: 'One committed edit', blockedBy: ['dependency'] } });
    });
    await withSource(async kit => {
      expect(TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', { v: 1, instance, page: { kind: 'initial', limit: 10 } }))).toMatchObject({ kind: 'failed' });
      expect(TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef }))).toMatchObject({ kind: 'unresolved' });
    }, { status: 'unavailable' });
  });

  it('reads legacy Session links once and routes linking through the todo owner only', async () => {
    await withSource(async (kit, calls) => {
      expect(await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance, sessionId: 'session-old' })).toEqual({ kind: 'complete',
        links: [{ localRef, sessionId: 'session-old', linkedAtMs: 19, displayPath: predecessor.title }] });
      expect(await kit.invokeAction('internal/tasks/link-session-v1', { v: 1, instance, localRef, sessionId: 'session-new', linked: true })).toEqual({ status: 'linked' });
      expect(calls.filter(call => call.id === 'tasks.internal.session.link')).toEqual([{ id: 'tasks.internal.session.link', input: {
        scope, taskId: predecessor.id, session: { ...scope, sessionId: 'session-new' }, linked: true,
      } }]);
    });
  });
});
