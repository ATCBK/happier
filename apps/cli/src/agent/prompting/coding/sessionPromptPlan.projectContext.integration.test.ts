import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1, readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import type { SessionRolePromptContextV1 } from '@happier-dev/protocol/prompts/roles/renderSessionRoleBlockV1';
import type { DaemonAgentRuntimeTurnContributionsBridge } from '@/agent/runtime/session/process/agentRuntimeDaemonTurnContributionsBridge';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import type { NativeAgentRuntimeSessionFixtureParams as HostSessionRuntimeFactoryParams } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';

const serverId = 'context-home';
const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'context-account' })).toString('base64url')}.signature`, encryption: null };
let taskHome: string;
let peer: Server;
let sourceAvailable = true;
let sourceLinked: boolean;
let sessionEntryIds: string[];
let memoryEnabled: boolean;
let documents: ReturnType<typeof storedDocument>[];
let onArtifactRead: (() => void) | undefined;
let artifactReadAvailable: boolean;
let admittedRoute: string;
let catalogReads: number;
let catalogReadAvailable: boolean;
let selectedProfileId: string | null;
let automaticAssetsUnavailable: boolean;
let notices: unknown[];
let createSessionPromptPlanResolver: typeof import('./sessionPromptPlan').createSessionPromptPlanResolver;

function entry(id: string): PromptStackEntryV1 {
  return { id, ref: { kind: 'doc', artifactId: id }, enabled: true, required: true, placement: 'system_append' };
}

function storedDocument(id: string, markdown = `CONTEXT_${id.toUpperCase()}`, revision = 1) {
  return { id, ownerAccountId: 'context-account', access: 'owner', encryptionMode: 'plain',
    header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: id }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }) }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: revision, bodyVersion: revision, seq: revision, createdAt: 1, updatedAt: revision,
  };
}

// The daemon IPC endpoint is a genuine boundary; this peer selects no plugin additions.
const daemonBridge: DaemonAgentRuntimeTurnContributionsBridge = {
  resolvePrompt: async () => {
    const { AgentRuntimeDaemonTurnContributionsResultV1Schema } = await import('@/agent/runtime/session/process/agentRuntimeRunnerProtocol');
    const received = AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({ kind: 'prompt',
      promptAssetBlocks: [], toolPromptContributions: [],
      ...(automaticAssetsUnavailable ? { optionalPromptAssetsUnavailable: true } : {}),
    });
    if (received.kind !== 'prompt') throw new Error('Unexpected IPC result kind');
    return received;
  },
  resolveAgentComposition: async () => { throw new Error('Unexpected composition request'); },
  resolveComposerReference: async () => { throw new Error('Unexpected reference request'); },
  resolveComposerAttachment: async () => { throw new Error('Unexpected attachment request'); },
  afterComposerAttachmentMessageAccepted: async () => { throw new Error('Unexpected attachment acceptance'); },
  transformAgentContext: async () => { throw new Error('Unexpected context transform'); },
  transformSessionInput: async () => { throw new Error('Unexpected input transform'); },
  transformAgentRequest: async () => { throw new Error('Unexpected request transform'); },
};

beforeEach(async () => {
  vi.resetModules();
  sourceAvailable = true;
  sourceLinked = true;
  sessionEntryIds = ['session'];
  memoryEnabled = true;
  onArtifactRead = undefined;
  artifactReadAvailable = true;
  catalogReads = 0;
  catalogReadAvailable = false;
  selectedProfileId = 'focused';
  automaticAssetsUnavailable = false;
  notices = [];
  taskHome = await createTempDir('happier-project-context-plan-');
  vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
  for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_SERVER_ID', 'HAPPIER_WEBAPP_URL']) vi.stubEnv(key, '');
  const workspace = { id: 'checkout', serverId, machineId: 'context-machine', rootPath: '/tmp/project', createdAtMs: 1,
    projectKey: 'project', get source() { return sourceLinked ? { sourceId: 'source', revision: 1 } : undefined; } };
  const workspaceKey = { kind: 'workspace-ref', serverId, id: workspace.id };
  const organizationKey = { kind: 'project-organization', serverId, projectKey: 'project' };
  const rows = [
    { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: workspace } } },
    { key: organizationKey, revision: 1, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: [entry('personal')] } } } },
  ];
  const source = { id: 'source', revision: 2, name: 'Current Source', createdByAccountId: 'context-account', audience: [],
    repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git', visibility: 'public' }, protocol: 'https' },
    attachments: [{ purpose: 'context', entry: entry('source') }],
  };
  documents = ['account', 'profile', 'worker_profile', 'source', 'personal', 'session'].map(id => storedDocument(id));
  peer = createServer((request, response) => {
    const requestedPath = new URL(request.url ?? '/', 'http://localhost').pathname;
    const admitted = requestedPath.startsWith('/admitted/');
    const path = admitted ? requestedPath.slice('/admitted'.length) : requestedPath;
    let status = 200;
    let data: unknown;
    if (request.headers.authorization !== `Bearer ${credentials.token}`) { status = 401; data = { error: 'wrong_account' }; }
    else if (path === '/v1/account/encryption') data = { mode: 'plain', updatedAt: 1 };
    else if (path === '/v1/account/project-rows/list') data = { status: 'listed', coverage: 'complete', rows };
    else if (path === '/v1/projects/sources/source') {
      status = sourceAvailable ? 200 : 503;
      data = sourceAvailable ? { ok: true, source, canManage: false } : { ok: false, error: 'source_backend_unavailable' };
    } else if (path === '/v1/artifacts') data = documents;
    else if (path.startsWith('/v1/artifacts/')) {
      onArtifactRead?.();
      const id = decodeURIComponent(path.slice('/v1/artifacts/'.length));
      data = documents.find(document => document.id === id);
      if (!data) { status = 404; data = { error: 'artifact_not_found' }; }
      if (!artifactReadAvailable && !admitted) { status = 503; data = { error: 'artifact_backend_unavailable' }; }
    } else if (path === '/v1/account/encryption/currentness') {
      data = { mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1 };
    } else if (path === '/v1/account/entity-rows/prompt-library') {
      catalogReads += 1;
      status = catalogReadAvailable ? 200 : 503;
      data = catalogReadAvailable ? { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key,
        revision: 1, content: { t: 'plain', v: key === 'coding'
          ? { key, value: { v: 1, scope: { kind: 'coding' }, entries: [entry('account')] } }
          : emptyPromptLibraryRecordV1(key) } })) } : { error: 'unexpected_catalog_refresh' };
    } else if (path === '/v2/account/settings') {
      data = { content: { t: 'plain', v: {} }, version: 1 };
    } else if (path === '/v2/account/settings/history') {
      data = { snapshots: [] };
    } else if (path === '/v1/account/entity-rows/profiles/transfer') {
      data = { status: 'absent' };
    } else { status = 404; data = { error: 'unexpected_route' }; }
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  const address = peer.address();
  if (!address || typeof address === 'string') throw new Error('HTTP peer has no address');
  const url = `http://127.0.0.1:${address.port}`;
  admittedRoute = `${url}/admitted`;
  await writeFile(join(taskHome, 'settings.json'), JSON.stringify({ schemaVersion: 6, activeServerId: serverId,
    servers: { [serverId]: { id: serverId, name: serverId, serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1, lastUsedAt: 1 } },
  }));
  // Load the real producer after establishing its Home, before the measured
  // preparation itself. Module loading is not an Artifact preparation fact.
  ({ createSessionPromptPlanResolver } = await import('./sessionPromptPlan'));
});

afterEach(async () => {
  const account = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  account.resetActiveAccountSettingsSnapshotForTests();
  const projects = await import('@/workspaces/projectAccountRows');
  projects.withdrawActiveProjectAccountRowsSnapshot();
  peer.closeAllConnections();
  await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()));
  vi.unstubAllEnvs();
  await removeTempDir(taskHome);
});

async function resolver(withAccount: boolean, withProject: boolean, worker = false,
  operationContext?: SavedSecretOperationContextV1, observeAccountLibrary = true, rawAccountSettings: Record<string, unknown> = {}) {
  const { setActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
  const settings = accountSettingsParse(rawAccountSettings);
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  if (withAccount) setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: rawAccountSettings, scopeKey,
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    promptLibraryCatalog: observeAccountLibrary ? { status: 'ready', rows: [{ revision: 1, record: PromptLibraryRecordV1Schema.parse({
      key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [entry('account')] },
    }) }], tombstones: [], diagnostics: [] } : { status: 'unavailable', reason: 'unreachable' },
    profileCatalog: { status: 'ready', authority: 'active', source: 'destination', diagnostics: [], referenceGuardRevision: 1,
      control: null, controlRevision: 'absent', records: [{ revision: 1, record: ProfileRecordV1Schema.parse({
        v: 1, id: 'focused', enabled: true, promptStack: [entry('profile')], secretBindings: {},
        definition: { kind: 'inline', profile: { v: 2, id: 'focused', name: 'Focused', createdAt: 1, updatedAt: 1 } },
      }) }, { revision: 1, record: ProfileRecordV1Schema.parse({
        v: 1, id: 'worker-profile', enabled: true, promptStack: [entry('worker_profile')], secretBindings: {},
        definition: { kind: 'inline', profile: { v: 2, id: 'worker-profile', name: 'Worker', createdAt: 1, updatedAt: 1 } },
      }) }],
    },
  });
  return createSessionPromptPlanResolver({
    opts: { credentials, ...(withAccount ? { accountSettingsContext: { source: 'network' as const, settings, scopeKey,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null } } : {}) },
    session: { sessionId: 'context-session', enqueueSessionEventCommitted: async event => {
      notices.push(event); return { persisted: true, delivered: false };
    },
      getMetadataSnapshot: () => createTestMetadata({
      ...(withAccount && selectedProfileId ? { profileId: worker ? 'worker-profile' : selectedProfileId } : {}),
      ...(withProject ? { workspaceId: 'checkout', projectId: 'project' } : {}),
      ...(worker ? { reportsTo: { sessionId: 'lead' } } : {}),
      work: { memoryEnabled, promptStack: worker ? [] : sessionEntryIds.map(entry) },
    }) },
    agentId: 'codex', machineId: 'context-machine', directory: '/tmp/project', serverId, memoryRecallGuidanceEnabled: false,
    readNativeSessionId: () => 'native', daemonBridge,
    ...(operationContext ? { readOperationContext: () => operationContext } : {}),
    resolveRoleContext: async () => ({ role: { roleId: 'context-role', name: 'Context role', instructions: 'CONTEXT_ROLE',
      engine: { agentTargetKey: 'agent:codex', modelId: 'test-model' }, runsAs: { kind: 'session' },
      workspaceWrites: 'allow', secondOpinion: 'off', enabled: true }, notes: 'CONTEXT_NOTES' } satisfies SessionRolePromptContextV1),
  });
}

it('prepares Account → Profile → current Source Project → Session before Role and Notes', async () => {
  const prepare = await resolver(true, true);
  const text = await prepare({ baseOverride: 'CONTEXT_BASE' });
  const markers = ['BASE', 'ACCOUNT', 'PROFILE', 'SOURCE', 'SESSION', 'ROLE', 'NOTES'];
  const positions = markers.map(marker => text.indexOf(`CONTEXT_${marker}`));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
  expect(text).not.toContain('CONTEXT_PERSONAL');
});

it('prepares personal Project context when the current association has no Source', async () => {
  sourceLinked = false;
  const prepare = await resolver(true, true);
  const result = await prepare({ baseOverride: 'CONTEXT_BASE', includeAdmittedInventory: true });
  expect(result.text).toContain('CONTEXT_PERSONAL');
  expect(result.text).not.toContain('CONTEXT_SOURCE');
  expect(result.admittedEntries.filter(item => item.layer === 'project')).toMatchObject([
    { entryId: 'personal', ref: { artifactId: 'personal', serverId }, outcome: 'ready' },
  ]);
});

it('publishes current admitted inventory with its text from the same preparation', async () => {
  const prepare = await resolver(true, true);
  const options = { baseOverride: 'CONTEXT_BASE', includeAdmittedInventory: true as const };
  const first = await prepare(options);
  expect(first).toMatchObject({ text: expect.stringContaining('CONTEXT_SESSION'), admittedEntries: [
    { entryId: 'account', layer: 'account', ref: { artifactId: 'account', serverId }, revision: { headerVersion: 1, bodyVersion: 1 }, outcome: 'ready' },
    { entryId: 'profile', layer: 'profile', ref: { artifactId: 'profile', serverId }, revision: { headerVersion: 1, bodyVersion: 1 }, outcome: 'ready' },
    { entryId: 'source', layer: 'project', ref: { artifactId: 'source', serverId }, revision: { headerVersion: 1, bodyVersion: 1 }, outcome: 'ready' },
    { entryId: 'session', layer: 'session', scope: { serverId, accountId: 'context-account', sessionId: 'context-session', projectKey: 'project', profileId: 'focused' },
      ref: { artifactId: 'session', serverId }, revision: { headerVersion: 1, bodyVersion: 1 }, outcome: 'ready' },
  ] });

  // Membership comes from the current Session, not the prior rendered plan or
  // an Artifact inventory. Empty documents remain admitted for indexing.
  sessionEntryIds = ['current', 'empty'];
  documents.push(storedDocument('current', 'CONTEXT_CURRENT', 2), storedDocument('empty', '', 3));
  const second = await prepare(options);
  expect(second).toMatchObject({ text: expect.stringContaining('CONTEXT_CURRENT'), admittedEntries: [
    { entryId: 'account' }, { entryId: 'profile' }, { entryId: 'source' },
    { entryId: 'current', layer: 'session', ref: { artifactId: 'current', serverId }, revision: { headerVersion: 2, bodyVersion: 2 }, outcome: 'ready' },
    { entryId: 'empty', layer: 'session', ref: { artifactId: 'empty', serverId }, revision: { headerVersion: 3, bodyVersion: 3 }, outcome: 'valid-empty' },
  ] });
  expect(second).toHaveProperty('text', expect.not.stringContaining('CONTEXT_SESSION'));
});

it.each([true, false])('does not publish admitted inventory after the current Account retires with body availability %s', async (bodyAvailable) => {
  const prepare = await resolver(true, true);
  const { resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  onArtifactRead = resetActiveAccountSettingsSnapshotForTests;
  artifactReadAvailable = bodyAvailable;
  const options = { baseOverride: 'CONTEXT_BASE', includeAdmittedInventory: true as const };
  let failure: unknown;
  try { await prepare(options); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'context_source_unavailable' });
  expect(failure).not.toHaveProperty('admittedEntries');
  expect(prepare.readStartupInstructions?.()).toBeNull();
  expect(prepare.readCodingPromptBehavior?.()).toBeNull();
});

it('prepares a Session-only stack without an Account catalog', async () => {
  const prepare = await resolver(false, false);
  expect(await prepare({ baseOverride: 'CONTEXT_BASE' })).toContain('CONTEXT_SESSION');
});

it('reuses the admitted prompt route and observed catalog instead of the unavailable saved route', async () => {
  await resolver(true, false);
  const { getActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { createInvocationSavedSecretOperationContextV1 } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot) throw new Error('Account was not admitted');
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: admittedRoute, isCurrent: async () => true });
  const prepare = await resolver(true, false, false, operationContext);
  artifactReadAvailable = false;
  const started = performance.now();
  const result = await prepare({ baseOverride: 'CONTEXT_BASE', includeAdmittedInventory: true });
  console.info('SESSIONOPEN captured prompt preparation', { elapsedMs: performance.now() - started, catalogReads });
  expect(result.text).toContain('CONTEXT_ACCOUNT');
  expect(result.text).toContain('CONTEXT_PROFILE');
  expect(result.text).toContain('CONTEXT_SESSION');
  expect(result.admittedEntries.every(item => item.outcome === 'ready')).toBe(true);
  expect(catalogReads).toBe(0);
});

it('keeps admitted prompt facts when the same Account catalog changes during a document read', async () => {
  catalogReadAvailable = true;
  await resolver(true, false);
  const { getActiveAccountSettingsSnapshot, commitActivePromptLibraryCatalog,
    getActiveAccountSettingsSnapshotLifetimeToken } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { createInvocationSavedSecretOperationContextV1 } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot?.scopeKey) throw new Error('Account was not admitted');
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: admittedRoute, isCurrent: async () => true });
  const prepare = await resolver(true, false, false, operationContext);
  onArtifactRead = () => {
    onArtifactRead = undefined;
    commitActivePromptLibraryCatalog({ scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
  };
  expect(await prepare({ baseOverride: 'CONTEXT_BASE' })).toContain('CONTEXT_ACCOUNT');
  expect(prepare.readCodingPromptBehavior?.()).not.toBeNull();
  expect(prepare.readComposition?.()).not.toBeNull();
  expect(prepare.readStartupInstructions?.()?.instructions).toContain('CONTEXT_ACCOUNT');
});

async function retireAdmittedPromptAccount() {
  const { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot?.scopeKey) throw new Error('Account was not admitted');
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: resolveAccountSettingsScopeKey({ token: 'replacement-account', encryption: null }) });
}

it('keeps a ready-empty plan current without a native startup instruction marker', async () => {
  const prepare = createSessionPromptPlanResolver({
    opts: { credentials }, session: { sessionId: 'empty-plan-session',
      getMetadataSnapshot: () => createTestMetadata(),
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false }) },
    agentId: 'empty-plan-fixture', machineId: 'context-machine', directory: '/tmp/project', serverId,
    memoryRecallGuidanceEnabled: false, readNativeSessionId: () => null, daemonBridge,
  });
  expect(await prepare({ baseOverride: null })).toBe('');
  expect(prepare.readStartupInstructions?.()).toBeNull();
  expect(() => prepare.assertPreparedPlanCurrent?.()).not.toThrow();
  expect(prepare.readCodingPromptBehavior?.()).not.toBeNull();
});

it('refuses native open when the prepared Account lifetime retires during open attestation', async () => {
  const prepare = await resolver(true, false);
  const { createNativeAgentRuntimeSessionPlanFixture: createNativeAgentRuntimeSessionPlan } = await import('@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit');
  const { createSessionHostServiceOwners } = await import('@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit');
  const { createAuthoredAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
  const { createPluginManifestV2Fixture } = await import('@/plugins/testkit/manifestV2Fixture');
  const { projectEngineRuntimeContributionFromAgent } = await import('@/agent/runtime/registry/engineRegistry/contributions');
  const { createMutableApiSessionClientFixture } = await import('@/testkit/backends/sessionFixtures');
  const { createProviderEnforcedPermissionHandler } = await import('@/agent/permissions/providerEnforced/createHandler');
  const { createCurrentSessionTranscriptPort } = await import('@/api/session/createCurrentSessionTranscriptPort');
  const { MessageBuffer } = await import('@/ui/ink/messageBuffer');
  const { buildPluginSessionBindingInput } = await import('@/plugins/runtime/runtimeCore/plugin/sessionLaunch');
  const { classifyPrimarySessionRuntimeIssue } = await import('@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue');
  const pluginId = 'acme.withdrawn-plan';
  const agentId = `${pluginId}/fixture`;
  const openedPath = join(taskHome, 'native-open.log');
  // This authored provider leaf records its actual I/O boundary. Host source
  // admission, runtime registration/currentness and Session construction remain real.
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    happyHomeDir: taskHome, runtimeOptions: { pluginIds: [pluginId] },
    plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { agents: [{
      id: 'fixture', title: 'Withdrawal fixture', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false,
        startupInstructions: { versions: [1], revisionChanges: 'resume' } } },
    }] } }), files: {
      'daemon.mjs': `import { createRuntime } from './runtime.mjs';
        export function activate(api) { api.agents.register('fixture', createRuntime, {
          sessionRunnerFactory: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 }
        }); }`,
      'runtime.mjs': `import { appendFile } from 'node:fs/promises';
        export async function createRuntime() { return { sessions: { async open() {
          await appendFile(${JSON.stringify(openedPath)}, 'opened\\n');
          return { getSessionId() { return 'native-session'; }, async send() { return { status: 'admitted' }; },
            watch() { return { dispose() {} }; }, async dispose() {} };
        } } }; }`,
    } }],
  });
  const generation = new AbortController();
  try {
    const lease = fixture.registry.agentRuntimesByAgentId.get(agentId);
    const agent = fixture.registry.contributes.agentDefinitionsById.get(agentId);
    if (!lease?.hasPrimaryRuntime || !agent) {
      throw new Error(`Expected current authored Agent admission: ${JSON.stringify(fixture.registry.pluginDiagnosticsByPluginId[pluginId] ?? [])}`);
    }
    const plan = await createNativeAgentRuntimeSessionPlan({
      runtime: await lease.createRuntime({ signal: generation.signal }), lease, agent,
      backend: projectEngineRuntimeContributionFromAgent(agent, agentId), generationSignal: generation.signal,
      createSessionHostServiceOwners,
      attestSessionOpen: async ({ phase }) => { if (phase === 'prepare') await retireAdmittedPromptAccount(); },
      sessionInput: buildPluginSessionBindingInput({ credentials, directory: '/tmp/project' }),
    });
    if (!plan.config.createSessionRuntime) throw new Error('Expected native Session construction');
    const session = createMutableApiSessionClientFixture({ sessionId: 'context-session', metadata: createTestMetadata() });
    const params: HostSessionRuntimeFactoryParams = {
      directory: '/tmp/project', metadata: session.getMetadataSnapshot()!, machineId: 'context-machine',
      agentTargetKey: `agent:${agentId}`, session, transcriptSession: createCurrentSessionTranscriptPort(() => session),
      messageBuffer: new MessageBuffer(), mcpServers: {},
      permissionHandler: createProviderEnforcedPermissionHandler({ session, logPrefix: '[Fixture]' }),
      getPermissionMode: () => 'default', runnerProcessIdentity: null, startupModelSelection: null,
      runWithTerminalModelSelection: async () => { throw new Error('Nonterminal fixture requested terminal admission'); },
      memoryRecallGuidanceEnabled: false, resolveFreshSessionSystemPrompt: prepare,
    };
    let failure: unknown;
    try {
      const created = await plan.config.createSessionRuntime(params);
      await created.operations.resetOrDisposeRuntime('session_closed');
    } catch (error) { failure = error; }
    // Native sanitization retains the code; the classifier owns its pending projection.
    expect(failure).toMatchObject({ code: 'context_source_unavailable' });
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure }))
      .toMatchObject({ code: 'preparation_pending' });
    await expect(stat(openedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    generation.abort();
    await fixture.dispose();
  }
});

it('continues with required Session context and publishes a typed notice when optional Account library is unobserved', async () => {
  selectedProfileId = null;
  const prepare = await resolver(true, false, false, undefined, false);
  const result = await prepare({ baseOverride: 'CONTEXT_BASE', includeAdmittedInventory: true });
  expect(result.text).toContain('CONTEXT_SESSION');
  expect(result.text).not.toContain('CONTEXT_ACCOUNT');
  expect(notices.map(readSessionCapabilityNoticeV1)).toEqual([{ v: 1, items: [
    { kind: 'prompt_library', name: 'Prompt library', code: 'prompt_library_unavailable' },
  ] }]);
  await prepare({ baseOverride: 'CONTEXT_BASE' });
  expect(notices).toHaveLength(1);
  artifactReadAvailable = false;
  await expect(prepare({ baseOverride: 'CONTEXT_BASE' })).rejects.toMatchObject({ code: 'preparation_pending' });
  expect(notices).toHaveLength(1);
});

it.each([false, true])('prepares the first captured Account catalog without borrowing the saved route (catalog ready: %s)', async catalogReady => {
  selectedProfileId = null;
  catalogReadAvailable = catalogReady;
  await resolver(true, false, false, undefined, false);
  const { getActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { createInvocationSavedSecretOperationContextV1 } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot?.scopeKey) throw new Error('Account was not admitted');
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: admittedRoute, isCurrent: async () => true });
  const prepare = await resolver(true, false, false, operationContext, false);
  artifactReadAvailable = false;
  const result = await prepare({ baseOverride: 'CONTEXT_BASE' });
  expect(result).toContain('CONTEXT_SESSION');
  if (catalogReady) expect(result).toContain('CONTEXT_ACCOUNT');
  else expect(result).not.toContain('CONTEXT_ACCOUNT');
  expect(prepare.readCodingPromptBehavior?.()).not.toBeNull();
  expect(() => prepare.assertPreparedPlanCurrent?.()).not.toThrow();
  expect(notices.map(readSessionCapabilityNoticeV1)).toEqual(catalogReady ? [] : [{ v: 1, items: [
    { kind: 'prompt_library', name: 'Prompt library', code: 'prompt_library_unavailable' },
  ] }]);
});

it('keeps selected Profile context required when optional Account library is unobserved', async () => {
  const prepare = await resolver(true, false, false, undefined, false);
  const result = await prepare({ baseOverride: 'CONTEXT_BASE' });
  expect(result).toContain('CONTEXT_PROFILE');
  expect(result).toContain('CONTEXT_SESSION');
  expect(result).not.toContain('CONTEXT_ACCOUNT');
  expect(notices.map(readSessionCapabilityNoticeV1)).toHaveLength(1);
  artifactReadAvailable = false;
  await expect(prepare({ baseOverride: 'CONTEXT_BASE' })).rejects.toMatchObject({ code: 'preparation_pending' });
  expect(notices).toHaveLength(1);
});

it('does not omit a known required Account attachment or publish optional notice on its unavailable read', async () => {
  selectedProfileId = null;
  sessionEntryIds = [];
  const prepare = await resolver(true, false);
  artifactReadAvailable = false;
  await expect(prepare({ baseOverride: 'CONTEXT_BASE' })).rejects.toMatchObject({ code: 'preparation_pending' });
  expect(notices).toEqual([]);
});

it('does not discard a known required retained Account entry when its catalog is unobserved', async () => {
  selectedProfileId = null;
  sessionEntryIds = [];
  const prepare = await resolver(true, false, false, undefined, false, {
    promptStacksV1: { v: 1, surfaces: { coding: [entry('account')], voice: [], profilesById: {} } },
  });
  await expect(prepare({ baseOverride: 'CONTEXT_BASE' })).rejects.toMatchObject({ code: 'context_source_unavailable' });
  expect(notices).toEqual([]);
});

it('retains requiredness of a previously observed Account row until a ready selection confirms its deletion', async () => {
  selectedProfileId = null;
  sessionEntryIds = [];
  const prepare = await resolver(true, false);
  expect(await prepare({ baseOverride: 'CONTEXT_BASE' })).toContain('CONTEXT_ACCOUNT');
  const { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
    commitActivePromptLibraryCatalog } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot?.scopeKey) throw new Error('Account was not admitted');
  const incumbent = { scopeKey: snapshot.scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
  commitActivePromptLibraryCatalog({ ...incumbent, catalog: { status: 'unavailable', reason: 'unreachable' } });
  await expect(prepare({ baseOverride: 'CONTEXT_BASE' })).rejects.toMatchObject({ code: 'context_source_unavailable' });
  expect(notices).toEqual([]);
  commitActivePromptLibraryCatalog({ ...incumbent, catalog: { status: 'ready', rows: [],
    tombstones: [{ key: 'coding', revision: 2 }], diagnostics: [] } });
  expect(await prepare({ baseOverride: 'CONTEXT_BASE' })).not.toContain('CONTEXT_ACCOUNT');
  commitActivePromptLibraryCatalog({ ...incumbent, catalog: { status: 'unavailable', reason: 'unreachable' } });
  expect(await prepare({ baseOverride: 'CONTEXT_BASE' })).not.toContain('CONTEXT_ACCOUNT');
  expect(notices.map(readSessionCapabilityNoticeV1)).toHaveLength(1);
});

it('uses current Protocol Memory-off eligibility instead of demanding a remembered required memory attachment', async () => {
  selectedProfileId = null;
  sessionEntryIds = [];
  memoryEnabled = false;
  documents = documents.map(document => document.id === 'account' ? { ...document,
    header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Account memory' }),
  } : document);
  const prepare = await resolver(true, false);
  expect(await prepare({ baseOverride: 'CONTEXT_BASE' })).not.toContain('CONTEXT_ACCOUNT');
  const { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
    commitActivePromptLibraryCatalog } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot?.scopeKey) throw new Error('Account was not admitted');
  commitActivePromptLibraryCatalog({ scopeKey: snapshot.scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
    catalog: { status: 'unavailable', reason: 'unreachable' } });
  expect(await prepare({ baseOverride: 'CONTEXT_BASE' })).not.toContain('CONTEXT_ACCOUNT');
  expect(notices.map(readSessionCapabilityNoticeV1)).toHaveLength(1);
});

it('consumes the strict daemon optional augmentation fact as one visible notice after required preparation succeeds', async () => {
  automaticAssetsUnavailable = true;
  const prepare = await resolver(false, false);
  const result = await prepare({ baseOverride: 'CONTEXT_BASE' });
  expect(result).toContain('CONTEXT_SESSION');
  expect(notices.map(readSessionCapabilityNoticeV1)).toEqual([{ v: 1, items: [
    { kind: 'prompt_library', name: 'Prompt library', code: 'prompt_library_unavailable' },
  ] }]);
  expect(prepare.readStartupInstructions?.()).toMatchObject({ instructions: expect.stringContaining('CONTEXT_SESSION') });
  expect(prepare.readCodingPromptBehavior?.()).not.toBeNull();
  expect(prepare.readComposition?.()).not.toBeNull();
  await prepare({ baseOverride: 'CONTEXT_BASE' });
  expect(notices).toHaveLength(1);
  artifactReadAvailable = false;
  await expect(prepare({ baseOverride: 'CONTEXT_BASE' })).rejects.toMatchObject({ code: 'preparation_pending' });
  expect(notices).toHaveLength(1);
  expect(prepare.readStartupInstructions?.()).toBeNull();
  expect(prepare.readCodingPromptBehavior?.()).toBeNull();
  expect(prepare.readComposition?.()).toBeNull();
});

it('measures the removed repeat catalog read against the real captured Account preparation', async () => {
  await resolver(true, false);
  const { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { createInvocationSavedSecretOperationContextV1 } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
  const { createCliPromptLibraryStore } = await import('@/settings/prompts/promptLibraryStore');
  const { prepareActivePromptLibraryRecord } = await import('@/settings/prompts/hydratePromptLibraryCatalog');
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot?.scopeKey) throw new Error('Account was not admitted');
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: admittedRoute, isCurrent: async () => true });
  catalogReadAvailable = true;
  const baselineStarted = performance.now();
  // The former captured-demand branch read this incumbent store even when its
  // selected record was already observed. Measure that exact real boundary.
  const baseline = await createCliPromptLibraryStore({ credentials, operationContext }).readPromptLibraryCatalog();
  const baselineMs = performance.now() - baselineStarted;
  const baselineCatalogReads = catalogReads;
  const preparedStarted = performance.now();
  const record = await prepareActivePromptLibraryRecord({ credentials, operationContext, scopeKey: snapshot.scopeKey,
    lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), key: 'coding' });
  console.info('SESSIONOPEN ready catalog preparation comparison', { baselineMs,
    preparedMs: performance.now() - preparedStarted, baselineCatalogReads, preparedCatalogReads: catalogReads - baselineCatalogReads });
  expect(record.status).toBe('ready');
  expect(readPromptLibraryCatalogRecordV1({ catalog: baseline, key: 'coding', rawSettings: snapshot.rawSettings }).status).toBe('ready');
  expect(baselineCatalogReads).toBeGreaterThan(0);
  expect(catalogReads - baselineCatalogReads).toBe(0);
});

it('prepares a worker from its selected Profile and Account/Project context without the lead Session layer', async () => {
  const prepare = await resolver(true, true, true);
  const text = await prepare({ baseOverride: 'CONTEXT_BASE' });
  const positions = ['ACCOUNT', 'WORKER_PROFILE', 'SOURCE', 'ROLE', 'NOTES']
    .map(marker => text.indexOf(`CONTEXT_${marker}`));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
  expect(text).not.toContain('CONTEXT_SESSION');
  expect(text).not.toContain('CONTEXT_PROFILE');
  expect(text).not.toContain('CONTEXT_PERSONAL');
});

it('keeps unavailable current Source context pending rather than publishing the personal subset', async () => {
  sourceAvailable = false;
  const prepare = await resolver(true, true);
  await expect(prepare({ baseOverride: 'CONTEXT_BASE' })).rejects.toMatchObject({
    code: 'preparation_pending', reason: 'project_source_unavailable',
  });
  expect(prepare.readStartupInstructions?.()).toBeNull();
});
