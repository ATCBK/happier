import axios from 'axios';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import type { MemoryDocumentSearchScope } from './syncMemoryDocuments';

// Cold transformation belongs to collection, outside the admission workload deadline.
await import('@/api/api');

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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock('@/session/transport/http/sessionsHttp');
  restoreEnvValues(envBackup);
  vi.resetModules();
  await removeTempDir(homeDir);
});

async function withCurrentDocumentFixture(run: (fixture: Readonly<{
  scope: MemoryDocumentSearchScope;
  db: DeepIndexDbHandle;
  dbPath: string;
  prepare: (options?: Readonly<{ includeArchivedSessions?: boolean; signal?: AbortSignal }>) => Promise<MemoryDocumentSearchScope>;
  serverId: string;
  artifactId: string;
  replaceAccount: () => void;
  credentials: import('@/persistence').StoredCredentials;
  setSessionWork: (work: Record<string, unknown>) => void;
  setArtifactState: (state: 'available' | 'unavailable' | 'missing') => void;
  setCurrentnessStatus: (status: number) => void;
  setSessionDetailUnavailable: (unavailable: boolean) => void;
  setInventoryState: (state: 'paged' | 'incomplete' | 'unreadable' | 'archived') => void;
  setSessionCount: (count: number) => void;
  setSessionSharedContentUnavailable: (unavailable: boolean) => void;
}>) => Promise<void>, machineId = 'session-machine', memory = false): Promise<void> {
  const { accountSettingsParse } = await import('@happier-dev/protocol');
  const { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol/storage/artifactStoredContent');
  const { emptyPromptLibraryRecordV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryCatalogV1');
  const { PromptLibraryCatalogKeyV1Schema } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
  const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
  const { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { withdrawActiveProjectAccountRowsSnapshot } = await import('@/workspaces/projectAccountRows');
  const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
  const { buildSessionMetadataEnvelopeFields } = await import('@/session/metadata/buildSessionMetadataEnvelopeCreateFields');
  const { sealSessionOwnerMetadataEnvelopeV1 } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1');
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
  let currentnessStatus = 200;
  let sessionDetailUnavailable = false;
  let inventoryState: 'paged' | 'incomplete' | 'unreadable' | 'archived' | undefined;
  let sessionCount = 1;
  let sessionSharedContentUnavailable = false;
  let sessionWork: Record<string, unknown> | undefined = memory ? { memoryEnabled: true } : undefined;
  const sessionRecord = () => {
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
      ...(sessionSharedContentUnavailable
        ? { storedContentMode: 'e2ee', encryptionKey: new Uint8Array(32).fill(19), encryptionVariant: 'dataKey' } as const
        : { storedContentMode: 'plain' } as const),
      agentState: null, metadata: { ...createTestMetadata({ machineId: 'session-machine', path: '/container/checkout',
      sessionWorkspaceLocationV1: { v: 1, machineId: 'session-machine', agentPath: '/container/checkout', machinePath: '/remote/repo' } }),
      workspaceId: 'checkout', projectId: 'project', ...(sessionWork ? { work: sessionWork } : {}) } });
    return { id: 'remote-session', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 0,
      encryptionMode: sessionSharedContentUnavailable ? 'e2ee' as const : 'plain' as const,
      metadataVersion: 1, dataEncryptionKey: null, share: null,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: inventoryState === 'unreadable' ? sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
        ownerMetadata: fields.ownerMetadataValue, randomBytes: length => new Uint8Array(length).fill(3),
      }) : fields.ownerMetadata, agentState: fields.agentState, agentStateVersion: 0 };
  };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/sessions' || path === '/v2/sessions/archived') {
      if (inventoryState === 'archived' && path === '/v2/sessions') {
        return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
      }
      if (inventoryState === 'paged' && !new URL(String(url)).searchParams.has('cursor')) {
        return { status: 200, data: { sessions: [], nextCursor: 'next-page', hasNext: true } };
      }
      return { status: 200, data: { sessions: Array.from({ length: sessionCount }, (_, i) => ({ ...sessionRecord(),
        id: i === 0 ? 'remote-session' : `remote-session-${i}`,
        ...(path.endsWith('/archived') ? { archivedAt: 1 } : {}),
        })), nextCursor: null, hasNext: false,
        ...(inventoryState === 'incomplete' ? { metadataUpgradeRequiredCount: 1 } : {}) } };
    }
    if (/^\/v2\/sessions\/remote-session(?:-\d+)?$/.test(path)) {
      if (sessionDetailUnavailable) throw Object.assign(new Error('Session detail transport unavailable'), { code: 'ECONNRESET' });
      return { status: 200, data: { session: { ...sessionRecord(), id: path.split('/').at(-1) } } };
    }
    if (path === '/v1/account/encryption/currentness') return { status: currentnessStatus, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'account' } };
    if (path === '/v1/auth/ping') return { status: 200, data: { ok: true } };
    if (path === '/v2/changes') return { status: 200, data: { changes: [], nextCursor: 1,
      sessionAccessProbe: { v: 1, sessionId: 'remote-session', throughCursor: 1, status: 'available' } } };
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
  const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
  const { syncMemoryDocuments } = await import('./syncMemoryDocuments');
  const dbPath = join(homeDir, 'deep.sqlite');
  const db = openDeepIndexDb({ dbPath });
  const prepare = (options?: Readonly<{ includeArchivedSessions?: boolean; signal?: AbortSignal }>) => syncMemoryDocuments({ credentials, machineId,
    scope: memory ? { type: 'session', sessionId: 'remote-session' } : { type: 'global' },
    includeArchivedSessions: options?.includeArchivedSessions ?? false, signal: options?.signal, db, assertCurrent: () => {} });
  try {
    const scope = await prepare();
    expect(scope.state).toBe('ready');
    await run({ scope, db, dbPath, prepare, serverId, artifactId: artifact.id, credentials,
      setArtifactState: state => { artifactState = state; },
      setCurrentnessStatus: status => { currentnessStatus = status; },
      setSessionDetailUnavailable: unavailable => { sessionDetailUnavailable = unavailable; },
      setInventoryState: state => { inventoryState = state; },
      setSessionCount: count => { sessionCount = count; },
      setSessionSharedContentUnavailable: unavailable => { sessionSharedContentUnavailable = unavailable; },
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

it('admits global documents from the fresh paginated Session records without a second detail transport', async () => {
  await withCurrentDocumentFixture(async ({ prepare, db, setSessionDetailUnavailable, setInventoryState }) => {
    setSessionDetailUnavailable(true);
    setInventoryState('paged');
    const scope = await prepare();
    expect(scope.state).toBe('ready');
    expect(db.searchDocuments({ query: 'quartz', eligibleDocuments: scope.eligibleDocuments, maxResults: 10 }))
      .toHaveLength(1);
  }, 'daemon-machine');
});

it.each([false, true])('admits readable owner context independently of unavailable shared Session content (scoped=%s)', async memory => {
  await withCurrentDocumentFixture(async ({ prepare, db, setSessionSharedContentUnavailable, credentials }) => {
    setSessionSharedContentUnavailable(true);
    const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
    const { tryDecryptSessionOwnerMetadata, tryDecryptSessionOwnerMetadataView } = await import('@/session/transport/encryption/sessionEncryptionContext');
    const session = await fetchSessionById({ token: credentials.token, sessionId: 'remote-session' });
    expect(session).not.toBeNull();
    if (!session) throw new Error('Missing fixture Session');
    const input = { credentials, accountEncryptionMode: 'plain' as const, rawSession: session };
    expect(tryDecryptSessionOwnerMetadata(input)).not.toBeNull();
    expect(tryDecryptSessionOwnerMetadataView(input)).toBeNull();
    const scope = await prepare();
    expect(scope.state).toBe('ready');
    expect(db.searchDocuments({ query: memory ? 'Topic-only' : 'quartz', eligibleDocuments: scope.eligibleDocuments, maxResults: 10 }))
      .toHaveLength(1);
    if (memory && scope.state === 'ready') expect(scope.preparation?.[0]?.loadedFactIds).toEqual(['key']);
  }, 'daemon-machine', memory);
});

it.each(['incomplete', 'unreadable'] as const)('retains prior documents without publishing %s Session inventory as complete coverage', async state => {
  await withCurrentDocumentFixture(async ({ prepare, db, scope, setInventoryState }) => {
    const { logger } = await import('@/ui/logger');
    const diagnostic = vi.spyOn(logger, 'infoFile');
    setInventoryState(state);
    expect((await prepare()).state).not.toBe('ready');
    expect(db.searchDocuments({ query: 'quartz', eligibleDocuments: scope.eligibleDocuments, maxResults: 10 })).toHaveLength(1);
    if (state === 'unreadable') expect(diagnostic).toHaveBeenCalledWith('[memoryDocuments] Admission failed',
      expect.objectContaining({ sessionId: 'remote-session', errorCode: 'session_owner_metadata_unavailable', cancelled: false }));
  });
});

it('refreshes shared prompt membership once per fresh global admission, independently of Session count', async () => {
  await withCurrentDocumentFixture(async ({ prepare, setSessionCount }) => {
    setSessionCount(4);
    const requests = () => vi.mocked(axios.get).mock.calls.filter(([url]) =>
      new URL(String(url)).pathname === '/v1/account/entity-rows/prompt-library').length;
    const before = requests();
    expect((await prepare()).state).toBe('ready');
    // Every admission is fresh, while its Sessions share that admitted Account inventory.
    expect(requests() - before).toBe(1);
  });
});

it('admits archived Session records only when requested and retains the index on cancellation', async () => {
  await withCurrentDocumentFixture(async ({ prepare, db, setInventoryState, setSessionDetailUnavailable }) => {
    setInventoryState('archived');
    setSessionDetailUnavailable(true);
    const archived = await prepare({ includeArchivedSessions: true });
    expect(archived.state).toBe('ready');
    const search = () => db.searchDocuments({ query: 'quartz', eligibleDocuments: archived.eligibleDocuments, maxResults: 10 });
    expect(search()).toHaveLength(1);
    const controller = new AbortController();
    const reason = new Error('Search cancelled');
    controller.abort(reason);
    await expect(prepare({ signal: controller.signal })).rejects.toBe(reason);
    expect(search()).toHaveLength(1);
    expect(await prepare()).toMatchObject({ state: 'ready', eligibleDocuments: [] });
    expect(search()).toHaveLength(0);
  });
});

it('reuses daemon Account observation across idle memory inventory admissions and refuses disconnect or a pushed mode change', async () => {
  await withCurrentDocumentFixture(async ({ credentials, prepare, scope }) => {
    expect(scope.state).toBe('ready');
    const { createRequesterCurrentnessSocketHarness } = await import('@/testkit/backends/requesterCurrentnessSocketHarness');
    const channel = await createRequesterCurrentnessSocketHarness();
    const { ApiMachineClient } = await import('@/api/apiMachine');
    const machineTransport = await import('@/api/machine/connection/createMachineSocketTransport');
    const { createSocketTransportAdapter } = await import('@happier-dev/sync-client');
    const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
    const machineSocket = createApiSessionSocketStub();
    vi.spyOn(machineTransport, 'createMachineSocketTransport').mockImplementation(() => ({
      // The main Machine network is a boundary stub; its transport/supervisor and the user Socket.IO channel stay real.
      socket: machineSocket as unknown as ReturnType<typeof machineTransport.createMachineSocketTransport>['socket'],
      transport: createSocketTransportAdapter(machineSocket),
    }));
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'fixture-home' } } })));
    const client = new ApiMachineClient(credentials.token, { id: 'daemon-machine', encryptionMode: 'plain',
      encryptionKey: null, encryptionVariant: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const counts = () => vi.mocked(axios.get).mock.calls.reduce((total, [url]) => {
      const path = new URL(String(url)).pathname;
      return total + Number(path === '/v1/account/encryption' || path === '/v1/account/encryption/currentness');
    }, 0);
    try {
      const foreign = new ApiMachineClient(`header.${Buffer.from(JSON.stringify({ sub: 'other-account' })).toString('base64url')}.signature`,
        { id: 'foreign-machine', encryptionMode: 'plain', encryptionKey: null, encryptionVariant: 'plain',
          metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
      try {
        await expect(foreign.resolvePluginResourceSessionAccess({ accountId: 'other-account', sessionId: 'remote-session',
          signal: new AbortController().signal })).rejects.toThrow();
        expect(channel.clients).toHaveLength(0);
      } finally { await foreign.shutdown(); }
      // Real Machine identity admission authenticates the Profile before owning the observation.
      const beforeAdmission = counts();
      client.connect();
      await vi.waitFor(() => expect(channel.clients).toHaveLength(1));
      const { fetchAccountEncryptionCurrentness } = await import('@/api/client/connectedServiceCredentialApi');
      await fetchAccountEncryptionCurrentness({ token: credentials.token });
      expect(counts() - beforeAdmission).toBe(1);
      const initial = counts();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      for (let tick = 0; tick < 12; tick++) {
        await vi.advanceTimersByTimeAsync(50_000);
        expect((await prepare()).state).toBe('ready');
      }
      expect(counts() - initial).toBe(0);
      expect(channel.clients).toHaveLength(1);
      vi.useRealTimers();
      await channel.disconnect();
      expect((await prepare()).state).not.toBe('ready');
      await channel.reconnect();
      expect((await prepare()).state).toBe('ready');
      await channel.push('account', { mode: 'e2ee', version: 2, updatedAt: 2,
        signingKeyFingerprint: 'changed-signing', contentKeyFingerprint: 'changed-content' });
      expect((await prepare()).state).not.toBe('ready');
    } finally {
      vi.useRealTimers();
      await client.shutdown();
      expect(channel.clients.every(socket => !socket.connected)).toBe(true);
      await channel.close();
    }
  });
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

it.each([503, 404])('keeps transient initial observation recoverable while retaining legacy HTTP for a missing endpoint (%s)', async status => {
  await withCurrentDocumentFixture(async ({ credentials, setCurrentnessStatus }) => {
    const { createRequesterCurrentnessSocketHarness } = await import('@/testkit/backends/requesterCurrentnessSocketHarness');
    const channel = await createRequesterCurrentnessSocketHarness();
    const { ApiMachineClient } = await import('@/api/apiMachine');
    const { ApiClient } = await import('@/api/api');
    const client = new ApiMachineClient(credentials.token, { id: 'daemon-machine', encryptionMode: 'plain',
      encryptionKey: null, encryptionVariant: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    try {
      setCurrentnessStatus(status);
      await client.resolvePluginResourceSessionAccess({ accountId: 'account', sessionId: 'remote-session', signal: new AbortController().signal });
      setCurrentnessStatus(200);
      const initial = vi.mocked(axios.get).mock.calls.length;
      const api = await ApiClient.create(credentials);
      expect(await api.getAccountEncryptionMode({ refresh: true })).toBe('plain');
      expect(await api.getAccountEncryptionMode({ refresh: true })).toBe('plain');
      const paths = vi.mocked(axios.get).mock.calls.slice(initial).map(([url]) => new URL(String(url)).pathname);
      expect(paths).toEqual(status === 404 ? ['/v1/account/encryption', '/v1/account/encryption'] : ['/v1/account/encryption/currentness']);
    } finally { await client.shutdown(); await channel.close(); }
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
