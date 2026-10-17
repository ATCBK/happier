import axios from 'axios';
import fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createProviderAccountUsagePersistenceScheduler, flushProviderAccountUsagePersistenceForTrackedSessions } from '../connectedServices/accountUsage/persistence';
import { fetchConnectedServiceProjectionForSession } from '../connectedServices/accountGroups/generation/connectedServiceProjectionSnapshot';
import { registerExecutionRunConnectedServicesTarget } from '../connectedServices/runs/executionRunMaterialization';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { admitRequesterSessionBootstrap, assertRequesterSessionAccountContextCurrent } from './requesterSessionCredentials';
import { createRequesterSessionRuntimeContext } from './createRequesterSessionRuntimeContext';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import type { TrackedSession } from '../types';
import { createPendingResetStartRecoveryPorts } from '../connectedServices/usageLimitRecovery/createPendingResetStartRecoveryPorts';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import * as controlServer from '../controlServer';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { projectRunnerDaemonPluginServicesFailure } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
beforeEach(async () => { channel = await createRequesterCurrentnessSocketHarness(); });
afterEach(async () => { await channel.close(); });
it.each(['refresh', 'untracked-lifetime', 'profile-unavailable', 'action-policy', 'warm-account', 'refresh-observations'] as const)('keeps requester %s isolated from active Alice', async (surface) => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-profiles-'));
  let current = true;
  let revision = 2;
  let holdRows = false;
  let releaseRows: (() => void) | undefined;
  let settingsVersion = 1;
  let settingsReads = 0;
  let sessionReads = 0;
  let connectedCatalogReads = 0;
  let holdSettings = false;
  let failSettings = false;
  let releaseSettings: (() => void) | undefined;
  let savedSettings: Record<string, unknown> = {};
  const requesterToken = surface === 'action-policy'
    ? `e30.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`
    : 'bob';
  const control: { routes?: Parameters<typeof controlServer.startDaemonControlServer>[0] } = {};
  // The loopback HTTP server is the boundary; retain the real startup Action factory.
  const controlBoundary = surface === 'action-policy' ? vi.spyOn(controlServer, 'startDaemonControlServer')
    .mockImplementation(async input => { control.routes = input; return { port: 43127, stop: async () => {} }; }) : null;
  const approvalIds: string[] = [];
  const artifactBoundary = surface === 'action-policy' ? vi.spyOn(axios, 'post').mockImplementation(async (url, data, config) => {
    const mintPath = bindExternalActionExecutionAuthorizationHttpPathV1('workflow.authoring.draft.discard');
    const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1('workflow.authoring.draft.discard');
    if (url === `https://bob-home.test${verifyPath}`) return { status: 200, data: { ok: true } };
    expect(config?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
    if (url === `https://bob-home.test${mintPath}`) {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(data);
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-home-proof', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
        serverIdentityId: 'bob-home', machineId: 'machine', custodianAccountId: 'alice',
        installationId: request.sessionActionSource?.installationId, actionId: 'workflow.authoring.draft.discard',
        requestId: request.envelope.requestId, target: request.envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } }) };
    }
    expect(url).toBe('https://bob-home.test/v1/artifacts');
    const id: unknown = data?.id;
    if (typeof id !== 'string') throw new Error('Missing Artifact identity');
    approvalIds.push(id);
    return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
  }) : null;
  const profileReads: string[] = [];
  const record = ProfileRecordV1Schema.parse({ v: 1, id: 'bob-profile', enabled: true, promptStack: [], secretBindings: {},
    definition: { kind: 'legacy', profile: { id: 'bob-profile', name: 'Bob native', createdAt: 1, updatedAt: 2 } } });
  const aliceCredentials = { token: surface === 'action-policy'
    ? `e30.${Buffer.from(JSON.stringify({ sub: 'alice', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`
    : 'alice', encryption: null };
  await runWithServerHttpBaseUrl('https://alice-home.test', async () => {
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(aliceCredentials) });
  });
  const alice = getActiveAccountSettingsSnapshot();
  // HTTP and admitted Machine access are the boundaries. Both Account custody
  // owners, the full Profile pager and requester runtime stay real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
    const path = new URL(url).pathname;
    if (path === '/v2/sessions/bob-session') sessionReads++;
    if (path.startsWith('/v4/connect/')) connectedCatalogReads++;
    if (path === '/v2/account/settings') {
      settingsReads++;
      if (failSettings) throw new axios.AxiosError('Settings transport unavailable', 'ECONNRESET');
      if (holdSettings) await new Promise<void>(resolve => { releaseSettings = resolve; });
    }
    const profilePath = path.startsWith('/v1/account/entity-rows/profiles');
    if (profilePath) {
      expect(config?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
      expect(new URL(url).origin).toBe('https://bob-home.test');
      profileReads.push(path);
      if (surface === 'profile-unavailable') return { status: 404, data: { error: 'not_found' } };
    }
    if (path.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
    if (path === '/v2/sessions/bob-session') return { status: 200, data: { session: createSessionRecordFixture({
      id: 'bob-session', encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }),
      dataEncryptionKey: null, share: null,
    }) } };
    if (path.endsWith('/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path.endsWith('/profiles/reference-guard')) return { status: 200, data: { status: 'ready', revision } };
    if (path.endsWith('/profiles/transfer')) return { status: 200, data: { status: 'absent' } };
    if (path.endsWith('/entity-rows/profiles')) {
      if (holdRows) await new Promise<void>(resolve => { releaseRows = resolve; });
      return { status: 200, data: { status: 'listed',
        rows: [{ id: record.id, revision, content: { t: 'plain', v: record } }], nextCursor: null, complete: true,
        diagnostics: [], referenceGuardRevision: revision, transferControl: { status: 'absent' } } };
    }
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    if (path === '/v4/connect/qualified/accounts') return { status: 200, data: {
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accounts: [] } };
    return { status: 200, data: { content: { t: 'plain', v: savedSettings }, version: settingsVersion } };
  });
  let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  try {
    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedSessions = new Map<number, TrackedSession>();
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
      credentials: aliceCredentials, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions, getRequester: () => runtime, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      ...(surface === 'action-policy' ? { startup: { resolveCurrentMachineExecutionOriginContext: async () => ({
        machineId: 'machine', serverIdentityId: 'bob-home',
      }) } } : {}) });
    const admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: requesterToken } },
      ...(surface === 'action-policy' || surface === 'refresh-observations' ? { existingSessionId: 'bob-session' } : {}),
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: host.installation?.installationId ?? 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current } });
    if (!admitted) throw new Error('Missing real requester admission');
    admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => current);
    // Admission captures the real settings/cache lifetime after daemon startup.
    expect(admitted.admitted.accountSettingsContext.scopeKey).toBe(resolveAccountSettingsScopeKey(admitted.admitted.credentials));
    runtime = await createRequesterSessionRuntimeContext({ bootstrap: admitted.admitted,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (!runtime) throw new Error('Missing real requester runtime');
    if (surface === 'refresh-observations') {
      // Exercise the real HTTP client and Home routes; only Home responses
      // and admitted Machine access are substituted. Internal Profile paging,
      // Saved Secret custody and the bound requester verifier remain real.
      const homeGet = get.getMockImplementation()!;
      get.mockRestore();
      const http = fastify();
      http.get('/*', async (request, reply) => {
        const response = await homeGet(new URL(request.url, 'https://bob-home.test').href,
          { headers: { Authorization: request.headers.authorization } });
        return reply.code(response.status).send(response.data);
      });
      await http.ready();
      const restoreHttp = installAxiosFastifyAdapter({ app: http, origin: 'https://bob-home.test' });
      try {
        // Entry and publication are distinct authority checkpoints. Repeat
        // the operation to rule out retaining a settled observation.
        for (let operation = 0; operation < 2; operation++) {
          const before = sessionReads;
          expect(await runtime.refreshAccountSettings()).toBe(true);
          expect(sessionReads - before).toBe(2);
        }
        let notifications = 0;
        const unsubscribe = runtime.subscribeAccountSettingsSnapshot(() => { notifications++; });
        try {
          holdRows = true;
          const refreshing = runtime.refreshAccountSettings();
          await vi.waitFor(() => expect(releaseRows).toBeDefined());
          current = false;
          holdRows = false;
          releaseRows?.();
          expect(await refreshing).toBe(false);
          expect(notifications).toBe(0);
          expect(await runtime.isCurrent()).toBe(false);
          expect(await runtime.refreshAccountSettings()).toBe(false);
        } finally { holdRows = false; releaseRows?.(); unsubscribe(); }
      } finally { restoreHttp(); await http.close(); }
      return;
    }
    if (surface === 'warm-account') {
      // A warm Settings fence must settle from its admitted publication. Park
      // only Home HTTP to distinguish it from a fresh requester admission.
      const homeGet = get.getMockImplementation()!;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let reads = 0;
      get.mockImplementation(async (...args) => { reads++; await held; return homeGet(...args); });
      const reader = new AbortController();
      try {
        const checking = admitted.admitted.ensureAccountSettingsCurrent(reader.signal);
        const result = await Promise.race([checking.then(current => ({ current })),
          new Promise<'network-wait'>(resolve => setImmediate(() => resolve('network-wait')))]);
        expect(result).toEqual({ current: true });
        expect(reads).toBe(0);
        // Separating Settings from admission must retain cancellation while
        // the distinct fresh authority read is outstanding.
        const admission = runtime.isCurrent(reader.signal);
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        reader.abort();
        expect(await Promise.race([admission.then(current => ({ current })),
          new Promise<'network-wait'>(resolve => setImmediate(() => resolve('network-wait')))]))
          .toEqual({ current: false });
        // The distinct authority guard still observes Machine access loss.
        release();
        current = false;
        expect(await admitted.admitted.isCurrent()).toBe(false);
      } finally { reader.abort(); release(); }
      return;
    }
    if (surface === 'action-policy') {
      await channel.pushSettings('bob', savedSettings, ++settingsVersion);
      await vi.waitFor(() => expect(runtime!.readAccountSettingsSnapshot().settingsVersion).toBe(settingsVersion));
      const service = control.routes?.agentRuntimeDaemonServices;
      if (!service) throw new Error('Missing real requester Action dispatcher');
      const retainedAgent = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'plugin.runner', pluginVersion: '1.0.0',
        agentId: 'claude', localAgentId: 'claude', sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-generation',
          installSource: 'localPath' }, locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/immutable/runtime.mjs', loadMode: 'immutable-js' });
      const witness = projectAgentRuntimeDaemonServiceTurnWitnessV1({ turnId: 'turn', inputId: 'input', userMessageSeq: 1,
        userMessageSeqs: [1], agentStartCaller: { kind: 'session', sessionId: 'bob-session', starterDepth: 0, turnDepth: 0 } });
      let invocation = 0;
      const invoke = async (callerSurface: 'agent' | 'mcp', signal?: AbortSignal) => {
        const result = await service.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
          context: { token: 'a'.repeat(43), sessionId: 'bob-session' }, operation: { kind: 'action.execute',
            requestId: `policy-${settingsVersion}-${callerSurface}-${++invocation}`, surface: callerSurface, witness,
            actionId: 'workflow.authoring.draft.discard', input: { scope: { serverId: 'bob-home', accountId: 'bob' }, draftId: 'absent' } },
        }), { sessionId: 'bob-session', retainedAgent, runner: { pid: process.pid, processStartTimeMs: 1,
          processCommandHash: 'a'.repeat(64), snapshotIdentity: 'fixture-runner' },
          invocationContext: { cwd: directory, environment: {}, providerBindingActive: false },
          ...(signal ? { signal } : {}), isCurrent: async () => current });
        if (!result.ok) return result;
        if (result.result.kind !== 'action.execution') throw new Error('Missing Action outcome');
        return result.result.outcome;
      };
      for (const callerSurface of ['agent', 'mcp'] as const) {
        const admittedReads = settingsReads;
        const admittedProfileReads = profileReads.length;
        const admittedConnectedReads = connectedCatalogReads;
        const outcome = await invoke(callerSurface);
        expect(settingsReads).toBe(admittedReads);
        expect(profileReads).toHaveLength(admittedProfileReads);
        expect(connectedCatalogReads).toBe(admittedConnectedReads);
        expect(outcome).toEqual({ ok: true, result: expect.objectContaining({ kind: 'approval_request_created' }) });
      }
      expect(approvalIds).toHaveLength(2);
      savedSettings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
        'workflow.authoring.draft.discard': ['agent', 'mcp'],
      } } };
      settingsVersion++;
      const readsBeforeEnvelope = settingsReads;
      await channel.pushSettings('bob', savedSettings, settingsVersion);
      for (const callerSurface of ['agent', 'mcp'] as const) {
        expect(await invoke(callerSurface)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      }
      expect(approvalIds).toHaveLength(2);
      expect(settingsReads).toBe(readsBeforeEnvelope);
      expect(runtime.readAccountSettingsSnapshot().settingsVersion).toBe(settingsVersion);
      savedSettings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
        'workflow.authoring.draft.discard': ['agent', 'mcp'],
      }, actions: {
        'workflow.authoring.draft.discard': { approvalRequiredSurfaces: ['agent', 'mcp'] },
      } } };
      settingsVersion++;
      await channel.hintSettings(settingsVersion);
      expect(await invoke('agent')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(approvalIds).toHaveLength(3);
      // An unrelated demanded Profile read must not hold policy admission.
      holdRows = true;
      const catalogRefresh = runtime.refreshAccountSettings();
      await vi.waitFor(() => expect(releaseRows).toBeDefined());
      expect(await invoke('agent')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      holdRows = false;
      releaseRows?.();
      expect(await catalogRefresh).toBe(true);
      expect(approvalIds).toHaveLength(4);
      // An explicit demand can recover a failed hint without a socket restart.
      failSettings = true;
      await channel.hintSettings(++settingsVersion);
      await expect(runtime.isCurrent()).rejects.toMatchObject({ code: 'project_requester_home_unavailable' });
      failSettings = false;
      expect(await runtime.refreshAccountSettings()).toBe(true);
      expect(runtime.readAccountSettingsSnapshot().settingsVersion).toBe(settingsVersion);
      // Cancelling one Action waiting for hinted policy does not cancel its Account publisher.
      holdSettings = true;
      settingsVersion++;
      await channel.hintSettings(settingsVersion);
      const cancellation = new AbortController();
      const cancelledAction = invoke('agent', cancellation.signal);
      await vi.waitFor(() => expect(releaseSettings).toBeDefined());
      cancellation.abort();
      expect(await cancelledAction).toMatchObject({ ok: false, errorCode: 'cancelled' });
      expect(approvalIds).toHaveLength(4);
      holdSettings = false;
      releaseSettings?.();
      releaseSettings = undefined;
      expect(await invoke('mcp')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(approvalIds).toHaveLength(5);
      // Retirement during a hinted settings refresh cannot republish private policy.
      holdSettings = true;
      settingsVersion++;
      await channel.hintSettings(settingsVersion);
      const pending = invoke('agent');
      await vi.waitFor(() => expect(releaseSettings).toBeDefined());
      await runtime.dispose();
      holdSettings = false;
      releaseSettings?.();
      expect(await pending).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      expect(approvalIds).toHaveLength(5);
      expect(() => runtime!.readAccountSettingsSnapshot()).toThrow('requester_account_context_unavailable');
      expect(getActiveAccountSettingsSnapshot()).toBe(alice);
      return;
    }
    if (surface === 'untracked-lifetime') {
      // This actual invocation-local Account runtime must be released on denial.
      const untracked = runtime;
      await expect(assertRequesterSessionAccountContextCurrent({ expected: null,
        resolveCurrent: async () => untracked, readTrackedContext: () => null }))
        .rejects.toThrow('requester_session_not_current');
      await expect(untracked.qualifiedConnectedAccountApi.listAccounts({
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      })).rejects.toThrow('requester_account_context_unavailable');
      return;
    }
    if (surface === 'profile-unavailable') {
      // The same requester freshness port admits launches without a Profile.
      // An unavailable Profile domain must remain typed and runtime-closed,
      // without changing successful Account Settings freshness into failure.
      expect(await runtime.refreshAccountSettings()).toBe(true);
      expect(runtime.readAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 1,
        profileCatalog: { status: 'unavailable', reason: 'unsupported' } });
      await expect(runtime.readAccountLaunchProfiles()).rejects.toMatchObject({ code: 'authoring_memory_unavailable' });
      expect(getActiveAccountSettingsSnapshot()).toBe(alice);
      return;
    }
    expect(await runtime.refreshAccountSettings()).toBe(true);
    expect(runtime.readAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 1,
      profileCatalog: { status: 'ready', source: 'destination', records: [{ record, revision: 2 }] } });
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
    revision = 3;
    expect(await runtime.refreshAccountSettings()).toBe(true);
    expect(runtime.readAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 1,
      profileCatalog: { status: 'ready', records: [{ revision: 3 }] } });
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
    expect(profileReads).toContain('/v1/account/entity-rows/profiles');
    holdRows = true;
    const retiredRead = runtime.refreshAccountSettings();
    await vi.waitFor(() => expect(releaseRows).toBeDefined());
    current = false;
    releaseRows?.();
    expect(await retiredRead).toBe(false);
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
  } finally {
    releaseRows?.();
    releaseSettings?.();
    try {
      await runtime?.dispose();
    } finally {
      try {
        await host?.dispose();
      } finally {
        get.mockRestore(); controlBoundary?.mockRestore(); artifactBoundary?.mockRestore(); resetActiveAccountSettingsSnapshotForTests();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

it.each(['generation', 'usage', 'reconnect', 'run_custody'] as const)('keeps requester %s effects under Bob Home and credentials without consuming Alice authority', async (surface) => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-usage-'));
  let current = true;
  // Account admission, encryption mode and durable usage writes are genuine HTTP boundaries.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => ({ status: 200,
    data: url.endsWith('/profile') ? { id: config?.headers?.Authorization === 'Bearer alice' ? 'alice' : 'bob',
      connectedServicesV2: [{ serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'connected' }],
        groups: [{ groupId: 'main', activeProfileId: 'work', generation: config?.headers?.Authorization === 'Bearer alice' ? 1 : 2,
          memberProfileIds: ['work'] }] }],
      connectedServiceCredentialRevisionsV1: [{ serviceId: 'openai-codex', profileId: 'work', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }] }
      : url.endsWith('/currentness')
      ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
      : url.endsWith('/account/encryption') ? { mode: 'plain', updatedAt: 1 }
      : { content: { t: 'plain', v: {} }, version: 1 },
  }));
  const writes: Array<{ url: string; token: unknown; data: unknown }> = [];
  let bobUnavailable = surface === 'reconnect';
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, data, config) => {
    if (bobUnavailable && config?.headers?.Authorization === 'Bearer bob') return { status: 503, data: null };
    writes.push({ url, token: config?.headers?.Authorization, data });
    return { status: 200, data: { success: true, source: { status: 'linked' } } };
  });
  const alice = createProviderAccountUsagePersistenceScheduler({ credentials: { token: 'alice', encryption: null },
    api: { getAccountEncryptionMode: async () => 'plain' }, now: () => Date.now() });
  let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  const registry = new ConnectedServiceRuntimeRegistry();
  const trackedSessions = new Map<number, TrackedSession>();
  try {
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
      credentials: { token: 'alice', encryption: null }, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions, getRequester: () => runtime, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    const admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: 'bob' } },
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current } });
    if (!admitted) throw new Error('Missing real requester admission');
    admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => current);
    runtime = await createRequesterSessionRuntimeContext({ bootstrap: admitted.admitted,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (!runtime) throw new Error('Missing real requester runtime');
    if (surface === 'run_custody') {
      const exactRuntime = runtime;
      const registration = { runKey: 'cold-bob-run', runnerPid: process.pid, agentId: 'codex' as const,
        materializationKey: 'cold-bob-run', connectedServicesBindingsRaw: {}, connectedServiceSelectionsEnv: {}, sessionId: 'cold-bob' };
      const input = { registry, registration, resolveSessionAccountContext: async () => exactRuntime,
        assertSessionAccountCurrent: async () => { if (!await exactRuntime.isCurrent()) throw new Error('requester_session_not_current'); } };
      await registerExecutionRunConnectedServicesTarget(input);
      expect(registry.getRunTargetByRunKey('cold-bob-run')?.requesterWorkAttributionV1).toEqual(exactRuntime.bootstrap.attribution);
      expect(runtime.connectedServiceRuntimeRegistry?.getRunTargetByRunKey('cold-bob-run')?.sessionId).toBe('cold-bob');
      current = false;
      await expect(registerExecutionRunConnectedServicesTarget({ ...input, registration: { ...registration,
        runKey: 'retired-bob-run', materializationKey: 'retired-bob-run' } })).rejects.toThrow('requester_session_not_current');
      expect(registry.getRunTargetByRunKey('retired-bob-run')).toBeNull();
      expect(registry.unregisterRunKey('cold-bob-run')?.materializationKey).toBe('cold-bob-run');
      expect(registry.getRunTargetByRunKey('cold-bob-run')).toBeNull();
      await runtime.dispose();
      await expect(registerExecutionRunConnectedServicesTarget({ ...input, registration: { ...registration,
        runKey: 'disposed-bob-run', materializationKey: 'disposed-bob-run' } })).rejects.toThrow('requester_session_not_current');
      expect(registry.getRunTargetByRunKey('disposed-bob-run')).toBeNull();
      return;
    }
    if (surface === 'generation') {
      const exactRuntime = runtime;
      const input = { token: 'alice', sessionId: 'bob-session', resolveSessionAccountContext: async () => exactRuntime,
        assertSessionAccountCurrent: async () => { if (!await exactRuntime.isCurrent()) throw new Error('requester_session_not_current'); } };
      const projection = await fetchConnectedServiceProjectionForSession(input);
      expect(projection.snapshot.groups).toEqual([{ serviceId: 'happier.agent.codex/openai-codex', groupId: 'main', activeProfileId: 'work', generation: 2 }]);
      expect(projection.requester).toBe(true);
      const bobProfileUrls = new Set(get.mock.calls.filter(([url, config]) => String(url).endsWith('/profile')
        && config?.headers?.Authorization === 'Bearer bob').map(([url]) => url));
      expect([...bobProfileUrls]).toEqual(['https://bob-home.test/v1/account/profile']);
      current = false;
      await expect(fetchConnectedServiceProjectionForSession(input)).rejects.toThrow('requester_session_not_current');
      const owned = await runWithServerHttpBaseUrl('https://alice-home.test', () => fetchConnectedServiceProjectionForSession({ token: 'alice' }));
      expect(owned.snapshot.groups[0]?.generation).toBe(1);
      expect(owned.requester).toBe(false);
      return;
    }
    const recordKey = { providerId: 'codex', accountSubjectId: 'provider-bob', subjectKind: 'account', quotaScope: 'account' } as const;
    const snapshot: ProviderAccountUsageSnapshotV1 = { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'provider-bob' }, observedAtMs: 1_000,
      fetchedAtMs: 1_000, staleAfterMs: 300_000, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data', meters: [] };
    const targets = [{ source: { ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
      bindingKind: 'account' as const }, expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', expectedConfigurationRevision: 'cfg-current' }];
    await runtime.providerAccountUsagePersistence.recordInBandSnapshot(snapshot, { targets });
    await runtime.providerAccountUsagePersistence.flush(1_000);
    if (surface === 'reconnect') {
      // Flush the retained failure once while transport is still down; the canonical
      // retry owner then parks it until reconnect, rather than an incidental timer.
      await runtime.providerAccountUsagePersistence.flush(1_000);
      expect(writes).toEqual([]);
      bobUnavailable = false;
      const exactRuntime = runtime;
      const reconnect = () => flushProviderAccountUsagePersistenceForTrackedSessions({ ownedScheduler: alice,
        trackedSessions: [{ happySessionId: 'bob-session' }, { happySessionId: 'bob-session' }],
        resolveSessionAccountContext: async () => exactRuntime, timeoutMs: 1_000 });
      await runWithServerHttpBaseUrl('https://alice-home.test', reconnect);
      expect(writes).toEqual([{ url: 'https://bob-home.test/v4/connect/qualified/provider-account-usage', token: 'Bearer bob',
        data: expect.objectContaining({ snapshot }) }]);
      current = false;
      await runtime.providerAccountUsagePersistence.recordInBandSnapshot({ ...snapshot, fetchedAtMs: 2_000 }, { targets });
      await runtime.providerAccountUsagePersistence.flush(1_000);
      await runWithServerHttpBaseUrl('https://alice-home.test', async () => {
        await alice.recordInBandSnapshot(snapshot, { targets });
        await reconnect();
      });
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual({ url: 'https://alice-home.test/v4/connect/qualified/provider-account-usage', token: 'Bearer alice',
        data: expect.objectContaining({ snapshot }) });
      return;
    }
    expect(writes).toEqual([{ url: 'https://bob-home.test/v4/connect/qualified/provider-account-usage', token: 'Bearer bob',
      data: expect.objectContaining({ source: targets[0].source, snapshot, payloadMode: 'plain_json_v1' }) }]);
    current = false;
    await runtime.providerAccountUsagePersistence.recordInBandSnapshot({ ...snapshot, fetchedAtMs: 2_000 }, { targets });
    await runtime.providerAccountUsagePersistence.flush(1_000);
    expect(writes).toHaveLength(1);
    await runWithServerHttpBaseUrl('https://alice-home.test', async () => {
      await alice.recordInBandSnapshot(snapshot, { targets });
      await alice.flush(1_000);
    });
    expect(writes[1]).toEqual({ url: 'https://alice-home.test/v4/connect/qualified/provider-account-usage', token: 'Bearer alice',
      data: expect.objectContaining({ snapshot }) });
  } finally {
    try {
      await runtime?.dispose();
    } finally {
      try {
        await host?.dispose();
      } finally {
        alice.dispose(); get.mockRestore(); post.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});


it.each(['retired', 'pending_release'] as const)('keeps requester runtime %s under its canonical authority', async surface => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-runtime-'));
  let holdCurrentness = false;
  let enterCurrentness: (() => void) | undefined;
  let releaseCurrentness: (() => void) | undefined;
  let delayReleaseProbe = false;
  const currentnessEntered = new Promise<void>(resolve => { enterCurrentness = resolve; });
  // HTTP admission/profile/settings is the boundary; all Account owners and runtime composition are real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (delayReleaseProbe && url.endsWith('/profile')) vi.setSystemTime(2_000);
    if (holdCurrentness && url.endsWith('/profile')) {
      enterCurrentness?.();
      await new Promise<void>(resolve => { releaseCurrentness = resolve; });
    }
    return { status: 200,
    data: url.endsWith('/v2/sessions/bob-session') ? { session: createSessionRecordFixture({
      id: 'bob-session', encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }),
      dataEncryptionKey: null, share: null,
    }) } : url.endsWith('/profile') ? { id: 'bob' } : url.endsWith('/currentness')
      ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
      : { content: { t: 'plain', v: {} }, version: 1 },
    };
  });
  let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  try {
    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedSessions = new Map<number, TrackedSession>();
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
      credentials: { token: 'alice', encryption: null }, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions, getRequester: () => runtime, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    const admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: 'bob' } },
      existingSessionId: 'bob-session',
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true } });
    if (!admitted) throw new Error('Missing real requester admission');
    admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => true);
    runtime = await createRequesterSessionRuntimeContext({ bootstrap: admitted.admitted,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (!runtime) throw new Error('Missing real requester runtime');
    expect(await runtime.bootstrap.isCurrent()).toBe(true);
    if (surface === 'pending_release') {
      const captured = runtime;
      const emittedAt: number[] = [];
      const ports = createPendingResetStartRecoveryPorts({ credentials: { token: 'alice', encryption: null }, machineId: 'machine',
        isCurrent: () => true, resolveRequesterSessionRuntimeContext: async () => captured,
        releaseRequesterSessionRuntimeContext: context => context.dispose(),
        // Installed Machine transport is the boundary; the scoped requester adapter remains real.
        release: async () => { emittedAt.push(Date.now()); }, onError: error => { throw error; } });
      vi.useFakeTimers(); vi.setSystemTime(1_000);
      await ports.withSession('bob-session', async session => {
        expect(await session.isCurrent()).toBe(true);
        // The caller's final authority check and readiness decision just settled.
        // A further HTTP probe would postpone the Machine effect beyond the window.
        delayReleaseProbe = true;
        await session.release({ localId: 'pending', reset: {
          source: { ref: { service: { pluginId: 'example', localId: 'service' }, accountId: 'account' }, bindingKind: 'account' },
          recordId: buildProviderAccountUsageRecordId({ providerId: 'test', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' }),
          meterId: 'window', witness: { id: 'history', observedAtMs: 500 },
        } });
      });
      expect(emittedAt).toEqual([1_000]);
      expect(await captured.isCurrent()).toBe(false);
      return;
    }
    holdCurrentness = true;
    const checking = runtime.isCurrent();
    await currentnessEntered;
    await Promise.all([runtime.dispose(), runtime.dispose()]);
    holdCurrentness = false;
    releaseCurrentness?.();
    expect(await checking).toBe(false);
    expect(await admitted.admitted.isCurrent()).toBe(false);
    expect(channel.clients.every(client => !client.connected)).toBe(true);
    const before = get.mock.calls.length;
    await expect(assertRequesterSessionAccountContextCurrent({ expected: runtime,
      resolveCurrent: async () => runtime, readTrackedContext: () => runtime })).rejects.toThrow('requester_session_not_current');
    await expect(runtime.qualifiedConnectedAccountApi.listAccounts({ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }))
      .rejects.toMatchObject({ code: 'requester_account_context_unavailable' });
    expect(await runtime.refreshAccountSettings()).toBe(false);
    let refusal: unknown;
    try { runtime.readAccountSettingsSnapshot(); } catch (error) { refusal = error; }
    expect(AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: false,
      error: projectRunnerDaemonPluginServicesFailure(refusal) })).toMatchObject({ ok: false, error: {
        code: 'requester_account_context_unavailable',
        cause: { code: 'requester_account_context_unavailable', stage: 'dispatch' },
      } });
    expect(get.mock.calls.length).toBe(before);
  } finally {
    releaseCurrentness?.();
    vi.useRealTimers();
    try {
      await runtime?.dispose();
    } finally {
      try {
        await host?.dispose();
      } finally {
        get.mockRestore(); await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
