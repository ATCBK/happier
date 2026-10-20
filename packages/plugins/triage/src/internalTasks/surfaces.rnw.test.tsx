// @vitest-environment jsdom
import { act, cloneElement, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit,
  type PluginUiSemanticSurfaceMount } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiHostApi, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageConfiguredSourceInstanceV1Schema, TriageDetailSurfaceInputV1Schema, type TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { INTERNAL_TASK_DRAFT_V1, INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from './source.js';
import { renderSurface as renderDetail } from './detail.js';
import { renderSurface as renderSettings } from './settings.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await act(async () => { await fixture.dispose(); }); });
type ExecuteAction = NonNullable<NonNullable<Parameters<typeof createPluginUiTestkit>[0]['handlers']>['executeAction']>;
type TaskList = Extract<PluginActionResultById['tasks.internal.list'], { status: 'ok' }>;

function detailInput(taskId = 'task-a', observedAtMs = 1): TriageDetailSurfaceInputV1 {
  const basis = createTriageSourceV1Fixture().detailInput;
  return TriageDetailSurfaceInputV1Schema.parse({ ...basis,
    instance: { ...basis.instance, binding: INTERNAL_TASK_DRAFT_V1.binding,
      localInstanceKey: INTERNAL_TASK_DRAFT_V1.localInstanceKey, configuration: INTERNAL_TASK_DRAFT_V1.configuration,
      instance: { ...basis.instance.instance, source: INTERNAL_TASK_SOURCE_V1 } },
    observation: { ...basis.observation, observedAtMs,
      entryRef: { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(taskId) } },
  });
}

function taskList(taskId = 'task-a', notes = 'Keep the reviewed implementation notes.'): TaskList {
  return { status: 'ok', scope: { serverId: 'home-a', accountId: 'account-a' },
    todos: [{ id: taskId, title: 'Reviewed task', notes, state: 'unstarted', done: false, createdAt: 1, updatedAt: 1 }],
    undoneOrder: [taskId], completedOrder: [] };
}

function accountData(options: Readonly<{ waitForSources?: Promise<void>; failSources?: boolean }> = {}) {
  const corpus = createTestkitCorpusCollections();
  const byId = new Map([
    ['source-instances', { ...corpus.collections.sourceInstances, query: async (...args: Parameters<typeof corpus.collections.sourceInstances.query>) => {
      await options.waitForSources;
      if (options.failSources) throw new Error('Account unavailable');
      return corpus.collections.sourceInstances.query(...args);
    } }],
    ['session-links', corpus.collections.sessionLinks],
    ['user-marks', corpus.collections.userMarks],
  ]);
  // Account Collection/KV transport is the boundary; binding, decoding and lifecycle selection stay real.
  const client: PluginUiDataClient = {
    collection(definition) {
      const collection = byId.get(definition.id);
      if (!collection) throw new Error(`Undeclared Collection: ${definition.id}`);
      return collection as ReturnType<PluginUiDataClient['collection']>;
    },
    accountKv: createTestkitAccountKv().kv,
    async openCollectionQuery() { throw new Error('No UI query is declared here.'); },
  };
  return { client, corpus };
}

async function mountSurface(surface: RenderSurface, executeAction: ExecuteAction, launchInput?: TriageDetailSurfaceInputV1,
  dataClient: PluginUiDataClient | null = accountData().client) {
  const adapter = createPluginUiRnwSemanticSurfaceAdapter();
  let mount: PluginUiSemanticSurfaceMount | undefined;
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'internal-tasks', mountNonce: `internal-${mounted.length}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
      surfaceContext: createSurfaceContextFixture(), launchInput,
      adapter: { mount: async input => {
        mount = await adapter.mount({ ...input, surface: context => cloneElement(
          input.surface(context) as ReactElement<{ dataClient?: PluginUiDataClient }>,
          dataClient === null ? {} : { dataClient },
        ) });
        return mount;
      } },
      // Only the real host Action transport is substituted; the renderer and UI primitives remain real.
      handlers: { executeAction },
    });
  });
  mounted.push(fixture);
  return { fixture, updateInput: async (input: TriageDetailSurfaceInputV1, hostApi = fixture.context.hostApi) => {
    if (!mount) throw new Error('Expected the real semantic mount');
    await mount.update({ ...fixture.context, hostApi, launchInput: input });
  }, updateHostApi: async (hostApi: PluginUiHostApi) => {
    if (!mount) throw new Error('Expected the real semantic mount');
    await mount.update({ ...fixture.context, hostApi });
  }, updateDataClient: async (next: PluginUiDataClient) => {
    if (!mount) throw new Error('Expected the real semantic mount');
    dataClient = next;
    await mount.update(fixture.context);
  } };
}

it('does not offer setup until the configured-source read settles, or when that read fails', async () => {
  let finishRead!: () => void;
  const pending = accountData({ waitForSources: new Promise<void>(resolve => { finishRead = resolve; }) });
  const failed = accountData({ failSources: true });
  const calls: string[] = [];
  const execute: ExecuteAction = ({ action }) => { calls.push(action); throw new Error('No write expected'); };
  const first = await mountSurface(renderSettings, execute, undefined, pending.client);
  await expect(first.fixture.queryByRole('button', { name: 'Turn on' })).resolves.toBeUndefined();
  await act(async () => { finishRead(); });
  const second = await mountSurface(renderSettings, execute, undefined, failed.client);
  await expect(second.fixture.queryByRole('button', { name: 'Turn on' })).resolves.toBeUndefined();
  expect(calls).toEqual([]);
});

function seedPersonalSource(corpus: ReturnType<typeof accountData>['corpus'], kind: 'active' | 'retired' | 'unrelated' = 'active') {
  const configured = TriageConfiguredSourceInstanceV1Schema.parse({
    v: 1, binding: INTERNAL_TASK_DRAFT_V1.binding, localInstanceKey: INTERNAL_TASK_DRAFT_V1.localInstanceKey,
    configuration: INTERNAL_TASK_DRAFT_V1.configuration, locator: INTERNAL_TASK_DRAFT_V1.locator,
    instance: { source: kind === 'unrelated' ? { pluginId: 'other.source', localId: 'internal' } : INTERNAL_TASK_SOURCE_V1,
      sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
  });
  corpus.control.sourceInstances.seed(toCorpusStoredValue({
    instanceTag: `a${'0'.repeat(42)}`, sourceQualifiedId: `${configured.instance.source.pluginId}/${configured.instance.source.localId}`,
    lifecycle: kind === 'retired' ? CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired : CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
    configuredAtMs: 1, configured,
  }));
}

it.each(['active', 'retired', 'unrelated'] as const)('reads %s personal-source configuration before offering setup, without writing', async kind => {
  const { client, corpus } = accountData();
  seedPersonalSource(corpus, kind);
  const calls: string[] = [];
  const { fixture } = await mountSurface(renderSettings, ({ action }) => { calls.push(action); throw new Error('No write expected'); }, undefined, client);
  if (kind === 'active') {
    await expect(fixture.getByText('On')).resolves.toBeDefined();
    await expect(fixture.queryByRole('button', { name: 'Turn on' })).resolves.toBeUndefined();
  } else {
    await expect(fixture.getByRole('button', { name: 'Turn on' })).resolves.toBeDefined();
    await expect(fixture.queryByText('On')).resolves.toBeUndefined();
    // The row says what turning it on does.
    await expect(fixture.getByText('Your existing tasks and linked Sessions appear in Tasks.')).resolves.toBeDefined();
  }
  expect(calls).toEqual([]);
});

it('retires personal-source state on Account replacement and ignores the retired read completion', async () => {
  const original = accountData();
  seedPersonalSource(original.corpus);
  const calls: string[] = [];
  const surface = await mountSurface(renderSettings, ({ action }) => { calls.push(action); throw new Error('No write expected'); }, undefined, original.client);
  await expect(surface.fixture.getByText('On')).resolves.toBeDefined();

  let finishRead!: () => void;
  const pending = accountData({ waitForSources: new Promise<void>(resolve => { finishRead = resolve; }) });
  seedPersonalSource(pending.corpus);
  await act(async () => { await surface.updateDataClient(pending.client); });
  await expect(surface.fixture.queryByText('On')).resolves.toBeUndefined();
  await expect(surface.fixture.queryByRole('button', { name: 'Turn on' })).resolves.toBeUndefined();

  await act(async () => { await surface.updateDataClient(accountData().client); });
  await act(async () => { finishRead(); });
  await expect(surface.fixture.queryByText('On')).resolves.toBeUndefined();
  await expect(surface.fixture.getByRole('button', { name: 'Turn on' })).resolves.toBeDefined();
  expect(calls).toEqual([]);
});

it('configures only on user intent, once while pending and after successful setup', async () => {
  const calls: unknown[] = [];
  let settle!: (value: unknown) => void;
  const response = new Promise(resolve => { settle = resolve; });
  const { fixture } = await mountSurface(renderSettings, ({ action, input }) => {
    calls.push({ action, input });
    return response;
  });
  expect(calls).toEqual([]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Turn on' })); });
  expect(calls).toEqual([{ action: 'internal/tasks/configure-v1', input: { v: 1 } }]);
  await expect(fixture.press(await fixture.getByRole('button', { name: 'Turn on' }))).rejects.toThrow();
  await act(async () => { settle(createTriageSourceV1Fixture().administrationResult); });
  await expect(fixture.getByText('On')).resolves.toBeDefined();
  await expect(fixture.queryByRole('button', { name: 'Turn on' })).resolves.toBeUndefined();
  expect(calls).toHaveLength(1);
});

it('enables setup for a replacement host without mount writes or accepting an old completion', async () => {
  const calls: string[] = [];
  const result = createTriageSourceV1Fixture().administrationResult;
  const original = await mountSurface(renderSettings, ({ action }) => { calls.push(`original:${action}`); return result; });
  await act(async () => { await original.fixture.press(await original.fixture.getByRole('button', { name: 'Turn on' })); });
  await expect(original.fixture.getByText('On')).resolves.toBeDefined();
  let settleOld!: (value: unknown) => void;
  const next = await mountSurface(renderSettings, ({ action }) => {
    calls.push(`next:${action}`);
    return new Promise(resolve => { settleOld = resolve; });
  });
  await act(async () => { await original.updateHostApi(next.fixture.context.hostApi); });
  expect(calls).toEqual(['original:internal/tasks/configure-v1']);
  await act(async () => { await original.fixture.press(await original.fixture.getByRole('button', { name: 'Turn on' })); });
  let settleCurrent!: (value: unknown) => void;
  const successor = await mountSurface(renderSettings, ({ action }) => {
    calls.push(`successor:${action}`);
    return new Promise(resolve => { settleCurrent = resolve; });
  });
  await act(async () => { await original.updateHostApi(successor.fixture.context.hostApi); });
  expect(calls).toEqual(['original:internal/tasks/configure-v1', 'next:internal/tasks/configure-v1']);
  await expect(original.fixture.queryByText('On')).resolves.toBeUndefined();
  await act(async () => { await original.fixture.press(await original.fixture.getByRole('button', { name: 'Turn on' })); });
  await act(async () => { settleOld(result); });
  await expect(original.fixture.queryByText('On')).resolves.toBeUndefined();
  await expect(original.fixture.press(await original.fixture.getByRole('button', { name: 'Turn on' }))).rejects.toThrow();
  await act(async () => { settleCurrent(result); });
  await expect(original.fixture.getByText('On')).resolves.toBeDefined();
  expect(calls).toEqual(['original:internal/tasks/configure-v1', 'next:internal/tasks/configure-v1', 'successor:internal/tasks/configure-v1']);
});

it('keeps last good notes visible through a failed re-observation, then reflects a confirmed deletion', async () => {
  let reject!: (reason: Error) => void;
  let reads = 0;
  const { fixture, updateInput } = await mountSurface(renderDetail, ({ action }) => {
    expect(action).toBe('tasks.internal.list');
    reads++;
    if (reads === 2) return new Promise((_resolve, rejectRead) => { reject = rejectRead; });
    return reads === 1 ? taskList() : { ...taskList(), todos: [] };
  }, detailInput());
  await expect(fixture.getByText(taskList().todos[0]!.notes!)).resolves.toBeDefined();
  await act(async () => { await updateInput(detailInput('task-a', 2)); });
  await expect(fixture.getByText(taskList().todos[0]!.notes!)).resolves.toBeDefined();
  await act(async () => { reject(new Error('Home disconnected')); });
  await expect(fixture.getByText(taskList().todos[0]!.notes!)).resolves.toBeDefined();
  await expect(fixture.getByText('This task could not be read')).resolves.toBeDefined();
  await act(async () => { await updateInput(detailInput('task-a', 3)); });
  await expect(fixture.queryByText(taskList().todos[0]!.notes!)).resolves.toBeUndefined();
});

it('cancels the previous selected task read and cannot display its late result in another detail', async () => {
  const signals: AbortSignal[] = [];
  let settleOld!: (value: TaskList) => void;
  let settleRetired!: (value: TaskList) => void;
  const { fixture, updateInput } = await mountSurface(renderDetail, ({ signal }) => {
    signals.push(signal);
    if (signals.length === 1) return new Promise(resolve => { settleOld = resolve; });
    if (signals.length === 3) return new Promise(resolve => { settleRetired = resolve; });
    return taskList('task-b', 'Only the second task notes.');
  }, detailInput());
  await act(async () => { await updateInput(detailInput('task-b', 2)); });
  expect(signals[0]!.aborted).toBe(true);
  await act(async () => { settleOld(taskList()); });
  await expect(fixture.getByText('Only the second task notes.')).resolves.toBeDefined();
  await expect(fixture.queryByText(taskList().todos[0]!.notes!)).resolves.toBeUndefined();
  await act(async () => { await updateInput(detailInput('task-b', 3)); });
  await act(async () => { await fixture.dispose(); });
  expect(signals[2]!.aborted).toBe(true);
  await act(async () => { settleRetired(taskList('task-b', 'Late retired notes')); });
});

it('refuses a different source instead of reading an internal task with the same local id', async () => {
  const input = detailInput();
  const source = { pluginId: 'other.source', localId: 'internal' };
  const foreign = TriageDetailSurfaceInputV1Schema.parse({ ...input,
    instance: { ...input.instance, instance: { ...input.instance.instance, source } },
    observation: { ...input.observation, entryRef: { ...input.observation.entryRef, source } },
  });
  let reads = 0;
  const { fixture } = await mountSurface(renderDetail, () => { reads++; return taskList(); }, foreign);
  expect(reads).toBe(0);
  await expect(fixture.queryByText(taskList().todos[0]!.notes!)).resolves.toBeUndefined();
  await expect(fixture.getByText('This task could not be read')).resolves.toBeDefined();
});

it('does not carry notes across an Account-bound host replacement with the same task id', async () => {
  const { fixture, updateInput } = await mountSurface(renderDetail, () => taskList(), detailInput());
  let settle!: (value: TaskList) => void;
  const replacement = await mountSurface(renderSettings, ({ action }) => {
    expect(action).toBe('tasks.internal.list');
    return new Promise(resolve => { settle = resolve; });
  });
  // A replacement host is a distinct Account-bound transport, not a mutable local Account cache.
  const hostApi: PluginUiHostApi = replacement.fixture.context.hostApi;
  await act(async () => { await updateInput(detailInput(), hostApi); });
  await expect(fixture.queryByText(taskList().todos[0]!.notes!)).resolves.toBeUndefined();
  await act(async () => { settle({ ...taskList('task-a', 'Only the replacement Account notes.'),
    scope: { serverId: 'home-b', accountId: 'account-b' } }); });
  await expect(fixture.getByText('Only the replacement Account notes.')).resolves.toBeDefined();
});
