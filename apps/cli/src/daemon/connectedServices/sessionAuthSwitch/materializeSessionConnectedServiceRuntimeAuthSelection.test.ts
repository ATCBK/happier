import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { accountSettingsParse, buildConnectedServiceCredentialRecord, type ConnectedServiceBindingsV2, QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));

import type { ApiClient } from '@/api/api';
import type { TrackedSession } from '@/daemon/types';
import type { Credentials, StoredCredentials } from '@/persistence';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { materializeSessionConnectedServiceRuntimeAuthSelection } from './materializeSessionConnectedServiceRuntimeAuthSelection';
import { resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { materializeExactV021ConnectedServiceCredential } from '../compatibility/exactV021ConnectedServiceMaterialization';
import { resolveConnectedServiceHomeDir } from '../homes/resolveConnectedServiceHomeDir';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveConnectedServiceNativeHomeTarget } from '../materialize/resolveConnectedServiceNativeHomeTarget';
import { projectConnectedServiceRuntimeAuthTargetInput } from '../runtimeAuth/projectRuntimeAuthTargetInput';
import { validateConnectedServiceGroupMutationCurrentness } from '../accountGroups/generation/validateGroupMutationCurrentness';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

function qualifiedApiForRecord(record: ReturnType<typeof buildConnectedServiceCredentialRecord>) {
  const service = resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId(record.serviceId);
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
    ref: { service, accountId: record.profileId },
    authenticationModeId: record.kind === 'oauth' ? 'oauth' : 'api-key',
    revisionSemantics: 'revisioned', credentialRevision: CREDENTIAL_REVISION,
    configurationRevision: null, content: { t: 'plain', v: record }, metadata: { scopes: [] },
  }) });
  return {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getConnectedServiceCredentialPlain: vi.fn(async () => { throw new Error('V2 credential read forbidden'); }),
    getConnectedServiceCredentialSealed: vi.fn(async () => { throw new Error('V2 credential read forbidden'); }),
  };
}

const CREDENTIAL_REVISION = 'csr_0123456789ABCDEFGHJKMNPQRS';
const CODEX_SERVICE_KEY = 'happier.agent.codex/openai-codex';
const ANTHROPIC_SERVICE_KEY = 'happier.agent.claude/anthropic';
const CLAUDE_SUBSCRIPTION_SERVICE_KEY = 'happier.agent.claude/claude-subscription';

let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
let materializationRecord: ReturnType<typeof buildConnectedServiceCredentialRecord>;
const unexpectedAccountBoundary = async (): Promise<never> => { throw new Error('Unexpected account inventory I/O'); };
const purposeOwner = createConnectedAccountPurposeBindingOwner({
  store: { read: unexpectedAccountBoundary, update: unexpectedAccountBoundary, subscribe: () => ({ dispose() {} }) },
  selectTarget: unexpectedAccountBoundary,
  projectTargetAccounts: unexpectedAccountBoundary,
  assertTargetAccountMaterializable: unexpectedAccountBoundary,
  // The boundary fixture supplies account metadata; all binding and plugin serialization stays real.
  resolveTarget: async target => target.kind === 'account'
    ? { displayName: target.account.accountId, account: target.account }
    : { displayName: target.groupId, account: { service: target.service, accountId: 'backup' },
      group: { groupId: target.groupId, generation: 3 } },
  materializeAccount: async input => await materializeExactV021ConnectedServiceCredential({
    registry: runtimeFixture.registry, serviceId: materializationRecord.serviceId, account: input.account,
    record: materializationRecord, request: input.request, signal: input.signal,
  }),
});

beforeAll(async () => {
  runtimeFixture = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex', 'happier.agent.claude'], connectedAccounts: purposeOwner },
  });
});
afterAll(async () => await runtimeFixture?.dispose());

describe('materializeSessionConnectedServiceRuntimeAuthSelection', () => {
  afterEach(() => { vi.restoreAllMocks(); io.mockReset(); });
  it.each([true, false])('keeps Claude resume state through two auth applications only with native-account authority (%s)', async (allowNativeAccountState) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-auth-apply-resume-'));
    const sessionId = 'auth-apply-resume';
    try {
      materializationRecord = buildConnectedServiceCredentialRecord({
        now: 1_000, serviceId: 'claude-subscription', profileId: 'backup', kind: 'oauth',
        oauth: { accessToken: 'refreshed-fixture-access', refreshToken: 'fixture-refresh', idToken: null,
          providerAccountId: 'fixture-account', providerEmail: null, scope: null, tokenType: null },
      });
      const api = qualifiedApiForRecord(materializationRecord);
      const activeServerDir = join(root, 'server');
      const nativeRoot = join(root, 'native');
      const home = join(resolveConnectedServiceHomeDir({ activeServerDir,
        serviceId: 'claude-subscription', profileId: 'backup', agentId: 'claude' }), 'claude-config');
      const transcriptPath = join(home, 'projects', '-tmp', 'resume.jsonl');
      await mkdir(join(nativeRoot, 'projects', '-tmp'), { recursive: true });
      await writeFile(join(nativeRoot, 'projects', '-tmp', 'resume.jsonl'), '{"sessionId":"resume"}\n');
      await mkdir(home, { recursive: true });
      await symlink(join(nativeRoot, 'projects'), join(home, 'projects'), 'junction');
      await writeFile(join(home, '.happier-state-sharing.json'), JSON.stringify({
        v: 1, requestedStateMode: 'shared', effectiveStateMode: 'shared', lastSyncAtMs: 0,
        configEntries: [], stateEntries: ['projects'], resumeStateEntries: ['projects'],
        sessionFileMappings: [], diagnostics: [],
      }));
      const bindings: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {
        [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'backup' },
      } };
      const selection = { source: 'connected' as const, selection: 'profile' as const,
        serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY, profileId: 'backup', groupId: null };
      const params = {
        credentials: { token: 'fixture-token', encryption: null } satisfies StoredCredentials,
        api: api as unknown as ApiClient, activeServerDir, baseDir: join(root, 'materialized'),
        connectedAccountsOwner: purposeOwner, activatePurposeBindings: purposeOwner.activatePurposeBindings,
        processEnv: { CLAUDE_CONFIG_DIR: nativeRoot }, allowNativeAccountState,
        accountSettings: accountSettingsParse({ connectedServicesProviderStateSharingSettingsV1: {
          v: 1 as const, defaults: { configMode: 'isolated' as const, stateMode: 'shared' as const },
          byAgentId: {}, acknowledgedRisksByAgentId: {},
        } }),
        input: { mode: 'apply' as const, sessionId, agentId: 'claude', serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY,
          tracked: { startedBy: 'daemon' as const, happySessionId: sessionId, pid: 123 },
          previous: selection, next: selection, previousBindings: bindings, normalizedBindings: bindings },
      };
      for (let application = 0; application < 2; application += 1) {
        await materializeSessionConnectedServiceRuntimeAuthSelection(params);
        if (allowNativeAccountState) {
          await expect(readFile(transcriptPath, 'utf8')).resolves.toContain('resume');
          expect((await lstat(join(home, 'projects'))).isSymbolicLink()).toBe(true);
        } else {
          await expect(readFile(transcriptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        }
        await expect(readFile(join(home, '.credentials.json'), 'utf8')).resolves.toContain('refreshed-fixture-access');
      }
      await expect(readFile(join(nativeRoot, 'projects', '-tmp', 'resume.jsonl'), 'utf8')).resolves.toContain('resume');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves a newer pool projection through materializer, projector, and delayed native apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-runtime-selection-group-proof-'));
    const sessionId = 'c1234567890123456789012345';
    try {
      const service = resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId('openai-codex');
      materializationRecord = buildConnectedServiceCredentialRecord({
        now: 1_000, serviceId: 'openai-codex', profileId: 'backup', kind: 'oauth',
        oauth: { accessToken: 'candidate-b-access', refreshToken: 'candidate-b-refresh', idToken: 'candidate-b-id',
          providerAccountId: 'provider-b', providerEmail: null, scope: null, tokenType: null },
      });
      const api = qualifiedApiForRecord(materializationRecord);
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v4/connect/qualified/credential') return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
          ref: { service, accountId: 'backup' }, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
          credentialRevision: CREDENTIAL_REVISION, configurationRevision: null,
          content: { t: 'plain', v: materializationRecord }, metadata: { scopes: [] },
        }) };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
          id: sessionId, encryptionMode: 'plain', metadata: '{}', dataEncryptionKey: null,
        }) } };
        throw new Error(`Unexpected HTTP path: ${path}`);
      });
      const credentials = { token: 'token', encryption: null } satisfies StoredCredentials;
      const validateCurrent = (input: Parameters<typeof validateConnectedServiceGroupMutationCurrentness>[0]['input']) =>
        validateConnectedServiceGroupMutationCurrentness({
          input, credentials, api: api as unknown as ApiClient,
          // Group API is the boundary; use the real currentness owner beneath it.
          readGroup: async () => ({ activeConnectedAccountId: 'backup', generation: 3 }),
        });
      const bindings: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {
        [CODEX_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'backup' },
      } };
      const selected = await materializeSessionConnectedServiceRuntimeAuthSelection({
        credentials, api: api as unknown as ApiClient, activeServerDir: join(root, 'server'),
        baseDir: join(root, 'materialized'), connectedAccountsOwner: purposeOwner,
        activatePurposeBindings: purposeOwner.activatePurposeBindings,
        validateGroupMutationCurrentness: validateCurrent, processEnv: {},
        input: { mode: 'apply', tracked: { startedBy: 'daemon', happySessionId: sessionId, pid: 123 },
          sessionId, agentId: 'codex', serviceId: CODEX_SERVICE_KEY, previous: null,
          next: { source: 'connected', selection: 'group', serviceId: CODEX_SERVICE_KEY, groupId: 'pool', profileId: 'backup' },
          groupMetadata: { groupId: 'pool', activeProfileId: 'backup', fallbackProfileId: 'backup', generation: 3 },
          previousBindings: bindings, normalizedBindings: bindings,
        },
      });
      const request = projectConnectedServiceRuntimeAuthTargetInput({
        agentId: 'codex', materializedSelection: selected,
        fallbackSelection: { kind: 'group', serviceId: CODEX_SERVICE_KEY, groupId: 'pool', activeProfileId: 'backup', generation: 3 },
        validateCurrentBeforeMutation: () => validateCurrent({
          serviceId: CODEX_SERVICE_KEY, groupId: 'pool', profileId: 'backup', generation: 3, credentialRevision: CREDENTIAL_REVISION,
        }),
      });
      if (!selected || typeof selected !== 'object' || !('targetMaterializedRoot' in selected)
        || typeof selected.targetMaterializedRoot !== 'string') throw new Error('Missing prepared pool home');
      const authPath = join(selected.targetMaterializedRoot, 'auth.json');
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toMatchObject({ tokens: { account_id: 'provider-b' } });
      let nativeApplyEntered!: () => void;
      let finishNativeApply!: () => void;
      const entered = new Promise<void>(resolve => { nativeApplyEntered = resolve; });
      const settle = new Promise<void>(resolve => { finishNativeApply = resolve; });
      // Only HTTP and Socket.IO are substituted; materialization, projection,
      // authorization, native codec, transport normalization, and files are real.
      bindApiSessionSocketMock(io, createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        expect(payload).toMatchObject({ method: `${sessionId}:session.connectedServiceAuth.applyGeneration` });
        nativeApplyEntered();
        await settle;
        return { ok: true, result: { ok: true, appliedVia: 'direct_live_hot_auth', activeAccountId: 'provider-b' } };
      } }));
      const entry = await runtimeFixture.registry.acquireAgentCatalogEntry!('codex');
      const adapter = await entry!.getConnectedServiceRuntimeAuthAdapter!();
      const pending = adapter!.hotApply(request);
      await entered;
      const newerAuth = JSON.stringify({ auth_mode: 'chatgptAuthTokens', tokens: {
        access_token: 'newer-c-access', refresh_token: '', id_token: 'newer-c-id', account_id: 'provider-c',
      }, last_refresh: '2026-06-06T13:15:00.000Z' });
      await writeFile(authPath, newerAuth);
      finishNativeApply();
      const result = await pending;
      expect(await readFile(authPath, 'utf8')).toBe(newerAuth);
      expect(result).toMatchObject({ applied: false, reason: 'provider_account_auth_store_mismatch' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([
    { mode: 'apply', resume: false },
    { mode: 'apply', resume: true },
    { mode: 'preflight', resume: true },
  ] as const)('prepares selected B auth and only requested state in $mode mode with resume=$resume without mutating A', async ({ mode, resume }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-runtime-selection-preparation-'));
    try {
      const activeServerDir = join(root, 'server');
      const priorHome = join(resolveConnectedServiceHomeDir({
        activeServerDir, serviceId: CODEX_SERVICE_KEY, profileId: 'account-a', agentId: 'codex',
      }), 'codex-home');
      const targetHome = join(resolveConnectedServiceHomeDir({
        activeServerDir, serviceId: CODEX_SERVICE_KEY, profileId: 'account-b', agentId: 'codex',
      }), 'codex-home');
      const vendorResumeId = '11111111-2222-4333-8444-555555555555';
      const rolloutName = `rollout-2026-10-12T10-00-00-${vendorResumeId}.jsonl`;
      const retainedState = JSON.stringify({ type: 'session_meta', payload: { id: vendorResumeId, cwd: '/project' } }) + '\n';
      await mkdir(join(priorHome, 'sessions'), { recursive: true });
      await writeFile(join(priorHome, 'sessions', rolloutName), retainedState);
      await writeFile(join(priorHome, 'sessions', 'unrelated-session.jsonl'), 'unrelated-private-state');
      await writeFile(join(priorHome, 'auth.json'), 'account-a-native-auth');
      materializationRecord = buildConnectedServiceCredentialRecord({
        now: 1_000, serviceId: 'openai-codex', profileId: 'account-b', kind: 'oauth',
        oauth: { accessToken: 'account-b-access', refreshToken: 'account-b-refresh', idToken: 'account-b-id',
          scope: null, tokenType: null, providerAccountId: 'provider-account-b', providerEmail: null },
      });
      const api = qualifiedApiForRecord(materializationRecord);
      const previousBindings: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {
        [CODEX_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'account-a' },
      } };
      const normalizedBindings: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {
        [CODEX_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'account-b' },
      } };
      const result = await materializeSessionConnectedServiceRuntimeAuthSelection({
        credentials: { token: 'token', encryption: null }, api: api as unknown as ApiClient,
        activeServerDir, baseDir: join(root, 'materialized'), connectedAccountsOwner: purposeOwner,
        activatePurposeBindings: purposeOwner.activatePurposeBindings,
        processEnv: {}, accountSettings: accountSettingsParse({ connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } }),
        input: {
          mode, tracked: { startedBy: 'daemon', happySessionId: 'retained-session', pid: 123, spawnOptions: {
            directory: '/project',
            runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer', home: 'connectedService', homePath: priorHome } },
          }, ...(resume ? { vendorResumeId } : {}) },
          sessionId: 'retained-session', agentId: 'codex', serviceId: CODEX_SERVICE_KEY,
          previous: { source: 'connected', selection: 'profile', serviceId: CODEX_SERVICE_KEY, profileId: 'account-a', groupId: null },
          next: { source: 'connected', selection: 'profile', serviceId: CODEX_SERVICE_KEY, profileId: 'account-b', groupId: null },
          previousBindings, normalizedBindings,
        },
      });
      expect(result).toMatchObject({ targetMaterializedRoot: targetHome, targetMaterializedEnv: { CODEX_HOME: targetHome } });
      if (mode === 'apply') {
        if (resume) {
          expect(await readFile(join(targetHome, 'sessions', rolloutName), 'utf8')).toBe(retainedState);
        } else {
          await expect(readFile(join(targetHome, 'sessions', rolloutName))).rejects.toMatchObject({ code: 'ENOENT' });
        }
        expect(JSON.parse(await readFile(join(targetHome, 'auth.json'), 'utf8'))).toMatchObject({
          auth_mode: 'chatgptAuthTokens', tokens: { access_token: 'account-b-access', refresh_token: '', account_id: 'provider-account-b' },
        });
      } else {
        await expect(readFile(join(targetHome, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(join(targetHome, 'sessions', rolloutName))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(readFile(join(targetHome, 'sessions', 'unrelated-session.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(priorHome, 'auth.json'), 'utf8')).toBe('account-a-native-auth');
      expect(await readFile(join(priorHome, 'sessions', rolloutName), 'utf8')).toBe(retainedState);
      expect(await readFile(join(priorHome, 'sessions', 'unrelated-session.jsonl'), 'utf8')).toBe('unrelated-private-state');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('withholds a requester credential when admission is lost during its authenticated read', async () => {
    let current = true;
    const bindings: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {
      [CODEX_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'bob' },
    } };
    const record = buildConnectedServiceCredentialRecord({ now: 1_000, serviceId: 'openai-codex',
      profileId: 'bob', kind: 'oauth', oauth: { accessToken: 'bob-access', refreshToken: 'bob-refresh', idToken: null, scope: null, tokenType: null, providerAccountId: null, providerEmail: null } });
    const api = qualifiedApiForRecord(record);
    vi.spyOn(axios, 'get').mockImplementation(async () => {
      current = false;
      return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'bob' },
        authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: CREDENTIAL_REVISION,
        configurationRevision: null, content: { t: 'plain', v: { v: 1, values: {
          accessToken: 'bob-access', refreshToken: 'bob-refresh',
        } } }, metadata: { scopes: [] },
      }) };
    });
    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials: { token: 'bob-token', encryption: null }, api: api as unknown as ApiClient,
      isCurrent: async () => current,
      input: { mode: 'apply', tracked: { startedBy: 'daemon', happySessionId: 'bob-session', pid: 123 },
        sessionId: 'bob-session', agentId: 'codex', serviceId: CODEX_SERVICE_KEY,
        previous: null, next: { source: 'connected', selection: 'profile', serviceId: CODEX_SERVICE_KEY, profileId: 'bob', groupId: null },
        previousBindings: bindings, normalizedBindings: bindings,
      },
    })).rejects.toThrow('requester_session_not_current');
  });

  it('prepares the exact qualified credential revision for restart without a legacy native record', async () => {
    const serviceId = 'acme.plugin/novel-service';
    const bindings: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {
      [serviceId]: { source: 'connected', selection: 'profile', profileId: 'work' },
    } };
    const tracked: TrackedSession = { startedBy: 'daemon', happySessionId: 'qualified-session', pid: 123,
      spawnOptions: { directory: '/tmp/project', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, connectedServices: bindings },
    };
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      expect(new URL(String(url)).pathname).toBe('/v4/connect/qualified/credential');
      return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: { service: { pluginId: 'acme.plugin', localId: 'novel-service' }, accountId: 'work' },
        authenticationModeId: 'personal-oauth', revisionSemantics: 'revisioned', credentialRevision: CREDENTIAL_REVISION,
        configurationRevision: null, content: { t: 'plain', v: { v: 1, values: { accessToken: 'selected', refreshToken: 'selected-refresh' } } }, metadata: { scopes: [], providerIdentity: { accountId: 'same-user', organizationId: 'selected-org' } },
      }) };
    });
    const result = await materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials: { token: 'token', encryption: null },
      api: { getAccountEncryptionMode: async () => 'plain' } as unknown as ApiClient,
      input: { mode: 'apply', tracked, sessionId: 'qualified-session', agentId: 'codex', serviceId,
        previous: { source: 'connected', selection: 'profile', serviceId, profileId: 'work', groupId: null },
        next: { source: 'connected', selection: 'profile', serviceId, profileId: 'work', groupId: null },
        previousBindings: bindings, normalizedBindings: bindings,
      },
    });
    expect(result).toMatchObject({ serviceId, profileId: 'work', credentialRevision: CREDENTIAL_REVISION,
      sourceProviderAccountId: 'same-user', sourceProviderOrganizationId: 'selected-org' });
    expect(projectConnectedServiceRuntimeAuthTargetInput({ agentId: 'codex', materializedSelection: result, fallbackSelection: {} }).selection)
      .toMatchObject({ sourceProviderAccountId: 'same-user', sourceProviderOrganizationId: 'selected-org' });
    expect(result).not.toHaveProperty('credential');
  });

  it.each(['device', 'oauth', 'manual'])('preserves the exact native credential contract for %s mode', async (authenticationModeId) => {
    const credentialRevision = CREDENTIAL_REVISION;
    const bindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [CODEX_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
      },
    };
    const tracked = {
      startedBy: 'daemon',
      happySessionId: 'sess_revision',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: bindings,
        environmentVariables: {},
      },
    } as TrackedSession;
    const credential = { v: 1 as const, values: { accessToken: 'access', refreshToken: 'refresh', providerAccountId: 'acct-work' } };
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      expect(new URL(String(url)).pathname).toBe('/v4/connect/qualified/credential');
      return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
        authenticationModeId, revisionSemantics: 'revisioned', credentialRevision,
        configurationRevision: null, content: { t: 'plain', v: credential }, metadata: { scopes: [], providerIdentity: { accountId: 'same-user', organizationId: 'selected-org' } },
      }) };
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => { throw new Error('V2 credential read forbidden'); }),
      getConnectedServiceCredentialSealed: vi.fn(async () => { throw new Error('V2 credential read forbidden'); }),
    };

    const credentials = {
      token: 'token',
      encryption: null,
    } satisfies StoredCredentials;

    const pendingSelection = materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_revision',
        agentId: 'codex',
        serviceId: CODEX_SERVICE_KEY,
        previous: { source: 'connected', selection: 'profile', serviceId: CODEX_SERVICE_KEY, profileId: 'work', groupId: null },
        next: { source: 'connected', selection: 'profile', serviceId: CODEX_SERVICE_KEY, profileId: 'work', groupId: null },
        previousBindings: bindings,
        normalizedBindings: bindings,
      },
    });

    if (authenticationModeId === 'manual') {
      await expect(pendingSelection).rejects.toThrow('authentication mode has no native credential projection');
      return;
    }
    const selection = await pendingSelection;
    expect(selection).toMatchObject({ credential: {
      kind: 'oauth', serviceId: 'openai-codex', profileId: 'work',
      oauth: { accessToken: 'access', refreshToken: 'refresh', raw: {
        happierQualifiedConnectedAccountCredentialV1: {
          authenticationModeId, payload: credential,
        },
      } },
    }, credentialRevision });
    expect(selection).not.toHaveProperty('targetMaterializedRoot');
  });

  it('preserves group fallback profile and generation from the current session selection env', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'backup',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = qualifiedApiForRecord(record);
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: previousBindings,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            {
              kind: 'group',
              serviceId: ANTHROPIC_SERVICE_KEY,
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'fallback',
              generation: 7,
            },
          ]),
        },
      },
    };

    const normalizedBindings = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'backup' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: ANTHROPIC_SERVICE_KEY,
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
      },
    })).resolves.toMatchObject({
      serviceId: ANTHROPIC_SERVICE_KEY,
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 7,
      credential: expect.objectContaining({ serviceId: record.serviceId, profileId: record.profileId, kind: record.kind }),
    });
  });

  it('uses group metadata active profile when the normalized group binding omits optional profileId', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'backup',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = qualifiedApiForRecord(record);
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: previousBindings,
        environmentVariables: {},
      },
    };
    const normalizedBindings = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: ANTHROPIC_SERVICE_KEY,
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: null,
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 8,
        },
      },
    })).resolves.toMatchObject({
      serviceId: ANTHROPIC_SERVICE_KEY,
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 8,
      credential: expect.objectContaining({ serviceId: record.serviceId, profileId: record.profileId, kind: record.kind }),
    });
    expect(api.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
  });

  it('uses the previous child group active profile when unchanged group rematerialization omits profileId', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = qualifiedApiForRecord(record);
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: previousBindings,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            {
              kind: 'group',
              serviceId: ANTHROPIC_SERVICE_KEY,
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'fallback',
              generation: 7,
            },
          ]),
        },
      },
    };
    const normalizedBindings = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: ANTHROPIC_SERVICE_KEY,
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: null,
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: null,
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
      },
    })).resolves.toMatchObject({
      serviceId: ANTHROPIC_SERVICE_KEY,
      profileId: 'primary',
      groupId: 'work',
      activeProfileId: 'primary',
      fallbackProfileId: 'fallback',
      generation: 7,
      credential: expect.objectContaining({ serviceId: record.serviceId, profileId: record.profileId, kind: record.kind }),
    });
  });

  it('prefers authoritative group metadata over stale current session selection env', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'backup',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = qualifiedApiForRecord(record);
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: previousBindings,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            {
              kind: 'group',
              serviceId: ANTHROPIC_SERVICE_KEY,
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'stale-fallback',
              generation: 7,
            },
          ]),
        },
      },
    };
    const normalizedBindings = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'backup' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: ANTHROPIC_SERVICE_KEY,
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fresh-fallback',
          generation: 8,
        },
      },
    })).resolves.toMatchObject({
      serviceId: ANTHROPIC_SERVICE_KEY,
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fresh-fallback',
      generation: 8,
      credential: expect.objectContaining({ serviceId: record.serviceId, profileId: record.profileId, kind: record.kind }),
    });
  });

  it('preflights the canonical Claude group target without native writes or ambient auth propagation', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const api = qualifiedApiForRecord(record);
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'primary',
        },
      },
    };
    const normalizedBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'backup',
        },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: previousBindings,
        environmentVariables: {
          CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token-must-not-propagate',
          CLAUDE_CODE_SETUP_TOKEN: 'ambient-setup-must-not-propagate',
        },
      },
    };

    const root = await mkdtemp(join(tmpdir(), 'happier-preflight-group-selection-'));
    const activeServerDir = join(root, 'server');
    const params = {
      credentials,
      api: api as unknown as ApiClient,
      activeServerDir,
      connectedAccountsOwner: purposeOwner,
      activatePurposeBindings: purposeOwner.activatePurposeBindings,
      input: {
        mode: 'preflight',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY,
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY,
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY,
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 3,
        },
      },
      accountSettings: null,
      processEnv: {
        CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token-must-not-propagate',
        CLAUDE_CODE_SETUP_TOKEN: 'ambient-setup-must-not-propagate',
      },
    } satisfies Parameters<typeof materializeSessionConnectedServiceRuntimeAuthSelection>[0] & {
      activeServerDir?: string;
    };

    const incumbentSnapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'claude',
      contributions: runtimeFixture.registry.contributes, bindings: { v: 2, bindingsByServiceId: {
        [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'incumbent' },
      } } })!;
    const incumbentLease = purposeOwner.activateSessionPurposeBindings({ sessionId: 'sess_1',
      purposes: incumbentSnapshot.purposes, bindings: incumbentSnapshot.bindings });
    try {
      const result = await materializeSessionConnectedServiceRuntimeAuthSelection(params);
      const selectedSnapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'claude',
        contributions: runtimeFixture.registry.contributes, bindings: normalizedBindings })!;
      const entry = await runtimeFixture.registry.acquireAgentCatalogEntry!('claude');
      const nativeHome = (await entry!.getConnectedServiceStateSharingDescriptor!())!.nativeHome!;
      const expectedTarget = resolveConnectedServiceNativeHomeTarget({ agentId: 'claude', activeServerDir,
        nativeHome, snapshot: selectedSnapshot });
      expect(result).toMatchObject({
        serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY,
        profileId: 'backup',
        groupId: 'work',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 3,
        credential: expect.objectContaining({ serviceId: record.serviceId, profileId: record.profileId, kind: record.kind }),
        targetMaterializedRoot: expectedTarget,
        targetMaterializedEnv: { [nativeHome.environmentKey]: expectedTarget },
      });
      await expect(readFile(join(expectedTarget!, '.credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(incumbentLease.isCurrent()).toBe(true);
      const scope = incumbentSnapshot.fileMaterializationPurposes![0]!;
      await expect(purposeOwner.getBinding({ ...scope, sessionId: 'sess_1', signal: new AbortController().signal }))
        .resolves.toMatchObject({ account: { accountId: 'incumbent' } });
      expect(normalizedBindings.bindingsByServiceId[CLAUDE_SUBSCRIPTION_SERVICE_KEY]).toEqual({
        source: 'connected', selection: 'group', groupId: 'work', profileId: 'backup',
      });
    } finally {
      incumbentLease.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
