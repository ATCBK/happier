import axios, { AxiosHeaders } from 'axios';
import { artifactKindListResponse } from '@/testkit/http/artifactHome';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, createActionExecutor, createRoleSourceReaderV1, readLegacyRolesV1, encodeV2SessionListCursorV2,
  SessionListQueryV1Schema, SessionListQueryResponseV1Schema,
  type ActionExecutorContext } from '@happier-dev/protocol';
import { createSessionNotificationContextFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ACCOUNT_SECURITY_PATH_V1 } from '@happier-dev/protocol/auth/accountSecurity';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { registerSessionClientRuntimeHandlers } from '@/api/session/client/executionRuns/registerSessionClientRuntimeHandlers';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, readActiveAccountRoleOverrides,
  resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { SessionUserActionAnswerRpcParamsV1Schema } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { SessionNeedsYouRaiseInputV1Schema } from '@happier-dev/protocol/sessions/permissions/questionV1';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactReadBatchInputV1Schema, ArtifactReadBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createTerminalRuntimeSwitchHandlerService } from '@/agent/runtime/session/terminal/switchHandler';

import { createCliActionDeps, type SessionActionRpcTransport } from './createCliActionDeps';
import { resolveCliAgentStartContextV1 } from './resolveCliAgentStartContextV1';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionMachineRpcExecutionV1Schema, verifyExternalActionMachineRequestV1,
  verifyExternalActionMachineRpcRequestV1, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  decodeExternalActionResolvedTargetV1 } from '@happier-dev/protocol/actions';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const resumeNetwork = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: resumeNetwork.io }));

function callerSessionFixture(callerDirectory = '/caller/repo', currentStarterDepth = 2, active = true,
  rawOverrides: Partial<Parameters<typeof createSessionRecordFixture>[0]> = {}, questionAnswersEnabled = false,
  otherSessions: readonly ReturnType<typeof createSessionRecordFixture>[] = []) {
    const sessionId = 'c111111111111111111111111';
    const metadata = { path: callerDirectory, machineId: 'caller-machine', flavor: 'codex',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } as const;
    const rawSettings = { workDepthLimit: 7, ...(questionAnswersEnabled ? { actionsSettingsV1: { v: 1,
      actions: { 'session.user_action.answer': { disabledSurfaces: [] } } } } : {}) };
    const settings = accountSettingsParse(rawSettings);
    const credentials = { token: 'token', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings, rawSettings,
      settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    // HTTP is the genuine boundary; Session resolution, opening, metadata,
    // Agent selection, and admission-context construction all remain real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      }
      const otherSession = otherSessions.find(session => String(url).includes(`/v2/sessions/${session.id}`));
      if (otherSession) return { status: 200, data: { session: otherSession } };
      if (String(url).includes(`/v2/sessions/${sessionId}`)) {
        return { status: 200, data: { session: createSessionRecordFixture({
          id: sessionId, active,
          encryptionMode: 'plain', metadata: JSON.stringify(metadata),
          workDepth: currentStarterDepth,
          ...rawOverrides,
        }) } };
      }
      return { status: 404, data: {} };
    });
      const params = {
        token: credentials.token, credentials,
        sessionId: 'cli-global', mode: 'plain', ctx: null,
        rawSession: { path: '/wrong/repo', machineId: 'wrong-machine', workDepth: 0 },
        getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }),
        readRoleSources: createRoleSourceReaderV1({}),
        actionsSettingsProvider: createActionSettingsProvider({ scopeKey }),
      } satisfies Parameters<typeof createCliActionDeps>[0];
      return { sessionId, params, metadata, settings, get, cleanup: () => {
        get.mockRestore(); resetActiveAccountSettingsSnapshotForTests();
      } };
}

describe('daemon Account Action Session caller context', () => {
  it('routes the Agent control-switch Action to the current Session terminal owner and retains unsupported results', async () => {
    const fixture = callerSessionFixture();
    const receiver = new RpcHandlerManager({ scopePrefix: fixture.sessionId, encryptionMode: 'plain', logger: () => {} });
    const terminal = createTerminalRuntimeSwitchHandlerService({ registerHandler: (method, handler) => receiver.registerHandler(method, handler) });
    let remote = false;
    const subscription = terminal.register(async request => {
      if (request.target !== 'remote') return false;
      remote = true;
      return true;
    });
    const answer = async (event: string, payload: unknown) => {
      if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object') throw new Error('Unexpected control transport');
      const method = Reflect.get(payload, 'method');
      expect(method).toBe(`${fixture.sessionId}:switch`);
      if (typeof method !== 'string') throw new Error('Missing method');
      return { ok: true, result: await receiver.handleRequest({ method, params: Reflect.get(payload, 'params'),
        callerAuthority: 'account_automation' }) };
    };
    resumeNetwork.io.mockImplementation((_url, options) => {
      expect(options?.auth).toMatchObject({ authorityCeiling: 'account_automation' });
      return createApiSessionSocketStub({ emitWithAck: answer, emit: (event, [payload, callback]) => {
        if (typeof callback === 'function') void answer(event, payload).then(value => callback(value));
      } });
    });
    const deps = createCliActionDeps(fixture.params);
    const context = { surface: 'agent', authority: 'account_automation', defaultSessionId: fixture.sessionId,
      actionRequestId: 'control-switch',
      actionCaller: { kind: 'session', sessionId: fixture.sessionId, starterDepth: 0, turnDepth: 1 },
      sessionInputSource: { sourceSessionId: fixture.sessionId, sourceTurnId: 'turn-one', via: 'action' },
    } as const;
    try {
      const { ActionIdSchema } = await import('@happier-dev/protocol/actions/actionIds');
      const id = ActionIdSchema.parse('session.control.switch');
      const executor = createActionExecutor(deps);
      expect(await executor.execute(id, { to: 'remote' }, context)).toEqual({ ok: true, result: { switched: true } });
      expect(remote).toBe(true);
      subscription.unsubscribe();
      expect(await executor.execute(id, { to: 'remote' }, context))
        .toMatchObject({ ok: false, errorCode: 'session_control_unavailable' });
    } finally { subscription.unsubscribe(); resumeNetwork.io.mockReset(); fixture.cleanup(); }
  });
  it.each(['current', 'replaced', 'signed-read'] as const)('retains the admitted Action root and exact target on a remote inactive Resume (%s)', async outcome => {
    const fixture = callerSessionFixture('/repo', 0, false, { machineId: 'caller-machine', seq: 17,
      metadata: JSON.stringify({ path: '/repo', machineId: 'caller-machine', flavor: 'claude',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} }, claudeSessionId: 'provider-session-one' }),
    });
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'resume-root', binding: {
      accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'resume-home', machineId: 'caller-machine',
      installationId: 'resume-installed', actionId: 'session.open', requestId: 'remote-resume',
      target: { kind: 'machine', machineId: 'caller-machine' }, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const readSession = fixture.get.getMockImplementation()!;
    const verifyRead = (path: string, options?: Parameters<typeof axios.get>[1]) => {
        const headers = AxiosHeaders.from(Object.fromEntries(Object.entries(options?.headers ?? {}).filter(([, value]) => value !== undefined)));
        const target = decodeExternalActionResolvedTargetV1(String(headers.get(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER) ?? ''));
        expect(headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)).toBe(authorization.token);
        expect(headers.get(EXTERNAL_ACTION_EFFECT_ACTION_HEADER)).toBe('session.open');
        expect(target).toEqual(authorization.binding.target);
        if (!target || !verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
          effectActionId: 'session.open', target, installationId: 'resume-installed', requestId: 'remote-resume',
          method: 'GET', path, publicKey: keys.publicKey,
          signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER) ?? '') })) {
          throw new Error('Invalid original Resume authorization');
        }
    };
    fixture.get.mockImplementation(async (url, options) => {
      if (String(url).endsWith('/v1/machines/caller-machine')) {
        verifyRead('/v1/machines/caller-machine', options);
        return { status: 200, data: { machine: { id: 'caller-machine', storageMode: 'plain',
          replacedByMachineId: outcome === 'replaced' ? 'successor-machine' : null,
          dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
      }
      if (outcome === 'signed-read' && String(url).includes(`/v2/sessions/${fixture.sessionId}`)) {
        verifyRead(`/v2/sessions/${fixture.sessionId}`, options);
      }
      return await readSession(url, options);
    });
    let acceptedSessionId: string | undefined;
    const answer = async (event: string, payload: unknown) => {
      if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object') {
        throw new Error('Unexpected Resume transport');
      }
      const method = Reflect.get(payload, 'method');
      const requestId = Reflect.get(payload, 'requestId');
      const params = Reflect.get(payload, 'params');
      expect(method).toBe(`caller-machine:${RPC_METHODS.SPAWN_HAPPY_SESSION}`);
      const signed = ExternalActionMachineRpcExecutionV1Schema.parse(Reflect.get(payload, 'externalActionExecution'));
      expect(signed.authorization.binding).toEqual(authorization.binding);
      expect(signed.target).toEqual(authorization.binding.target);
      expect(signed.effectActionId).toBe('session.open');
      if (typeof method !== 'string' || typeof requestId !== 'string'
        || !verifyExternalActionMachineRpcRequestV1({ authorizationToken: signed.authorization.token,
          effectActionId: signed.effectActionId, target: signed.target, installationId: signed.installationId,
          event, method, requestId, params, signature: signed.machineSignature, publicKey: keys.publicKey })) {
        throw new Error('Invalid signed Resume request');
      }
      const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, params, method);
      expect(decoded.params).toMatchObject({ sessionId: fixture.sessionId, directory: '/repo' });
      acceptedSessionId = fixture.sessionId;
      return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' },
        { type: 'success', sessionId: fixture.sessionId }, decoded.callId) };
    };
    resumeNetwork.io.mockImplementation(() => createApiSessionSocketStub({
      emitWithAck: answer,
      emit: (event, [payload, callback]) => {
        if (typeof callback === 'function') void answer(event, payload).then(value => callback(value),
          () => callback({ ok: false, error: 'Forbidden' }));
      },
    }));
    try {
      const deps = createCliActionDeps({ ...fixture.params, serverId: configuration.activeServerId, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
        serverIdentityId: 'resume-home', externalActionMachineRequestPrivateKey: keys.secretKey,
        externalActionMachineInstallationId: 'resume-installed' });
      const result = await deps.sessionOpen?.({ sessionId: fixture.sessionId, serverId: configuration.activeServerId,
        actionRequestId: 'remote-resume' }, { surface: 'ui', authority: 'present_user',
        serverId: configuration.activeServerId, actionRequestId: 'remote-resume',
        externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
      });
      expect(result).toMatchObject(outcome !== 'replaced' ? { ok: true }
        : { ok: false, errorCode: 'machine_target_not_current' });
      expect(acceptedSessionId).toBe(outcome !== 'replaced' ? fixture.sessionId : undefined);
    } finally { resumeNetwork.io.mockReset(); fixture.cleanup(); }
  });

  it.each(['accepted', 'wrong_session', 'archived'] as const)('uses canonical exact inactive custody for session.open resume (%s)', async outcome => {
    const fixture = callerSessionFixture('/repo', 0, false, { machineId: 'caller-machine', seq: 17,
      ...(outcome === 'archived' ? { archivedAt: 10 } : {}),
      metadata: JSON.stringify({ path: '/repo', machineId: 'caller-machine', flavor: 'claude',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} }, claudeSessionId: 'provider-session-one' }),
    });
    const issued: unknown[] = [];
    const deps = createCliActionDeps({ ...fixture.params, serverId: configuration.activeServerId, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
      machineActionDirectTargetTransport: { machineId: 'caller-machine', invoke: async (method, request) => {
        issued.push({ method, request });
        return { type: 'success', sessionId: outcome === 'wrong_session' ? 'different-session' : fixture.sessionId };
      } },
    });
    try {
      const result = await createActionExecutor(deps).execute('session.open', { sessionId: fixture.sessionId,
        serverId: configuration.activeServerId, intent: 'resume', resumeRequest: {
          type: 'resume-session', sessionId: fixture.sessionId, directory: '/stale-caller-directory',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        } }, { surface: 'cli', authority: 'present_user', actionRequestId: 'exact-resume',
          serverId: configuration.activeServerId });
      if (outcome === 'accepted') {
        expect(result).toMatchObject({ ok: true });
        expect(issued).toMatchObject([{ method: 'spawn-happy-session', request: {
          sessionId: fixture.sessionId, directory: '/repo', initialTranscriptAfterSeq: 17,
        } }]);
      } else {
        expect(result).toMatchObject({ ok: false, errorCode: outcome === 'archived' ? 'session_archived' : 'unsupported' });
        if (outcome === 'archived') expect(issued).toEqual([]);
      }
    } finally { fixture.cleanup(); }
  });

  it.each([
    { cause: 'explicit_stop', active: false }, { cause: 'explicit_stop', active: true },
    { cause: 'archived', active: false }, { cause: 'archived', active: true },
  ] as const)('does not wake or answer a question after $cause while active=$active, even for the direct manager', async ({ cause, active }) => {
    const fixture = callerSessionFixture('/repo', 0, active, { machineId: 'caller-machine',
      manager: { sessionId: 'direct-manager' }, ...(cause === 'archived' ? { archivedAt: 10 } : {}),
      metadata: JSON.stringify({ path: '/repo', machineId: 'caller-machine', flavor: 'claude',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} }, claudeSessionId: 'provider-session-one',
        ...(cause === 'explicit_stop' ? { sessionExplicitStopV1: { v: 1, cause: 'explicit_stop', requestId: 'stop-one', requestedAtMs: 1 } } : {}),
      }),
    });
    const issued: unknown[] = [];
    const deps = createCliActionDeps({ ...fixture.params,
      machineActionDirectTargetTransport: { machineId: 'caller-machine', invoke: async request => {
        issued.push(request); return { type: 'success', sessionId: fixture.sessionId };
      } },
      sessionActionRpcTransport: async request => { issued.push(request); return { ok: true }; },
    });
    try {
      expect(await deps.sessionUserActionAnswer?.({ sessionId: fixture.sessionId, requestId: 'question-one',
        answers: [{ question: 'branch', values: ['dev'] }], context: {
          surface: 'agent', authority: 'account_automation', defaultSessionId: 'direct-manager', actionRequestId: 'late-answer',
          actionCaller: { kind: 'session', sessionId: 'direct-manager', starterDepth: 0, turnDepth: 1 },
          sessionInputSource: { sourceSessionId: 'direct-manager', sourceTurnId: 'manager-turn', via: 'action' },
        } })).toMatchObject({ ok: false, errorCode: cause === 'explicit_stop' ? 'held_by_person' : 'session_archived' });
      expect(issued).toEqual([]);
    } finally { fixture.cleanup(); }
  });

  it('wakes an inactive question host through the existing lifecycle owner before the sole answer RPC', async () => {
    const fixture = callerSessionFixture('/repo', 0, false, { machineId: 'caller-machine', seq: 17,
      manager: { sessionId: 'direct-manager' },
      metadata: JSON.stringify({ path: '/repo', machineId: 'caller-machine', flavor: 'claude',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} }, claudeSessionId: 'provider-session-one' }),
      agentState: JSON.stringify({ requests: { 'question-one': { tool: 'AskUserQuestion', kind: 'user_action',
        arguments: { questions: [{ id: 'branch', question: 'Which branch?' }] }, createdAt: 1 } } }),
    }, true);
    const observed: unknown[] = [];
    const deps = createCliActionDeps({ ...fixture.params,
      machineActionDirectTargetTransport: { machineId: 'caller-machine', invoke: async (method, request) => {
        observed.push({ method, request });
        return { type: 'success', sessionId: fixture.sessionId };
      } },
      sessionActionRpcTransport: async request => { observed.push(request); return { ok: true }; },
    });
    try {
      expect(await createActionExecutor(deps).execute('session.user_action.answer', { sessionId: fixture.sessionId,
        requestId: 'question-one', answers: [{ question: 'branch', values: ['dev'] }] }, {
        surface: 'agent', authority: 'account_automation', defaultSessionId: 'grandmanager', actionRequestId: 'recover-answer',
        actionCaller: { kind: 'session', sessionId: 'grandmanager', starterDepth: 0, turnDepth: 1 },
        sessionInputSource: { sourceSessionId: 'grandmanager', sourceTurnId: 'manager-turn', via: 'action' },
      })).toMatchObject({ ok: true });
      expect(observed).toEqual([
        expect.objectContaining({ method: 'spawn-happy-session', request: expect.objectContaining({
          type: 'resume-session', sessionId: fixture.sessionId, initialTranscriptAfterSeq: 17,
        }) }),
        expect.objectContaining({ method: 'session.user_action.answer', input: expect.objectContaining({ id: 'question-one' }) }),
      ]);
      const resume = observed[0] as { request: Readonly<Record<string, unknown>> };
      expect(resume.request).not.toHaveProperty('executionAuthorization');
      expect(resume.request).not.toHaveProperty('initialGoal');
    } finally { fixture.cleanup(); }
  });

  it('carries only a live attached-plugin host witness through question Action transport', async () => {
    const workerId = 'c222222222222222222222222';
    const fixture = callerSessionFixture('/caller/repo', 2, true, {}, true, [createSessionRecordFixture({
      id: workerId, active: true, encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/worker/repo', machineId: 'caller-machine', flavor: 'codex' }),
    })]);
    const received: unknown[] = [];
    const deps = createCliActionDeps({ ...fixture.params, sessionActionRpcTransport: async request => {
      received.push(request);
      return request.method === 'session.needs_you.raise'
        ? { ok: true, requestId: 'question-one', mode: 'wait' } : { ok: true };
    } });
    const caller = { kind: 'session', sessionId: fixture.sessionId, starterDepth: 0, turnDepth: 1 } as const;
    const witness = { inputId: 'input-one', turnId: 'turn-one', userMessageSeq: 1, userMessageSeqs: [1],
      callerPermissionMode: 'default' as const, agentStartCaller: caller };
    const input = SessionNeedsYouRaiseInputV1Schema.parse({ mode: 'wait', type: 'decision', questions: [{ id: 'branch', type: 'text', prompt: 'Which branch?' }] });
    try {
      for (const mode of ['live', 'missing', 'expired', 'wrong_session'] as const) {
        let reads = 0;
        const service = createPluginInvocationActionsService({ actionExecutor: createActionExecutor(deps),
          invokeContributedAction: async () => { throw new Error('Not a contributed Action'); },
          seed: { plugin: { id: 'example.questions', version: '1.0.0' }, occurrenceId: 'question-plugin',
            sourceCustody: { kind: 'development', registeredRootId: 'question-plugin-root' },
            surface: 'agent', session: { id: fixture.sessionId }, correlationId: 'attached-question',
            initiatingActionCaller: caller, signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            readActiveTurnAdmissionWitness: () => {
              reads += 1;
              return mode === 'missing' || mode === 'expired' && reads > 1 ? null
                : mode === 'wrong_session' ? { ...witness, agentStartCaller: { ...caller, sessionId: 'stranger' } } : witness;
            },
          } });
        if (mode === 'live') {
          await expect(service.execute('session.needs_you.raise', input)).resolves.toMatchObject({ requestId: 'question-one' });
          await expect(service.execute('session.user_action.answer', { sessionId: workerId, requestId: 'question-one', disposition: 'pass_up' }))
            .resolves.toMatchObject({ ok: true });
        } else {
          await expect(service.execute('session.needs_you.raise', input)).rejects.toMatchObject({ code: 'role_rpc_origin_unavailable' });
        }
      }
      expect(received).toEqual([
        expect.objectContaining({ method: 'session.needs_you.raise',
          origin: expect.objectContaining({ caller, sourceTurnId: 'turn-one', requestId: 'attached-question:session.needs_you.raise:1' }) }),
        expect.objectContaining({ method: 'session.user_action.answer', sessionId: workerId,
          input: { id: 'question-one', disposition: 'pass_up' },
          origin: expect.objectContaining({ caller, sourceTurnId: 'turn-one', requestId: 'attached-question:session.user_action.answer:2' }) }),
      ]);
    } finally { fixture.cleanup(); }
  });

  it('authors and withdraws questions through the current Session authenticated RPC', async () => {
    const fixture = callerSessionFixture();
    const received: unknown[] = [];
    const deps = createCliActionDeps({ ...fixture.params, sessionActionRpcTransport: async request => {
      const input = SessionNeedsYouRaiseInputV1Schema.parse(request.input);
      received.push(request);
      return 'withdraw' in input
        ? { ok: true, requestId: 'question-one', withdrawn: true }
        : { ok: true, requestId: 'question-one', mode: 'continue' };
    } });
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
      actionCaller: { kind: 'session', sessionId: fixture.sessionId, starterDepth: 0, turnDepth: 1 },
      defaultSessionId: fixture.sessionId, actionRequestId: 'raise-action',
      sessionInputSource: { sourceSessionId: fixture.sessionId, sourceTurnId: 'turn-one', via: 'action' } };
    const input = { mode: 'continue', type: 'decision', assumption: 'Use the current branch until answered',
      questions: [{ id: 'branch', type: 'text', prompt: 'Which branch?' }] };
    try {
      const executor = createActionExecutor(deps);
      expect(await executor.execute('session.needs_you.raise', input, context)).toMatchObject({
        ok: true, result: { ok: true, requestId: 'question-one', mode: 'continue' },
      });
      expect(await executor.execute('session.needs_you.raise', { requestId: 'question-one', withdraw: 'No longer needed' }, context))
        .toMatchObject({ ok: true, result: { ok: true, requestId: 'question-one', withdrawn: true } });
      expect(received).toEqual([
        expect.objectContaining({ method: 'session.needs_you.raise', input,
          origin: expect.objectContaining({ caller: context.actionCaller, sourceTurnId: 'turn-one', requestId: 'raise-action' }) }),
        expect.objectContaining({ method: 'session.needs_you.raise', input: { requestId: 'question-one', withdraw: 'No longer needed' } }),
      ]);
      // Initiating provenance describes an edge; it is not a Session witness.
      expect(await executor.execute('session.needs_you.raise', input, { ...context, surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'example', initiatingCaller: context.actionCaller },
      })).toMatchObject({ ok: false, errorCode: 'role_rpc_origin_unavailable' });
      expect(received).toHaveLength(2);
    } finally { fixture.cleanup(); }
  });

  it('carries question responses through authenticated Session transport and the strict receiver', async () => {
    const fixture = callerSessionFixture();
    const caller = { kind: 'session', sessionId: fixture.sessionId, starterDepth: 0, turnDepth: 1 } as const;
    const received: unknown[] = [];
    // The authenticated Machine RPC is the boundary. Decode its real producer
    // output with the canonical receiving schema, including the pass-up arm.
    const deps = createCliActionDeps({ ...fixture.params, sessionActionRpcTransport: async request => {
      received.push({ input: SessionUserActionAnswerRpcParamsV1Schema.parse(request.input), origin: request.origin });
      return { ok: true };
    } });
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
      actionCaller: caller, defaultSessionId: fixture.sessionId, actionRequestId: 'answer-action',
      sessionInputSource: { sourceSessionId: fixture.sessionId, sourceTurnId: 'turn-one', via: 'action' } };
    try {
      for (const response of [{ answers: [{ question: 'Branch?', values: ['dev'] }] }, { disposition: 'pass_up' as const }]) {
        expect(await deps.sessionUserActionAnswer?.({
          sessionId: fixture.sessionId, requestId: 'question-one', answers: [], ...response, context,
        })).toMatchObject({ ok: true });
      }
      expect(received).toEqual([
        expect.objectContaining({ input: { id: 'question-one', approved: true, decision: 'approved', answers: { 'Branch?': ['dev'] } },
          origin: expect.objectContaining({ caller, sourceTurnId: 'turn-one', requestId: 'answer-action' }) }),
        expect.objectContaining({ input: { id: 'question-one', disposition: 'pass_up' } }),
      ]);
      expect(await createCliActionDeps(fixture.params).sessionUserActionAnswer?.({
        sessionId: fixture.sessionId, requestId: 'question-one', disposition: 'pass_up', answers: [], context,
      })).toMatchObject({ ok: false, errorCode: 'role_rpc_origin_unavailable' });
    } finally {
      fixture.cleanup();
    }
  });
  it('queries active and archived reports concurrently before copying the complete ordered snapshot', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const accountId = 'report-query-owner';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const lead = 'c123456789012345678901230';
    const children = ['c123456789012345678901231', 'c123456789012345678901232',
      'c123456789012345678901233', 'c123456789012345678901234'];
    const backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const;
    const metadata = createTestMetadata({ machineId: 'report-machine',
      flavor: 'codex',
      work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: 'Release checklist' } } });
    const childMetadata = new Map(children.map(id => [id, createTestMetadata()]));
    const rawSettings = { workDepthLimit: 7, actionsSettingsV1: { v: 1, actions: {},
      approvalWaivedSurfaces: { 'session.roles.apply_to_reports': ['agent'] } } };
    const settings = accountSettingsParse(rawSettings);
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings, rawSettings, settingsVersion: 1,
      settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    const sources = createRoleSourceReaderV1({});
    const agentStartContext = resolveCliAgentStartContextV1({ sessionId: lead, metadata,
      machineId: 'report-machine', directory: metadata.path, backendTarget,
      starterDepth: 0, turnDepth: 0, callerPermissionMode: 'default', settings,
      roleSourceInventory: await sources(), accountRoleOverrides: { status: 'ready', overrides: {} } });
    if (!agentStartContext) throw new Error('Missing canonical Session caller fixture');
    if (agentStartContext.caller.kind !== 'session') throw new Error('Expected Session caller fixture');
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', defaultSessionId: lead,
      actionCaller: agentStartContext.caller, agentStartContext, callerPermissionMode: 'default',
      actionRequestId: 'copy-reports', sessionInputSource: { sourceSessionId: lead, sourceTurnId: 'lead-turn' } };
    const row = (id: string) => ({ ...createSessionNotificationContextFixture(id), encryptionMode: 'plain' as const,
      metadata: JSON.stringify(id === lead ? metadata : childMetadata.get(id) ?? createTestMetadata()),
      workDepth: 0, ...(children.includes(id) ? { manager: { sessionId: lead } } : {}) });
    const queries: string[] = [];
    const writes: string[] = [];
    const cursors = { active: encodeV2SessionListCursorV2({ sessionId: children[0]!, meaningfulActivityAt: 1 }),
      archived: encodeV2SessionListCursorV2({ sessionId: children[2]!, meaningfulActivityAt: 1 }) };
    let releaseActive!: () => void;
    let releaseArchived!: () => void;
    const activeGate = new Promise<void>(resolve => { releaseActive = resolve; });
    const archivedGate = new Promise<void>(resolve => { releaseArchived = resolve; });
    // Only HTTP and the authenticated RPC relay are replaced. Query parsing,
    // pagination, Role resolution, receiving admission and metadata application stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 404, data: {} };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: rawSettings } } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows:
        PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
          content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) } };
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path.startsWith('/v2/sessions/')) return { status: 200, data: { session: row(path.slice('/v2/sessions/'.length)) } };
      throw new Error(`Unexpected report copy HTTP read: ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      const path = new URL(String(input)).pathname;
      if (path !== '/v2/sessions/query') throw new Error(`Unexpected report copy HTTP write: ${path}`);
      const query = SessionListQueryV1Schema.parse(body);
      if (query.underSessionId !== lead) throw new Error('Unexpected report query scope');
      queries.push(`${query.storage}:${query.cursor ? 'next' : 'first'}`);
      if (!query.cursor) await (query.storage === 'active' ? activeGate : archivedGate);
      else expect(query.cursor).toBe(cursors[query.storage]);
      const firstIndex = query.storage === 'active' ? 0 : 2;
      return { status: 200, data: SessionListQueryResponseV1Schema.parse({
        sessions: query.cursor ? [row(children[firstIndex + 1]!)] : [row(children[firstIndex]!), row('unrelated')],
        nextCursor: query.cursor ? null : cursors[query.storage], hasNext: !query.cursor,
        attentionNextCursor: null, attentionHasNext: false }) };
    });
    const managers = new Map(children.map(id => [id, new RpcHandlerManager({ scopePrefix: id, encryptionMode: 'plain', logger: () => {} })]));
    let misbindRecipient = false;
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: lead, mode: 'plain', ctx: null,
      getCurrentSessionMetadata: () => metadata, readRoleSources: sources,
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey }),
      sessionActionRpcTransport: async request => {
        const manager = managers.get(request.sessionId);
        if (!manager) throw new Error('Unexpected report recipient');
        return await manager.handleRequest({ method: `${misbindRecipient ? 'wrong-session' : request.sessionId}:${request.method}`, params: request.input,
          callerAuthority: 'account_automation', sessionActionOrigin: request.origin });
      } });
    const unexpectedTranscriptWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
    const registrations = [...managers].map(([id, manager]) => {
      const child = childMetadata.get(id)!;
      return registerSessionClientRuntimeHandlers({ rpcHandlerManager: manager, sessionId: id,
        token: credentials.token, serverId: configuration.activeServerId, serverUrl: resolveServerHttpBaseUrl(),
        readOwnerAccountCredentials: async () => credentials,
        actionsSettingsProvider: createActionSettingsProvider({ scopeKey }),
        metadataPath: child.path, metadata: child, getSessionMetadata: () => childMetadata.get(id)!, readRoleSources: sources,
        enqueueRegisteredSessionStateFieldMutation: async mutation => {
          childMetadata.set(id, applyRegisteredSessionStateFieldMutationToMetadata(childMetadata.get(id)!, mutation));
          writes.push(id);
        },
        enqueueSessionUserMessage: unexpectedTranscriptWrite, enqueueUserTextMessageCommitted: unexpectedTranscriptWrite,
        enqueueAgentMessageCommitted: unexpectedTranscriptWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedTranscriptWrite,
        sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
        getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
        persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
      });
    });
    const pending = createActionExecutor(deps).execute('session.roles.apply_to_reports', { sessionId: lead }, context);
    try {
      await expect.poll(() => queries).toEqual(['active:first', 'archived:first']);
      expect(writes).toEqual([]);
      releaseArchived();
      await expect.poll(() => queries).toEqual(['active:first', 'archived:first', 'archived:next']);
      expect(writes).toEqual([]);
      releaseActive();
      expect(await pending).toEqual({ ok: true, result: { updatedSessionIds: children } });
      expect(writes).toEqual(children);
      for (const child of childMetadata.values()) {
        expect(child.work?.sessionRolesV1).toMatchObject({ inheritedFrom: lead, notes: 'Release checklist',
          sessionRoles: { builder: expect.objectContaining({ name: 'Builder', workspaceWrites: 'allow' }) } });
      }
      misbindRecipient = true;
      expect(await createActionExecutor(deps).execute('session.roles.apply_to_reports', { sessionId: lead }, context))
        .toMatchObject({ ok: false });
      expect(writes).toEqual(children);
    } finally {
      releaseActive(); releaseArchived();
      await pending;
      await Promise.all([...managers.values()].map(manager => manager.waitForIdle()));
      for (const registration of registrations) registration.dispose();
      post.mockRestore(); get.mockRestore(); resetActiveAccountSettingsSnapshotForTests();
    }
  });
  it('resolves complete Role inventories from the retained Account without a second Settings capture', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const accountId = 'retained-role-account';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const rawSettings = { executionRunsGuidanceEntries: [{ id: 'release-checks', title: 'Release checks', description: 'Retained release instructions.' }] };
    const retained = readLegacyRolesV1(rawSettings, accountId)[0];
    if (!retained) throw new Error('Missing canonical legacy Role fixture');
    setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings: accountSettingsParse(rawSettings), rawSettings,
      settingsVersion: 7, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Missing retained Account');
    let current = true;
    const operation = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
      readSourceSnapshot: () => current ? getActiveAccountSettingsSnapshot() : null, isCurrent: async () => current });
    const artifactReads: string[] = [];
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/artifacts') { artifactReads.push(path); return { status: 200, data: artifactKindListResponse([]) }; }
      // A Settings recapture is a distinct external operation and may be slow or
      // unavailable while this invocation's admitted snapshot remains readable.
      throw new Error(`Unavailable unrelated Settings read: ${path}`);
    });
    try {
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        sessionId: 'retained-role-session', mode: 'plain', ctx: null, savedSecretOperationContext: operation }));
      expect(await executor.execute('roles.list', {}, { surface: 'cli', authority: 'present_user' })).toMatchObject({
        ok: true, result: { diagnostics: [], items: expect.arrayContaining([expect.objectContaining({
          roleId: retained.artifactId, role: expect.objectContaining({ instructions: retained.role.instructions }),
        })]) },
      });
      artifactReads.length = 0;
      current = false;
      expect(await executor.execute('roles.list', {}, { surface: 'cli', authority: 'present_user' }))
        .toMatchObject({ ok: false });
      expect(artifactReads).toEqual([]);
    } finally { get.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });
  it('refuses generic Artifact deletion of a current guidance Role without blocking unrelated documents or retired guidance', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const accountId = 'guidance-delete-account';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    let rawSettings: Readonly<Record<string, unknown>> = { executionRunsGuidanceEntries: [
      { id: 'current-guidance', title: 'Guidance Role', description: 'Preserve the current guidance Role.' },
      { id: 'malformed-unrelated-guidance', description: 17 },
    ] };
    const legacy = readLegacyRolesV1(rawSettings, accountId)[0];
    if (!legacy) throw new Error('invalid current guidance fixture');
    let settingsVersion = 7;
    const publish = () => setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings: accountSettingsParse(rawSettings),
      rawSettings, settingsVersion, settingsSecretsReadKeys: [], loadedAtMs: settingsVersion,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    publish();
    const stored = (id: string, header: Readonly<Record<string, unknown>>, body: string) => ({
      id, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
      seq: 1, createdAt: 1, updatedAt: 1,
    });
    const artifacts = new Map([
      [legacy.artifactId, stored(legacy.artifactId, { kind: 'role.v1', name: legacy.role.name }, JSON.stringify(legacy.role))],
      ['ordinary-role', stored('ordinary-role', { kind: 'role.v1', name: 'Independent Role' }, JSON.stringify(legacy.role))],
      ['ordinary-document', stored('ordinary-document', { kind: 'prompt_doc.v1', title: 'Independent document' }, 'Keep ordinary deletion available.')],
    ]);
    // HTTP is the storage boundary; current guidance admission and native
    // revision deletion remain the real CLI/Protocol paths.
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: rawSettings }, version: settingsVersion } };
      const artifact = artifacts.get(path.slice('/v1/artifacts/'.length));
      if (path.startsWith('/v1/artifacts/')) return { status: artifact ? 200 : 404, data: artifact ?? {} };
      throw new Error(`Unexpected guidance deletion HTTP boundary: ${path}`);
    });
    const remove = vi.spyOn(axios, 'delete').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      const prefix = '/v1/artifacts/';
      const suffix = '/revision/1/1';
      if (!path.startsWith(prefix) || !path.endsWith(suffix)) throw new Error(`Unexpected Artifact deletion boundary: ${path}`);
      return { status: artifacts.delete(path.slice(prefix.length, -suffix.length)) ? 200 : 404, data: {} };
    });
    try {
      const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'guidance-session', mode: 'plain', ctx: null });
      const executeDelete = (artifactId: string) => deps.artifactAction?.({ actionId: 'artifact.delete',
        input: { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
        context: { surface: 'cli', authority: 'present_user' } });
      await expect(executeDelete(legacy.artifactId)).resolves.toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
      expect(artifacts.has(legacy.artifactId)).toBe(true);
      for (const artifactId of ['ordinary-document', 'ordinary-role']) {
        await expect(executeDelete(artifactId)).resolves.toEqual({ artifactId, deleted: true });
        expect(artifacts.has(artifactId)).toBe(false);
      }
      rawSettings = {};
      settingsVersion = 8;
      publish();
      await expect(executeDelete(legacy.artifactId)).resolves.toEqual({ artifactId: legacy.artifactId, deleted: true });
      expect(artifacts.has(legacy.artifactId)).toBe(false);
    } finally { remove.mockRestore(); get.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });

  it.each(['roles.list', 'roles.get'] as const)('refuses retired %s before reading a private Role Artifact body', async actionId => {
    resetActiveAccountSettingsSnapshotForTests();
    const accountId = 'private-role-account';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const settings = accountSettingsParse({});
    const publish = (loadedAtMs: number) => setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings,
      rawSettings: {}, settingsVersion: 7, settingsSecretsReadKeys: [], loadedAtMs,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    publish(1);
    const roleId = 'private-role-artifact';
    const role = { name: 'Private instructions', instructions: 'Account-private Role document', runsAs: { kind: 'session' },
      workspaceWrites: 'deny', secondOpinion: 'off', enabled: true };
    const stored = { id: roleId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      publicAudience: 'none',
      header: encodePlainArtifactStoredContent({ kind: 'role.v1', name: role.name }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(role) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const privateReads: string[] = [];
    // HTTP is the only replaced boundary: the actual Account Artifact store
    // opens the private body and the canonical source reader classifies it.
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts') {
        privateReads.push(path);
        const { body: _body, ...header } = stored;
        return { status: 200, data: artifactKindListResponse([header]) };
      }
      if (path === `/v1/artifacts/${roleId}`) { privateReads.push(path); return { status: 200, data: stored }; }
      throw new Error(`Unexpected private Role HTTP boundary: ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      const path = new URL(String(input)).pathname;
      if (path !== '/v1/artifacts/read') throw new Error(`Unexpected private Role HTTP boundary: ${path}`);
      expect(ArtifactReadBatchInputV1Schema.parse(body).artifactIds).toEqual([roleId]);
      privateReads.push(path);
      return { status: 200, data: ArtifactReadBatchResponseV1Schema.parse({ items: [
        { artifactId: roleId, ok: true, artifact: stored, recipientCensus: null },
      ] }) };
    });
    try {
      const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'private-role-session', mode: 'plain', ctx: null,
        readRoleSources: createRoleSourceReaderV1({ artifactStore: createCredentialedAccountArtifactStore(credentials) }) });
      const request = { actionId, input: actionId === 'roles.get' ? { roleId } : {},
        context: { surface: 'cli', authority: 'present_user' } as const };
      const current = await deps.roleActionExecute?.(request);
      if (actionId === 'roles.get') expect(current).toMatchObject({ roleId, role });
      else expect(current).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ roleId, role })]) });
      // Retirement below must prevent both discovery and the selected private-body read.
      expect(privateReads).toEqual(actionId === 'roles.get' ? [`/v1/artifacts/${roleId}`] : ['/v1/artifacts', '/v1/artifacts/read']);
      privateReads.length = 0;
      clearActiveAccountSettingsSnapshot();
      publish(2);
      await expect(deps.roleActionExecute?.(request)).rejects.toMatchObject({
        code: 'account_role_overrides_unavailable', reason: 'scope-retired',
      });
      expect(privateReads).toEqual([]);
    } finally { post.mockRestore(); get.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });

  it.each([false, true])('demands the actual Account Role row only in the captured standalone Action lifetime (retired=%s)', async retired => {
    resetActiveAccountSettingsSnapshotForTests();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'role-first-demand-account' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings, rawSettings: {}, settingsVersion: 7,
      settingsSecretsReadKeys: [], loadedAtMs: 1 });
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    let nativePolicy: 'allow' | 'deny' = 'allow';
    // Home HTTP and the native/durable effects are the only replaced boundaries.
    // Row opening, demand, scoped publication, source and Role resolution remain real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain',
          v: key === 'role-overrides' ? { key, value: { v: 1, overrides: {
            builder: { roleId: 'builder', workspaceWrites: 'deny' },
          } } } : emptyPromptLibraryRecordV1(key) } })) } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected Role first-demand HTTP boundary: ${path}`);
    });
    try {
      const deps = createCliActionDeps({ token, credentials, sessionId: 'bound-role-session', mode: 'plain', ctx: null,
        getCurrentSessionMetadata: () => ({ path: '/repo', machineId: 'machine' }),
        readRoleSources: createRoleSourceReaderV1({}),
        prepareWorkspaceWritesPolicy: async policy => { nativePolicy = policy; return { ok: true }; },
        stageSessionStateMutation: async mutation => { queued.push(mutation); },
      });
      expect(readActiveAccountRoleOverrides({ scopeKey, lifetimeToken }))
        .toEqual({ status: 'unavailable', reason: 'catalog-unobserved' });
      if (retired) {
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings, rawSettings: {}, settingsVersion: 7,
          settingsSecretsReadKeys: [], loadedAtMs: 2 });
        await expect(deps.roleActionExecute?.({ actionId: 'session.role.set',
          input: { sessionId: 'bound-role-session', roleId: 'builder' },
          context: { surface: 'cli', authority: 'present_user' } })).rejects.toMatchObject({ code: 'account_role_overrides_unavailable' });
        expect(nativePolicy).toBe('allow');
        expect(queued).toEqual([]);
        expect(readActiveAccountRoleOverrides({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() }))
          .toEqual({ status: 'unavailable', reason: 'catalog-unobserved' });
        return;
      }
      await expect(deps.roleActionExecute?.({ actionId: 'session.role.set',
        input: { sessionId: 'bound-role-session', roleId: 'builder' },
        context: { surface: 'cli', authority: 'present_user' } })).resolves.toEqual({ updated: true });
      expect(nativePolicy).toBe('deny');
      expect(queued).toMatchObject([{ fieldId: 'intent.role', op: { kind: 'set', value: 'builder' } }]);
      expect(readActiveAccountRoleOverrides({ scopeKey, lifetimeToken })).toMatchObject({ status: 'ready',
        overrides: { builder: { workspaceWrites: 'deny' } } });
    } finally { get.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });

  it('refuses a fresh child snapshot when the real Role source inventory is partial', async () => {
    const { params, sessionId, cleanup } = callerSessionFixture();
    try {
      const deps = createCliActionDeps({ ...params,
        readRoleSources: createRoleSourceReaderV1({ accountId: 'account-1',
          readRawAccountSettings: async () => { throw new Error('Settings storage unavailable'); } }),
      });
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toBeNull();
    } finally { cleanup(); }
  });

  it('fails closed for malformed Session origins before forwarding an admitted own-Session role edit', async () => {
    const { params, sessionId, metadata, settings, cleanup } = callerSessionFixture();
    const forwarded: Parameters<SessionActionRpcTransport>[0][] = [];
    try {
      const deps = createCliActionDeps({ ...params,
        readRoleSources: createRoleSourceReaderV1({}),
        // The network port is the only effect boundary; role resolution,
        // caller opening, Action admission and origin validation remain real.
        sessionActionRpcTransport: async (request) => { forwarded.push(request); return { updated: true }; },
      });
      const agentStartContext = resolveCliAgentStartContextV1({ sessionId, metadata,
        machineId: metadata.machineId, directory: metadata.path, backendTarget: metadata.backendTarget,
        starterDepth: 2, turnDepth: 3, callerPermissionMode: 'default', settings,
        roleSourceInventory: await createRoleSourceReaderV1({})(),
        accountRoleOverrides: { status: 'ready', overrides: {} } });
      if (!agentStartContext || agentStartContext.caller.kind !== 'session') throw new Error('invalid host caller fixture');
      const context: ActionExecutorContext = {
        surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId,
        actionCaller: agentStartContext.caller, agentStartContext,
        callerPermissionMode: 'default', actionRequestId: 'original-request',
      };
      const executor = createActionExecutor(deps);
      const input = { sessionId, notes: 'Coordinate' };
      for (const source of [undefined, null, 'untrusted-origin', 1, true,
        { sourceSessionId: 'foreign-session', sourceTurnId: 'original-turn' }]) {
        expect(await executor.execute('session.notes.set', input, { ...context, sessionInputSource: source }))
          .toMatchObject({ ok: false, errorCode: 'role_rpc_origin_unavailable', error: 'role_rpc_origin_unavailable' });
        expect(forwarded).toEqual([]);
      }
      expect(await executor.execute('session.notes.set', input, { ...context,
        sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'original-turn' } }))
        .toEqual({ ok: true, result: { updated: true } });
      expect(forwarded).toMatchObject([{ sessionId, method: 'session.notes.set', input,
        origin: { v: 1, caller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 },
          sourceTurnId: 'original-turn', requestId: 'original-request', callerPermissionMode: 'default' } }]);
    } finally { cleanup(); }
  });

  it('uses the exact caller Session instead of the global executor host snapshot', async () => {
    // The authenticated runner owner proves liveness; Home's heartbeat
    // projection can lag and must not become a second admission decision.
    const { params, sessionId, cleanup } = callerSessionFixture('/caller/repo', 2, false);
    try {
      const deps = createCliActionDeps({ ...params, getCurrentTurnWorkDepth: () => 3 });
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toMatchObject({
        caller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 },
        baseline: { machineId: 'caller-machine', directory: '/caller/repo',
          configuration: { agentTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } },
        workDepthLimit: 7,
      });
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: 'foreign-session',
        callerPermissionMode: 'default' })).resolves.toBeNull();
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'host' }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toBeNull();
    } finally { cleanup(); }
  });

  it('retains original admitted depths for replay while rebuilding the current baseline', async () => {
    const { params, sessionId, cleanup } = callerSessionFixture('/current/repo', 4);
    try {
      const replayDeps = createCliActionDeps(params);
      await expect(replayDeps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toMatchObject({
        caller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 },
        baseline: { directory: '/current/repo', machineId: 'caller-machine' }, workDepthLimit: 7,
      });
    } finally { cleanup(); }
  });
});
