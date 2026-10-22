import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { buildBackendTargetKeyV2, FeaturesResponseSchema, SessionUsageLimitRecoveryV1Schema, SessionRuntimeIssueV1Schema, type SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ApiMachineClient } from '@/api/apiMachine';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { createWorkspaceWritesPolicyPreparation } from '@/session/roles/workspaceWritesPolicyPreparation';
import { RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { configuration } from '@/configuration';
import * as persistence from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readPluginRoleSources } from '@/plugins/projection/registry/roles';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { withTempDir } from '@/testkit/fs/tempDir';
import { registerSessionClientRuntimeHandlers } from './registerSessionClientRuntimeHandlers';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { logger } from '@/ui/logger';

const homes: Server[] = [];

// Same decoder-valid Account token vector as the Session runtime-catalog suite.
// Home authentication is the genuine loopback HTTP boundary in this test.
function accountToken(sub: string): string {
  return `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.`;
}

afterEach(async () => {
  resetInMemoryAccountSettingsContextForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map(home => new Promise<void>((resolve, reject) => {
    home.close(error => error ? reject(error) : resolve());
  })));
});

async function home(settingsVersion: number, rawSettings: Readonly<Record<string, unknown>>, roleCatalog = false, usageLimitRecovery?: boolean,
  onStalledMutation?: () => void) {
  let usageLimitIssue: SessionRuntimeIssueV1 | null = null;
  const settingsResponse = AccountSettingsV2GetResponseSchema.parse({
    version: settingsVersion, content: { t: 'plain', v: rawSettings },
  });
  const requests: Array<Readonly<{ method: string | undefined; path: string | undefined;
    authorization: string | undefined; settingsResponse?: typeof settingsResponse }>> = [];
  const server = createServer((request, response) => {
    if (onStalledMutation && request.method === 'POST' && request.url === '/v2/sessions/access-grants/set') {
      request.resume();
      request.on('end', onStalledMutation);
      return;
    }
    const isSettingsRead = request.method === 'GET' && request.url === '/v2/account/settings';
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization,
      ...(isSettingsRead ? { settingsResponse } : {}) });
    response.setHeader('Content-Type', 'application/json');
    if (usageLimitRecovery !== undefined && request.url === '/v1/features') {
      response.end(JSON.stringify(FeaturesResponseSchema.parse({ features: { sessions: {
        enabled: true, usageLimitRecovery: { enabled: usageLimitRecovery },
      } } })));
    } else if (usageLimitRecovery !== undefined && request.method === 'GET' && request.url?.startsWith('/v2/sessions/')) {
      const sessionId = decodeURIComponent(new URL(request.url, 'http://fixture.local').pathname.slice('/v2/sessions/'.length));
      response.end(JSON.stringify({ session: createSessionRecordFixture({ id: sessionId,
        latestTurnStatus: usageLimitIssue ? 'failed' : null, lastRuntimeIssue: usageLimitIssue,
      }) }));
    } else if (isSettingsRead) {
      response.once('finish', () => server.emit('settings-read'));
      response.end(JSON.stringify(settingsResponse));
    }
    else if (roleCatalog && request.method === 'GET' && request.url === '/v1/account/encryption/currentness') {
      response.end(JSON.stringify({ mode: 'plain', version: 1, settingsVersion,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    } else if (roleCatalog && request.method === 'GET' && request.url === '/v1/account/entity-rows/prompt-library') {
      response.end(JSON.stringify(PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
          content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) })));
    } else if (roleCatalog && request.method === 'GET' && request.url === '/v1/account/entity-rows/profiles/transfer') {
      response.end(JSON.stringify({ status: 'absent' }));
    } else if (roleCatalog && request.method === 'GET' && request.url === '/v2/account/settings/history') {
      response.end(JSON.stringify({ snapshots: [] }));
    } else if (roleCatalog && request.method === 'GET' && request.url?.startsWith('/v1/artifacts?')) {
      response.end(JSON.stringify([]));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  const settingsRead = once(server, 'settings-read');
  homes.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing Home loopback address');
  return { url: `http://127.0.0.1:${address.port}`, requests, settingsResponse, settingsRead, server,
    setUsageLimitIssue: (issue: SessionRuntimeIssueV1 | null) => { usageLimitIssue = issue; },
  };
}

describe('Session RPC owner Home Settings custody', () => {
  it.each(['invocation', 'retirement'] as const)('cancels an issued Team visibility mutation on %s and preserves uncertainty', async lifetime => {
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    let accepted!: () => void;
    const mutationAccepted = new Promise<void>(resolve => { accepted = resolve; });
    let mutationIssued = false;
    const credentials = { token: accountToken('team-owner'), encryption: null } as const;
    const owner = await home(11, {}, false, undefined, () => { mutationIssued = true; accepted(); });
    const sessionId = 'team-owner-session';
    const metadata = createTestMetadata({});
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
    const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
    const registration = registerSessionClientRuntimeHandlers({
      rpcHandlerManager: rpc, token: credentials.token, serverId: 'team-home', serverUrl: owner.url,
      readOwnerAccountCredentials: async () => credentials,
      metadataPath: metadata.path, metadata, sessionId, getSessionMetadata: () => metadata,
      enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
      enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
      sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    const controller = new AbortController();
    const selection = { kind: 'team_credential_provider_model' as const, resourceId: 'resource', teamId: 'team',
      expectedResourceRevision: 7, agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }),
      modelId: 'team-model', deliveryMode: 'brokered' };
    const pending = rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      sessionId,
      intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Delegate.',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      modelId: selection.modelId, teamCredentialModel: selection,
      teamCredentialSessionBindingConsent: { v: 1, sessionId, teamId: selection.teamId,
        resourceId: selection.resourceId, expectedResourceRevision: selection.expectedResourceRevision },
    }, { signal: controller.signal, verifiedPeerAuthority: 'present_user' });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([pending, mutationAccepted.then(async () => {
        if (lifetime === 'invocation') controller.abort();
        else void registration.dispose();
        return await pending;
      }), new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('Team visibility cancellation did not settle HTTP')), 2000);
      })]);
      expect(mutationIssued).toBe(true);
      expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown',
        details: { executionRunStart: { runCreation: 'noRunCreated' } } });
    } finally {
      clearTimeout(watchdog);
      owner.server.closeAllConnections();
      await pending;
      await registration.dispose();
    }
  });
  it.each([true, false])('uses the captured Home usage-limit feature decision when the focused Home disagrees (owner enabled=%s)', async ownerEnabled => {
    vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'sessions,sessions.usageLimitRecovery');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    const ownerCredentials = { token: accountToken('usage-feature-owner'), encryption: null } as const;
    const owner = await home(11, {}, false, ownerEnabled);
    const focused = await home(99, {}, false, !ownerEnabled);
    const sessionId = 'usage-feature-owner-session';
    const metadata = createTestMetadata({ machineId: 'usage-feature-owner-machine',
      sessionUsageLimitRecoveryV1: SessionUsageLimitRecoveryV1Schema.parse({
        v: 1, status: 'waiting', resumePromptMode: 'standard', issueFingerprint: 'usage-limit:feature-owner',
        armedAtMs: 1_000, resetAtMs: 5_000, nextCheckAtMs: 5_000, attemptCount: 0,
        maxAttempts: 3, lastProbeError: null, selectedAuth: { kind: 'native' },
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:feature-owner',
      }),
    });
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
    const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
    const registration = registerSessionClientRuntimeHandlers({
      rpcHandlerManager: rpc, token: ownerCredentials.token, serverId: 'usage-feature-owner-home', serverUrl: owner.url,
      readOwnerAccountCredentials: async () => ownerCredentials,
      metadataPath: metadata.path, metadata, sessionId, getSessionMetadata: () => metadata,
      enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
      enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
      sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    try {
      await runWithServerHttpBaseUrl(focused.url, async () => {
        await expect(rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, { sessionId }))
          .resolves.toMatchObject({ ok: false, errorCode: ownerEnabled
            ? 'session_usage_limit_recovery_control_target_machine_unavailable' : 'feature_disabled' });
        expect(owner.requests).toContainEqual({ method: 'GET', path: '/v1/features', authorization: undefined });
        const machineRequests = owner.requests.filter(request => request.path?.startsWith('/v1/machines/'));
        expect(machineRequests).toEqual(ownerEnabled ? [{ method: 'GET', path: '/v1/machines/usage-feature-owner-machine',
          authorization: `Bearer ${ownerCredentials.token}` }] : []);
        expect(focused.requests).toEqual([]);
      });
    } finally { await registration.dispose(); }
  });
  it('routes a live usage-limit check with current owner credentials to its captured Home', async () => {
    vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'sessions,sessions.usageLimitRecovery');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    const ownerCredentials = { token: accountToken('usage-owner'), encryption: null } as const;
    const owner = await home(11, {}, false, true);
    const focused = await home(99, {}, false, true);
    const sessionId = 'usage-owner-session';
    const metadata = createTestMetadata({ machineId: 'usage-owner-machine',
      sessionUsageLimitRecoveryV1: SessionUsageLimitRecoveryV1Schema.parse({
        v: 1, status: 'waiting', resumePromptMode: 'standard', issueFingerprint: 'usage-limit:owner',
        armedAtMs: 1_000, resetAtMs: 5_000, nextCheckAtMs: 5_000, attemptCount: 0,
        maxAttempts: 3, lastProbeError: null, selectedAuth: { kind: 'native' },
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:owner',
      }),
    });
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
    let credentialsCurrent = true;
    const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
    const registration = registerSessionClientRuntimeHandlers({
      rpcHandlerManager: rpc, token: ownerCredentials.token, serverId: 'usage-owner-home', serverUrl: owner.url,
      readOwnerAccountCredentials: async () => credentialsCurrent ? ownerCredentials : null,
      metadataPath: metadata.path, metadata, sessionId, getSessionMetadata: () => metadata,
      enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
      enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
      sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    const check = () => rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, { sessionId });
    try {
      await runWithServerHttpBaseUrl(focused.url, async () => {
        // The genuine HTTP boundary refuses the unavailable Machine. Its request
        // still proves the registered route retained the Session's Home and owner.
        await expect(check()).resolves.toMatchObject({ ok: false,
          errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable' });
        expect(owner.requests).toContainEqual({ method: 'GET', path: '/v1/machines/usage-owner-machine',
          authorization: `Bearer ${ownerCredentials.token}` });
        expect(focused.requests.filter(request => request.path?.startsWith('/v1/machines/'))).toEqual([]);
        owner.setUsageLimitIssue(SessionRuntimeIssueV1Schema.parse({
          v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
          agentId: 'claude', agentTurnId: 'new-turn', occurredAt: 2_000,
          usageLimit: { v: 1, resetAtMs: 8_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
        }));
        await expect(check()).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_session_runtime_method' });
        expect(owner.requests.filter(request => request.path?.startsWith('/v1/machines/'))).toHaveLength(1);
        expect(owner.requests).toContainEqual({ method: 'GET', path: `/v2/sessions/${sessionId}`,
          authorization: `Bearer ${ownerCredentials.token}` });
        expect(focused.requests.filter(request => request.path?.startsWith('/v2/sessions/'))).toEqual([]);
        const ownerRequestCount = owner.requests.length;
        credentialsCurrent = false;
        await expect(check()).resolves.toMatchObject({ ok: false,
          errorCode: 'session_usage_limit_recovery_control_session_unavailable' });
        expect(owner.requests).toHaveLength(ownerRequestCount);
      });
    } finally { await registration.dispose(); }
  });
  it('keeps an attached agentDefault start Account refusal typed without caller Machine context', async () => {
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    const sessionId = 'default-child-owner-session';
    const metadata = createTestMetadata({});
    delete metadata.machineId;
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
    const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
    const registration = registerSessionClientRuntimeHandlers({
      rpcHandlerManager: rpc, token: accountToken('unavailable-owner'), serverId: 'session-owner-home', serverUrl: 'http://owner.invalid',
      readOwnerAccountCredentials: async () => null,
      metadataPath: metadata.path, metadata, sessionId, getSessionMetadata: () => metadata,
      enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
      enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
      sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    try {
      const result = await rpc.handleRequest({ method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`,
        params: ExecutionRunStartRequestSchema.parse({ intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Delegate with the Agent default.', childSelection: 'agentDefault', permissionMode: 'read_only',
          retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' }), callerAuthority: 'present_user' });
      expect(result).toMatchObject({ ok: false, errorCode: 'provider_authorization_changed',
        details: { executionRunStart: { runCreation: 'noRunCreated' } } });
    } finally { await registration.dispose(); }
  });
  it('sets a live Session role from its private owner without borrowing the focused Account catalog', async () => {
    const diagnostics = vi.spyOn(logger, 'infoFile');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_TTL_MS', '0');
    const ownerCredentials = { token: accountToken('role-owner-account'), encryption: null } as const;
    let ownerCurrent = true;
    const focusedCredentials = { token: accountToken('role-focused-account'), encryption: null } as const;
    const owner = await home(11, { schemaVersion: 6 }, true);
    const focused = await home(99, { schemaVersion: 6 });
    await withTempDir('happier-session-role-owner-', async directory => {
      await runWithServerHttpBaseUrl(focused.url, async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
          settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(focusedCredentials),
          promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
        const incumbent = getActiveAccountSettingsSnapshot();
        const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const sessionId = 'role-owner-session';
        const metadata = createTestMetadata({ path: directory, machineId: 'role-owner-machine' });
        const socket = createApiSessionSocketStub();
        const parent = new ApiSessionClient(ownerCredentials.token, createPlainSessionFixture({ id: sessionId, metadata }), {
          metadataAuthority: { kind: 'owner', credentials: ownerCredentials },
          transport: { serverId: 'role-owner-home', serverUrl: owner.url,
            // Socket.IO is the external transport boundary; the Session and Role registration remain real.
            createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
        });
        const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
        const queued: RegisteredSessionStateFieldMutationV1[] = [];
        const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
        // An explicitly empty plugin fixture, projected by the real registry;
        // Role source resolution stays real and does not discover unrelated bundled Agent manifests.
        const pluginRegistry = createResolvedContributionRegistry({});
        const registration = registerSessionClientRuntimeHandlers({
          rpcHandlerManager: rpc, token: ownerCredentials.token, serverId: 'role-owner-home', serverUrl: owner.url,
          readOwnerAccountCredentials: async () => ownerCurrent ? ownerCredentials : null,
          readRoleSources: createRoleSourceReader({ accountId: 'role-owner-account',
            artifactStore: createCredentialedAccountArtifactStore(ownerCredentials),
            readPluginRoles: () => readPluginRoleSources(pluginRegistry),
            readRawAccountSettings: async () => {
              const context = await bootstrapAccountSettingsContext({ credentials: ownerCredentials,
                mode: 'blocking', publication: 'invocation', honorAccountSettingsModeEnv: false });
              if (!context.rawSettings) throw new Error('Missing loopback owner Settings');
              return context.rawSettings;
            },
          }),
          metadataPath: directory, metadata, sessionId, getSessionMetadata: () => metadata,
          session: parent,
          enqueueRegisteredSessionStateFieldMutation: async mutation => { queued.push(mutation); },
          enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
          enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
          sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
          getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
          persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
        });
        try {
          const result = await rpc.handleRequest({ method: `${sessionId}:session.role.set`,
            params: { sessionId, roleId: 'builder' }, callerAuthority: 'present_user' });
          expect(result).toEqual({ updated: true });
          expect(queued).toEqual([expect.objectContaining({ sessionId, fieldId: 'intent.role', op: { kind: 'set', value: 'builder' } })]);
          expect(focused.requests).toEqual([]);
          expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
          expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(lifetime);
          let nativeWorkspaceWrites: 'allow' | 'deny' = 'allow';
          const runtimeSession = applyRunnerMcpSessionContext(parent, {
            prepareWorkspaceWritesPolicy: createWorkspaceWritesPolicyPreparation({
              // Native Agent configuration is the external boundary installed after Session RPC registration.
              update: async workspaceWrites => {
                nativeWorkspaceWrites = workspaceWrites;
                return { status: 'applied', timing: 'current_window' };
              },
            }),
          });
          const tightened = await rpc.handleRequest({ method: `${sessionId}:session.role.set`,
            params: { sessionId, roleId: 'scout' }, callerAuthority: 'present_user' });
          expect(tightened).toEqual({ updated: true });
          expect(RoleActionOutputSchemasV1['session.role.set'].parse(tightened)).toEqual({ updated: true });
          expect(nativeWorkspaceWrites).toBe('deny');
          expect(queued.at(-1)).toMatchObject({ sessionId, fieldId: 'intent.role', op: { kind: 'set', value: 'scout' } });
          runtimeSession.prepareWorkspaceWritesPolicy = undefined;
          const missingRuntime = await rpc.handleRequest({ method: `${sessionId}:session.role.set`,
            params: { sessionId, roleId: 'scout' }, callerAuthority: 'present_user' });
          expect(missingRuntime).toMatchObject({ ok: false, errorCode: 'role_policy_unenforceable' });
          expect(queued).toHaveLength(2);
          const unavailableRole = await rpc.handleRequest({ method: `${sessionId}:session.role.set`,
            params: { sessionId, roleId: 'missing-role' }, callerAuthority: 'present_user' });
          expect(unavailableRole).toEqual({ ok: false, errorCode: 'role_target_unavailable',
            error: 'role_target_unavailable' });
          expect(queued).toHaveLength(2);
          ownerCurrent = false;
          const retired = await rpc.handleRequest({ method: `${sessionId}:session.role.set`,
            params: { sessionId, roleId: 'scout' }, callerAuthority: 'present_user' });
          expect(retired).toEqual({ ok: false, errorCode: 'account_role_overrides_unavailable',
            error: 'account_role_overrides_unavailable' });
          expect(diagnostics.mock.calls.filter(([message]) => message === '[Session] Role Action refused')).toContainEqual([
            '[Session] Role Action refused', { originalCode: 'account_role_overrides_unavailable', reason: 'credentials-unavailable', contextSource: 'account_lifetime' },
          ]);
          expect(queued).toHaveLength(2);
          expect(focused.requests).toEqual([]);
          expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        } finally { await registration.dispose(); await parent.close(); }
      });
    });
  });
  it('admits detached Run policy from the authenticated daemon Account without borrowing focused Settings', async () => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_TTL_MS', '0');
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'execution.runs');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    const ownerCredentials = { token: accountToken('daemon-owner-account'), encryption: null } as const;
    const focusedCredentials = { token: accountToken('unrelated-focused-account'), encryption: null } as const;
    const owner = await home(11, { schemaVersion: 6,
      actionsSettingsV1: { v: 1, actions: { 'execution.run.start': { enabled: false } } } });
    const focused = await home(99, { schemaVersion: 6,
      actionsSettingsV1: { v: 1, actions: { 'execution.run.start': { enabled: true } } } });
    const ownerServerId = configuration.activeServerId;
    let credentialsCurrent = true;
    // This is the qualified on-disk credential boundary, not an alternate Account owner.
    vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockImplementation(async serverId =>
      serverId === ownerServerId && credentialsCurrent ? ownerCredentials : null);
    await runWithServerHttpBaseUrl(owner.url, async () => {
      const client = new ApiMachineClient(ownerCredentials.token, { id: 'daemon-owner-machine', encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
      const registration = client.setRPCHandlers({
        spawnSession: async () => { throw new Error('Unexpected Session spawn'); },
        stopSession: async () => { throw new Error('Unexpected Session stop'); },
        requestShutdown: () => { throw new Error('Unexpected daemon shutdown'); },
      });
      const rpc: unknown = Reflect.get(client, 'rpcHandlerManager');
      if (!(rpc instanceof RpcHandlerManager)) throw new Error('Missing machine RPC owner');
      try {
        await runWithServerHttpBaseUrl(focused.url, async () => {
          setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
            settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(focusedCredentials),
            acpCatalog: { status: 'ready', revision: 99, record: { v: 1, definitions: [] } } });
          const incumbent = getActiveAccountSettingsSnapshot();
          const incumbentLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
          const request = ExecutionRunStartRequestSchema.parse({
            intent: 'plan', backendTarget: { kind: 'backend', backendId: 'not-installed-owner-agent',
              configuredBackendId: 'not-installed-owner-agent', sourceKind: 'configured' },
            instructions: 'Read the project and return a plan.', permissionMode: 'read_only',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
          });
          // Trusted daemon-local dispatch enters the same registered Action owner;
          // a wire Machine call additionally requires Home machine admission.
          const result = await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, request,
            { verifiedPeerAuthority: 'account_automation' });
          expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
          expect(owner.requests).toEqual(expect.arrayContaining([{ method: 'GET', path: '/v2/account/settings',
            authorization: `Bearer ${ownerCredentials.token}`, settingsResponse: owner.settingsResponse }]));
          expect(focused.requests).toEqual([]);
          expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
          expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(incumbentLifetime);
          credentialsCurrent = false;
          const ownerRequestCount = owner.requests.length;
          await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, request,
            { verifiedPeerAuthority: 'account_automation' })).resolves.toMatchObject({ ok: false,
              errorCode: 'provider_authorization_changed', details: { executionRunStart: { runCreation: 'noRunCreated' } } });
          expect(owner.requests).toHaveLength(ownerRequestCount);
          expect(focused.requests).toEqual([]);
        });
      } finally {
        await registration.dispose();
        await client.shutdown();
      }
    });
  });

  it.each([false, true])('reads the captured owner Home and its policy for a public plan start without publishing into the focused Account (disabled=%s)', async disabled => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_TTL_MS', '0');
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'execution.runs');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    expect(resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env }).state).toBe('enabled');
    const ownerCredentials = { token: accountToken('session-owner-account'), encryption: null } as const;
    const focusedCredentials = { token: accountToken('unrelated-focused-account'), encryption: null } as const;
    expect(readAccountIdFromToken(ownerCredentials.token)).toBe('session-owner-account');
    expect(readAccountIdFromToken(focusedCredentials.token)).toBe('unrelated-focused-account');
    const owner = await home(11, { schemaVersion: 6, mcpServersStrictMode: true,
      actionsSettingsV1: { v: 1, actions: { 'execution.run.start': { enabled: !disabled } } } });
    if (owner.settingsResponse.content?.t !== 'plain') throw new Error('Expected plain owner Settings');
    expect(accountSettingsParse(owner.settingsResponse.content.v).actionsSettingsV1.actions['execution.run.start']?.enabled).toBe(!disabled);
    const focused = await home(99, { schemaVersion: 6, mcpServersStrictMode: false });
    await withTempDir('happier-session-owner-home-', async directory => {
      await runWithServerHttpBaseUrl(focused.url, async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ mcpServersStrictMode: false }),
          rawSettings: { mcpServersStrictMode: false }, settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [],
          scopeKey: resolveAccountSettingsScopeKey(focusedCredentials),
          acpCatalog: { status: 'ready', revision: 99, record: { v: 1, definitions: [] } } });
        const incumbent = getActiveAccountSettingsSnapshot();
        const incumbentLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const sessionId = 'foreign-home-session';
        const metadata = createTestMetadata({ path: directory, machineId: 'session-machine' });
        const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
        // These are the Session's durable transcript/network ports, not replacements
        // for its Settings getter, RPC dispatcher, engine registry or catalog services.
        const unexpectedTranscriptWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
        const registration = registerSessionClientRuntimeHandlers({
          rpcHandlerManager: rpc, token: ownerCredentials.token,
          serverId: 'session-owner-home', serverUrl: owner.url,
          readOwnerAccountCredentials: async () => ownerCredentials,
          metadataPath: directory, metadata, sessionId, getSessionMetadata: () => metadata,
          enqueueSessionUserMessage: unexpectedTranscriptWrite,
          enqueueUserTextMessageCommitted: unexpectedTranscriptWrite,
          enqueueAgentMessageCommitted: unexpectedTranscriptWrite,
          enqueueVoiceAgentTranscriptTurnCommitted: unexpectedTranscriptWrite,
          sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
          getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
          persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
        });
        try {
          expect(rpc.hasHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START)).toBe(true);
          const request = ExecutionRunStartRequestSchema.parse({
            intent: 'plan', backendTarget: { kind: 'backend', backendId: 'not-installed-owner-agent',
              configuredBackendId: 'not-installed-owner-agent', sourceKind: 'configured' },
            instructions: 'Read the project and return a plan.', permissionMode: 'read_only',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
          });
          // The transported request supplies no private Action context or Settings.
          // The real handler reads its owner before the later unavailable runtime refuses.
          const result: unknown = await rpc.handleRequest({
            method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`, params: request,
            callerAuthority: 'account_automation',
          });
          // Observe the actual boundary response rather than guessing a delay
          // or accepting a missing owner-route witness.
          const expectedErrorCode = disabled ? 'action_disabled' : 'execution_run_contribution_snapshot_unavailable';
          expect(result).toMatchObject({ ok: false, errorCode: expectedErrorCode });
          await Promise.race([owner.settingsRead, focused.settingsRead]);
          expect({ result, ownerRequests: owner.requests, focusedRequests: focused.requests,
            focusedSnapshotUnchanged: getActiveAccountSettingsSnapshot() === incumbent,
            focusedLifetimeUnchanged: getActiveAccountSettingsSnapshotLifetimeToken() === incumbentLifetime,
          }).toMatchObject({
            result: { ok: false, errorCode: expectedErrorCode },
            ownerRequests: expect.arrayContaining([{ method: 'GET', path: '/v2/account/settings',
              authorization: `Bearer ${ownerCredentials.token}`, settingsResponse: owner.settingsResponse }]),
            focusedRequests: [], focusedSnapshotUnchanged: true, focusedLifetimeUnchanged: true,
          });
          expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(99);
        } finally { await registration.dispose(); }
      });
    });
  });
});
