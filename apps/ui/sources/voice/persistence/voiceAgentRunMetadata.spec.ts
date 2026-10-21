import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSessionFixture, createSessionListRenderableSessionFixture, standardCleanup } from '@/dev/testkit';
import { buildVoiceAgentRunMetadataV1, parseVoiceAgentRunMetadataV1 } from '@happier-dev/protocol/voice/voiceAgentRunMetadataV1';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { ExecutionRunResumeHandleSchema } from '@happier-dev/protocol/execution/runs/index';
import { LegacyBackendTargetRefSchema } from '@happier-dev/protocol/backends/targets/backendTargetRef';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

let account: Awaited<ReturnType<typeof import('@/voice/settings/panels/voiceSettingsAccountTestHarness').createVoiceSettingsAccountTestHarness>>;
let storage: typeof import('@/sync/domains/state/storage').storage;
let sessionHttp: ReturnType<typeof import('@/dev/testkit/harness/sessionMetadataHttpBoundary').createSessionMetadataHttpBoundary>;
// The persisted V1 run producer still owns V1 targets; resume handles normalize to V2.
const claudeTarget = LegacyBackendTargetRefSchema.parse({ kind: 'builtInAgent', agentId: 'claude' });
const codexTarget = LegacyBackendTargetRefSchema.parse({ kind: 'builtInAgent', agentId: 'codex' });

function runMetadata(runId: string, updatedAtMs: number, welcomedEpoch?: number) {
  const metadata = buildVoiceAgentRunMetadataV1({ runId, updatedAtMs, backendTarget: claudeTarget,
    resumeHandle: ExecutionRunResumeHandleSchema.parse({ kind: 'provider_session.v1', backendTarget: claudeTarget, providerSessionId: `provider-${runId}` }),
    ...(welcomedEpoch === undefined ? {} : { welcomedEpoch }) });
  if (!metadata) throw new Error('Invalid canonical Voice run fixture');
  return metadata;
}

function seedRun(sessionId: string, payload: ReturnType<typeof runMetadata> & Readonly<{ streamId?: string }>) {
  storage.setState(state => ({ sessions: { ...state.sessions, [sessionId]: {
    ...state.sessions[sessionId]!, metadata: { ...state.sessions[sessionId]!.metadata!, voiceAgentRunV1: payload },
  } } }));
  sessionHttp.replaceSession(sessionId);
}

afterEach(() => standardCleanup());

beforeEach(async () => {
  const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
  onTestFinished(account.dispose);
  ({ storage } = await import('@/sync/domains/state/storage'));
  storage.setState({ sessions: {
    sys_voice: createSessionFixture({ id: 'sys_voice', serverId: account.scope.serverId,
      metadata: { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) } }),
    s1: createSessionFixture({ id: 's1', serverId: account.scope.serverId }),
  }, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
    sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} });
  const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
  sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
  const request = account.request.getMockImplementation();
  if (!request) throw new Error('Account HTTP boundary missing');
  account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init) ?? request(input, init)));
});

describe('voiceAgentRunMetadata through real storage and Sync', () => {
  it('reads persisted run identity and its resume handle from a Voice conversation', async () => {
    seedRun('sys_voice', runMetadata('run_1', 123));
    const { readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' })).toEqual(runMetadata('run_1', 123));
  });

  it('reads a layout-v1 run only from the owner metadata view', async () => {
    storage.setState(state => ({ sessions: { ...state.sessions, sys_voice: {
      ...state.sessions.sys_voice!, metadataLayoutVersion: 1,
      metadata: { ...createSessionFixture().metadata!, voiceAgentRunV1: runMetadata('shared_private_lookalike', 1) },
      ownerMetadataView: { ...createSessionFixture().metadata!, voiceAgentRunV1: runMetadata('owner_run', 2) },
    } } }));
    const { readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' })?.runId).toBe('owner_run');
    storage.setState(state => ({ sessions: { ...state.sessions, sys_voice: { ...state.sessions.sys_voice!, ownerMetadataView: null } } }));
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' })).toBeNull();
  });

  it('persists a canonical owner tuple and restores the published run through Sync', async () => {
    const { writeVoiceAgentRunMetadataToSession, readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    await writeVoiceAgentRunMetadataToSession({ sessionId: 'sys_voice', runId: 'run_2', backendTarget: codexTarget,
      resumeHandle: ExecutionRunResumeHandleSchema.parse({ kind: 'provider_session.v1', backendTarget: codexTarget, providerSessionId: 'vs_2' }), updatedAtMs: 999, welcomedEpoch: 4 });
    expect(sessionHttp.writes).toContain('sys_voice');
    const produced = readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' });
    expect(produced).toMatchObject({ runId: 'run_2', backendTarget: codexTarget, backendId: 'codex', updatedAtMs: 999, welcomedEpoch: 4 });
    expect(parseVoiceAgentRunMetadataV1(JSON.parse(JSON.stringify(produced)))).toEqual(produced);
    const { sync } = await import('@/sync/sync');
    storage.setState({ sessions: {} });
    expect(await sync.ensureSessionVisibleForMessageRoute('sys_voice', { forceRefresh: true, serverId: account.scope.serverId }))
      .toMatchObject({ kind: 'available', sessionId: 'sys_voice' });
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' })).toEqual(produced);
  });

  it('keeps the original timestamp when the same Voice run is published again', async () => {
    seedRun('sys_voice', runMetadata('run_same', 123));
    const { writeVoiceAgentRunMetadataToSession, readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    await writeVoiceAgentRunMetadataToSession({ sessionId: 'sys_voice', runId: 'run_same', backendTarget: claudeTarget,
      resumeHandle: runMetadata('run_same', 123).resumeHandle, updatedAtMs: 999 });
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' })?.updatedAtMs).toBe(123);
  });

  it('never persists a streamId carried by legacy metadata', async () => {
    seedRun('sys_voice', { ...runMetadata('run_prev', 10), streamId: 'stream_prev' });
    const { writeVoiceAgentRunMetadataToSession } = await import('./voiceAgentRunMetadata');
    await writeVoiceAgentRunMetadataToSession({ sessionId: 'sys_voice', runId: 'run_fresh', backendTarget: claudeTarget,
      resumeHandle: runMetadata('run_fresh', 20).resumeHandle, updatedAtMs: 20 });
    const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
    const metadata = readSessionOwnerMetadataView(storage.getState().sessions.sys_voice!);
    expect(metadata?.voiceAgentRunV1).toMatchObject({ runId: 'run_fresh' });
    expect(metadata?.voiceAgentRunV1).not.toHaveProperty('streamId');
  });

  it('clears the optional run field without removing neighboring owner metadata', async () => {
    seedRun('sys_voice', runMetadata('run_1', 123));
    const { clearVoiceAgentRunMetadataFromSession, readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    await clearVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' });
    expect(sessionHttp.writes).toContain('sys_voice');
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' })).toBeNull();
    const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
    expect(readSessionOwnerMetadataView(storage.getState().sessions.sys_voice!)).toMatchObject(
      buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }));
  });

  it('persists and clears runs on ordinary sessions as well as hidden Voice conversations', async () => {
    const { readVoiceAgentRunMetadataFromSession, writeVoiceAgentRunMetadataToSession, clearVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    await writeVoiceAgentRunMetadataToSession({ sessionId: 's1', runId: 'run_session', backendTarget: claudeTarget,
      resumeHandle: runMetadata('run_session', 456).resumeHandle, updatedAtMs: 456, welcomedEpoch: 3 });
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 's1' })).toEqual(runMetadata('run_session', 456, 3));
    await clearVoiceAgentRunMetadataFromSession({ sessionId: 's1' });
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 's1' })).toBeNull();
  });

  it('keeps private run identity at the hydrated owner instead of the shared list projection', async () => {
    seedRun('s1', runMetadata('run_raw', 111));
    storage.setState({ sessionListRowsByServerId: { [account.scope.serverId]: { s1: createSessionListRenderableSessionFixture({
      id: 's1', active: true, metadata: { path: '/shared-row', host: 'shared.test' },
    }) } }, ordinarySessionListMembershipByServerId: { [account.scope.serverId]: ['s1'] } });
    const { readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 's1' })).toEqual(runMetadata('run_raw', 111));
    seedRun('s1', runMetadata('run_current_owner', 222));
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 's1' })).toEqual(runMetadata('run_current_owner', 222));
  });

  it('reads the welcomed epoch retained with persisted run identity', async () => {
    seedRun('sys_voice', runMetadata('run_1', 123, 9));
    const { readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' })?.welcomedEpoch).toBe(9);
  });
});
