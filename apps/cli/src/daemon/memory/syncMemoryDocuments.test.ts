import axios from 'axios';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import type { MemoryDocumentSearchScope } from './syncMemoryDocuments';

const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
let homeDir: string;

beforeEach(async () => {
  homeDir = await createTempDir('happier-document-admission-');
  applyEnvValues({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.example.test', HAPPIER_WEBAPP_URL: 'https://app.example.test' });
  vi.resetModules();
  // Load the shared schema graph during setup; Session HTTP is installed below before its owner loads.
  await import('@happier-dev/protocol');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('@/session/transport/http/sessionsHttp');
  restoreEnvValues(envBackup);
  vi.resetModules();
  await removeTempDir(homeDir);
});

async function withCurrentDocumentFixture(run: (fixture: Readonly<{
  scope: MemoryDocumentSearchScope;
  db: DeepIndexDbHandle;
  dbPath: string;
  prepare: () => Promise<MemoryDocumentSearchScope>;
  serverId: string;
  artifactId: string;
  replaceAccount: () => void;
  credentials: import('@/persistence').StoredCredentials;
  setSessionWork: (work: Record<string, unknown>) => void;
  setArtifactState: (state: 'available' | 'unavailable' | 'missing') => void;
}>) => Promise<void>, machineId = 'session-machine', memory = false): Promise<void> {
  const { accountSettingsParse } = await import('@happier-dev/protocol');
  const { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol/storage/artifactStoredContent');
  const { emptyPromptLibraryRecordV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryCatalogV1');
  const { PromptLibraryCatalogKeyV1Schema } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
  const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
  const { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { withdrawActiveProjectAccountRowsSnapshot } = await import('@/workspaces/projectAccountRows');
  const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
  const { configuration } = await import('@/configuration');
  const serverId = configuration.activeServerId;
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
  const entry = { id: 'project.instructions', ref: { kind: 'doc' as const, artifactId: 'project-context' }, enabled: true, placement: 'system_append' as const,
    ...(memory ? { maxChars: '- Key preference [id: key; added: 1970-01-01]'.length } : {}) };
  const workspaceKey = { kind: 'workspace-ref', serverId, id: 'checkout' };
  const organizationKey = { kind: 'project-organization', serverId, projectKey: 'project' };
  const artifact = { id: entry.ref.artifactId, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
    header: encodePlainArtifactStoredContent({ v: 1, kind: memory ? 'memory_doc.v1' : 'prompt_doc.v2', title: 'Remote Project' }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(memory ? { v: 1, index: [
      { id: 'key', text: 'Key preference', createdAtMs: 0, sourceSessionRef: null },
      { id: 'budget', text: 'Another active preference', createdAtMs: 0, sourceSessionRef: null },
      { id: 'expired', text: 'Expired preference', createdAtMs: 0, expiresAtMs: 1, sourceSessionRef: null },
    ], topics: [
      { title: 'detail', summary: 'Topic summary', facts: [{ id: 'detail', text: 'Topic-only fact', createdAtMs: 0, sourceSessionRef: null }] },
      { title: 'archive', summary: 'Archived facts', facts: [{ id: 'old', text: 'Archived fact', createdAtMs: 0, sourceSessionRef: null }] },
    ] } : { v: 1, markdown: 'quartz remote project context', createdAtMs: 1, updatedAtMs: 1 }) }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    scopeKey: resolveAccountSettingsScopeKey(credentials), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
  let artifactState: 'available' | 'unavailable' | 'missing' = 'available';
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) } };
    if (path === '/v1/artifacts') return { status: 200, data: [artifact] };
    if (path === `/v1/artifacts/${artifact.id}`) {
      if (artifactState === 'unavailable') throw new Error('Artifact Home unavailable');
      if (artifactState === 'missing') return { status: 404, data: { error: 'artifact_not_found' } };
      return { status: 200, data: artifact };
    }
    throw new Error(`Unexpected document admission HTTP path: ${path}`);
  });
  // Account rows and Session HTTP are transport boundaries; Project association,
  // four-layer admission, document decoding and SQLite remain real.
  vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
    { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: {
      id: 'checkout', serverId, machineId: 'session-machine', rootPath: '/remote/repo', createdAtMs: 1, projectKey: 'project',
    } } } },
    { key: organizationKey, revision: 1, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: [entry] } } } },
  ] } });
  let sessionWork: Record<string, unknown> | undefined = memory ? { memoryEnabled: true } : undefined;
  vi.doMock('@/session/transport/http/sessionsHttp', async () => ({
    ...(await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp')),
    fetchSessionById: async () => ({ id: 'remote-session', seq: 1, createdAt: 1, updatedAt: 1, activeAt: 0, encryptionMode: 'plain',
      metadata: JSON.stringify({ ...createTestMetadata({ machineId: 'session-machine', path: '/container/checkout',
        sessionWorkspaceLocationV1: { v: 1, machineId: 'session-machine', agentPath: '/container/checkout', machinePath: '/remote/repo' } }),
        workspaceId: 'checkout', projectId: 'project', ...(sessionWork ? { work: sessionWork } : {}) }) }),
    fetchSessionsPage: async () => ({ sessions: [{ id: 'remote-session', seq: 1, createdAt: 1, updatedAt: 1, activeAt: 0 }], nextCursor: null, hasNext: false }),
  }));
  const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
  const { syncMemoryDocuments } = await import('./syncMemoryDocuments');
  const dbPath = join(homeDir, 'deep.sqlite');
  const db = openDeepIndexDb({ dbPath });
  const prepare = () => syncMemoryDocuments({ credentials, machineId, scope: memory ? { type: 'session', sessionId: 'remote-session' } : { type: 'global' },
    includeArchivedSessions: false, db, assertCurrent: () => {} });
  try {
    const scope = await prepare();
    await run({ scope, db, dbPath, prepare, serverId, artifactId: artifact.id, credentials,
      setArtifactState: state => { artifactState = state; },
      setSessionWork: work => { sessionWork = work; }, replaceAccount: () => {
      const replacement = { token: `header.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`, encryption: null };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        scopeKey: resolveAccountSettingsScopeKey(replacement), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    } });
  } finally {
    db.close();
    resetActiveAccountSettingsSnapshotForTests();
    withdrawActiveProjectAccountRowsSnapshot();
  }
}

it('qualifies global Project documents using the owning Session Machine and workspace mapping', async () => {
  await withCurrentDocumentFixture(async ({ scope, db, serverId, artifactId }) => {
    expect(scope).toMatchObject({ state: 'ready', eligibleDocuments: [{ ref: { serverId, artifactId }, revision: { headerVersion: 1, bodyVersion: 1 } }] });
    expect(db.searchDocuments({ query: 'quartz', eligibleDocuments: scope.eligibleDocuments, maxResults: 10 }))
      .toEqual([expect.objectContaining({ text: 'quartz remote project context', location: 'document' })]);
  }, 'daemon-machine');
});

it('retains the global document index during optional transport unavailability and prunes observed absence', async () => {
  await withCurrentDocumentFixture(async ({ scope, db, prepare, setArtifactState }) => {
    const search = () => db.searchDocuments({ query: 'quartz', eligibleDocuments: scope.eligibleDocuments, maxResults: 10 });
    expect(search()).toHaveLength(1);
    setArtifactState('unavailable');
    expect(await prepare()).toMatchObject({ state: 'pending', eligibleDocuments: [] });
    expect(search()).toHaveLength(1);
    setArtifactState('missing');
    expect(await prepare()).toMatchObject({ state: 'ready', eligibleDocuments: [] });
    expect(search()).toHaveLength(0);
  });
});

it('retains budget-loaded preparation facts separately from indexed topics, archive and expired facts', async () => {
  await withCurrentDocumentFixture(async ({ scope, db, serverId, artifactId }) => {
    expect(scope).toMatchObject({ state: 'ready', preparation: [{ ref: { serverId, artifactId },
      revision: { headerVersion: 1, bodyVersion: 1 }, loadedFactIds: ['key'] }] });
    expect(db.getDocumentFactCounts({ eligibleDocuments: scope.eligibleDocuments })).toEqual([
      { ref: { serverId, artifactId }, revision: { headerVersion: 1, bodyVersion: 1 }, indexedFactCount: 5 },
    ]);
  }, 'session-machine', true);
});

it('exposes fresh scoped preparation and exact indexed facts through daemon status', async () => {
  await withCurrentDocumentFixture(async ({ credentials, serverId, artifactId, setSessionWork }) => {
    const { DEFAULT_MEMORY_SETTINGS, writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ ...DEFAULT_MEMORY_SETTINGS, enabled: true, indexMode: 'deep' });
    const { startMemoryWorker } = await import('./memoryWorker');
    const worker = await startMemoryWorker({ credentials, machineId: 'session-machine' });
    try {
      const { registerMachineMemoryRpcHandlers } = await import('@/api/machine/rpcHandlers.memory');
      const { RPC_METHODS, MemoryStatusV1Schema } = await import('@happier-dev/protocol');
      const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
      // Registration is the RPC transport boundary; the worker, admission and SQLite are real.
      const transport = { registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      } } as unknown as import('@/api/rpc/RpcHandlerManager').RpcHandlerManager;
      registerMachineMemoryRpcHandlers({ rpcHandlerManager: transport, memoryWorker: worker });
      const status = MemoryStatusV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS)!({
        scope: { type: 'session', sessionId: 'remote-session' },
      }));
      expect(status.documents).toEqual({ state: 'ready', facts: [{
        ref: { kind: 'doc', serverId, artifactId }, revision: { headerVersion: 1, bodyVersion: 1 },
        loadedFactCount: 1, indexedFactCount: 5,
      }] });
      expect(MemoryStatusV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS)!({})).documents).toBeUndefined();
      expect(MemoryStatusV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS)!({ scope: { type: 'global' } })).documents)
        .toEqual({ state: 'ready', facts: [{ ref: { kind: 'doc', serverId, artifactId },
          revision: { headerVersion: 1, bodyVersion: 1 }, indexedFactCount: 5 }] });
      for (const work of [{ memoryEnabled: false }, { memoryEnabled: true, disabledInheritedEntryIds: ['project.instructions'] }]) {
        setSessionWork(work);
        expect(MemoryStatusV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS)!({
          scope: { type: 'session', sessionId: 'remote-session' },
        })).documents).toEqual({ state: 'ready', facts: [] });
      }
    } finally {
      await worker.stop();
    }
  }, 'session-machine', true);
});

it('withdraws ready document admission after Account retirement before the consumer continuation', async () => {
  await withCurrentDocumentFixture(async ({ scope, dbPath, prepare, replaceAccount }) => {
    expect(scope.state).toBe('ready');
    const { searchTier2Memory } = await import('./searchMemory');
    const result = await searchTier2Memory({ dbPath,
      query: { v: 1, query: 'quartz', scope: { type: 'global' }, mode: 'deep', corpora: ['documents'] }, previewChars: 200,
      resolveDocuments: async () => {
        // Real admission remains intact; the Account boundary changes while its consumer resumes.
        const current = await prepare();
        expect(current.state).toBe('ready');
        replaceAccount();
        return current;
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'memory_failed' });
    expect(result).not.toHaveProperty('hits');
  });
});
