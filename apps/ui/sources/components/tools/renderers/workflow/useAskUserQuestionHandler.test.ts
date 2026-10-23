import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, createRenderCommitCounter, createSessionFixture, renderHook, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
const { useAskUserQuestionHandler } = await import('./useAskUserQuestionHandler');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
let activeScope: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;

beforeEach(async () => { await homes.reset(); });
afterEach(() => { standardCleanup(); activeScope?.dispose(); activeScope = null; });

it.each([0, 1])('explains the stopped manager from layout %s scoped list rows without live carriers', async metadataLayoutVersion => {
  const serverId = await homes.addHome({ name: 'Questions', serverUrl: 'https://question-list-manager.test', accountId: 'alice', currentAccount: true });
  activeScope = await activateStorageAccountScope({ serverId, accountId: 'alice' }, storage);
  const ownerMetadata = { path: '/repo', host: 'test', name: 'Daily coordinator',
    sessionExplicitStopV1: { v: 1 as const, cause: 'explicit_stop' as const, requestId: 'stop', requestedAtMs: 1 } };
  const manager = createSessionFixture({ id: 'manager', serverId, presence: 1, metadataLayoutVersion,
    metadata: metadataLayoutVersion === 0 ? ownerMetadata : { path: '/repo', host: 'test' },
    ...(metadataLayoutVersion === 1 ? { ownerMetadataView: ownerMetadata } : {}) });
  const worker = createSessionFixture({ id: 'worker', serverId, manager: { sessionId: manager.id } });
  const initialManager = metadataLayoutVersion === 1
    ? { ...manager, metadataUndecided: true as const,
      ownerMetadataView: { path: '/repo', host: 'test', name: 'Daily coordinator' } }
    : manager;
  storage.getState().applyServerScopedSessionListRows(serverId,
    [worker, initialManager].map(session => buildSessionListRenderableFromSession(session)), { source: 'ordinary', mode: 'replace' });
  expect(storage.getState().sessions.manager).toBeUndefined();
  const counter = createRenderCommitCounter();
  const hook = await renderHook(() => {
    useRenderCommitCounter(counter);
    return useAskUserQuestionHandler({ kind: 'person' }, serverId,
      { sessionId: worker.id, questionV1: { mode: 'wait', lasting: false } });
  });
  if (metadataLayoutVersion === 1) {
    // Owner visibility can arrive before its full metadata: absence in that
    // partial projection cannot establish the manager's answering preference.
    expect(hook.getCurrent()).toBeNull();
    await act(async () => { storage.getState().applyServerScopedSessionListRows(serverId,
      [worker, manager].map(session => buildSessionListRenderableFromSession(session)), { source: 'ordinary', mode: 'replace' }); });
  }
  expect(hook.getCurrent()).toEqual({ name: 'Daily coordinator', availability: 'stopped' });
  counter.reset();
  await act(async () => { storage.setState({ sessions: {
    worker: { ...worker, manager: { sessionId: 'stale-manager' } },
    unrelated: createSessionFixture({ id: 'unrelated', serverId }),
  } }); });
  expect(hook.getCurrent()).toEqual({ name: 'Daily coordinator', availability: 'stopped' });
  expect(counter.read()).toEqual({ renders: 0, commits: 0 });
  const olderMetadata = { path: '/repo', host: 'test', name: 'Daily coordinator' };
  await act(async () => { storage.getState().applyServerScopedSessionListRows(serverId,
    [worker, { ...manager, metadataVersion: 0, ...(metadataLayoutVersion === 1
      ? { ownerMetadataView: olderMetadata } : { metadata: olderMetadata }) }]
      .map(session => buildSessionListRenderableFromSession(session)), { source: 'ordinary', mode: 'replace' }); });
  expect(hook.getCurrent()).toEqual({ name: 'Daily coordinator', availability: 'stopped' });
  const disabledMetadata = { ...ownerMetadata, work: { sessionRolesV1: {
    overrides: {}, sessionRoles: {}, notes: '', answersWorkerQuestions: false,
  } } };
  await act(async () => { storage.getState().applyServerScopedSessionListRows(serverId,
    [worker, { ...manager, metadataVersion: 2, ...(metadataLayoutVersion === 1
      ? { ownerMetadataView: disabledMetadata } : { metadata: disabledMetadata }) }]
      .map(session => buildSessionListRenderableFromSession(session)), { source: 'ordinary', mode: 'replace' }); });
  expect(hook.getCurrent()).toBeNull();
  const foreign = await renderHook(() => useAskUserQuestionHandler({ kind: 'session', sessionId: manager.id }, 'foreign-home'));
  expect(foreign.getCurrent()).toBeNull();
  await hook.unmount(); await foreign.unmount();
});

it('explains a stopped manager for a person-handled question without changing its handler', async () => {
  const serverId = await homes.addHome({ name: 'Questions', serverUrl: 'https://question-manager.test', accountId: 'alice', currentAccount: true });
  activeScope = await activateStorageAccountScope({ serverId, accountId: 'alice' }, storage);
  const stop = { v: 1 as const, cause: 'explicit_stop' as const, requestId: 'stop', requestedAtMs: 1 };
  const manager = createSessionFixture({ id: 'manager', serverId, presence: 1,
    metadataLayoutVersion: 1, metadata: { path: '/repo', host: 'test' },
    ownerMetadataView: { path: '/repo', host: 'test', name: 'Daily coordinator', sessionExplicitStopV1: stop } });
  const currentHandler = { kind: 'person' as const };
  const questionV1 = { mode: 'wait' as const, lasting: false };
  const worker = createSessionFixture({ id: 'worker', serverId, manager: { sessionId: manager.id },
    agentState: { requests: { question: { tool: 'AskUserQuestion', arguments: {}, createdAt: 1, currentHandler, questionV1 } } } });
  storage.setState({ sessions: { worker, manager } });
  const source = { sessionId: worker.id, questionV1 };
  const hook = await renderHook(() => useAskUserQuestionHandler(currentHandler, serverId, source));
  expect(hook.getCurrent()).toEqual({ name: 'Daily coordinator', availability: 'stopped' });
  expect(storage.getState().sessions.worker?.agentState?.requests?.question?.currentHandler).toEqual({ kind: 'person' });

  // Resuming the manager cannot make it the handler of this already-routed question.
  await act(async () => { storage.setState({ sessions: { worker, manager: { ...manager, presence: 'online',
    ownerMetadataView: { path: '/repo', host: 'test', name: 'Daily coordinator' } } } }); });
  expect(hook.getCurrent()).toBeNull();
  expect(storage.getState().sessions.worker?.agentState?.requests?.question?.currentHandler).toEqual({ kind: 'person' });
  await hook.unmount();
});

it('does not attach manager handling to lasting questions, disabled managers or another Home', async () => {
  const serverId = await homes.addHome({ name: 'Questions', serverUrl: 'https://question-exclusions.test', accountId: 'alice', currentAccount: true });
  activeScope = await activateStorageAccountScope({ serverId, accountId: 'alice' }, storage);
  const manager = createSessionFixture({ id: 'manager', serverId, presence: 1,
    metadata: { path: '/repo', host: 'test', name: 'Daily coordinator',
      work: { sessionRolesV1: { v: 1, overrides: {}, answersWorkerQuestions: false } } } });
  const worker = createSessionFixture({ id: 'worker', serverId, manager: { sessionId: manager.id } });
  storage.setState({ sessions: { worker, manager } });
  const disabled = await renderHook(() => useAskUserQuestionHandler({ kind: 'person' }, serverId,
    { sessionId: worker.id, questionV1: { mode: 'wait', lasting: false } }));
  expect(disabled.getCurrent()).toBeNull();
  await disabled.unmount();
  await act(async () => { storage.setState({ sessions: { worker, manager: { ...manager,
    metadata: { path: '/repo', host: 'test', name: 'Daily coordinator' } } } }); });
  const lasting = await renderHook(() => useAskUserQuestionHandler({ kind: 'person' }, serverId,
    { sessionId: worker.id, questionV1: { mode: 'wait', lasting: true } }));
  expect(lasting.getCurrent()).toBeNull();
  const foreign = await renderHook(() => useAskUserQuestionHandler({ kind: 'session', sessionId: manager.id }, 'foreign-home'));
  expect(foreign.getCurrent()).toBeNull();
  await lasting.unmount(); await foreign.unmount();
});
