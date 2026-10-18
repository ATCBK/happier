import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import {
  API_TOKEN_FULL_GRANT_V1,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  verifyExternalActionMachineRequestV1,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionFollowActionDeps, createSessionTrackedTargetCompatibilityDep } from './sessionFollowActionDeps';

describe('released tracked-target compatibility', () => {
  it('qualifies bare ids to the fixed Home and preserves notification preferences', async () => {
    const replaceSessionVoiceInclusions = vi.fn(async () => ({ ok: true }));
    const dep = createSessionTrackedTargetCompatibilityDep({ serverId: 'home-a', replaceSessionVoiceInclusions });

    await expect(dep.sessionTargetTrackedSet!({
      sessionIds: ['session-1'],
      context: {},
    })).resolves.toMatchObject({
      ok: true,
      sessionAddresses: [{ serverId: 'home-a', sessionId: 'session-1' }],
    });
    expect(replaceSessionVoiceInclusions).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ['session-1'] }));
  });

  it('fails an exact-address request for another Home before a Follow read', async () => {
    const replaceSessionVoiceInclusions = vi.fn();
    const dep = createSessionTrackedTargetCompatibilityDep({ serverId: 'home-a', replaceSessionVoiceInclusions });
    await expect(dep.sessionTargetTrackedSet!({
      sessionAddresses: [{ serverId: 'home-b', sessionId: 'session-1' }],
      context: {},
    })).resolves.toMatchObject({ ok: false, status: 'unavailable' });
    expect(replaceSessionVoiceInclusions).not.toHaveBeenCalled();
  });

  it('replaces with an empty set after the compatibility adapter is recreated', async () => {
    type ReplaceSessionVoiceInclusionsRequest = Parameters<
      Parameters<typeof createSessionTrackedTargetCompatibilityDep>[0]['replaceSessionVoiceInclusions']
    >[0];
    const requests: ReplaceSessionVoiceInclusionsRequest[] = [];
    const replaceSessionVoiceInclusions = async (request: ReplaceSessionVoiceInclusionsRequest) => {
      requests.push(request);
      return { ok: true };
    };
    const first = createSessionTrackedTargetCompatibilityDep({ serverId: 'home-a', replaceSessionVoiceInclusions });
    await first.sessionTargetTrackedSet!({ sessionIds: ['session-1'], context: {} });
    const recreated = createSessionTrackedTargetCompatibilityDep({ serverId: 'home-a', replaceSessionVoiceInclusions });
    await recreated.sessionTargetTrackedSet!({ sessionIds: [], context: {} });
    expect(requests.map((request) => request.sessionIds)).toEqual([
      ['session-1'],
      [],
    ]);
  });
});

describe('Follow HTTP family adapter', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => { app = fastify(); restore = installAxiosFastifyAdapter({ app, origin: 'http://follow.test' }); });
  afterEach(async () => { restore(); await app.close(); });
  it.each([
    { actionId: 'session.follow.get', method: 'GET', path: '/v2/sessions/:sessionId/follow', input: { sessionId: 'session-1' } },
    { actionId: 'session.follow.sources.list', method: 'GET', path: '/v2/sessions/:sessionId/follows/sessions', input: { destinationSessionId: 'session-1' } },
  ] as const)('preserves strict credential scope refusals for $actionId', async ({ actionId, method, path, input: actionInput }) => {
    app.route({ method, url: path, handler: async (_request, reply) => reply.code(403).send({ error: 'credential_scope_denied' }) });
    const deps = createSessionFollowActionDeps({ token: 'token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId, input: actionInput, serverId: 'home' }))
      .resolves.toEqual({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' });
  });
  it.each([
    { error: 'credential_scope_denied', details: { sessionId: 'private' } },
    { error: 'unknown_denial' },
  ])('keeps malformed or unknown 403s closed', async (payload) => {
    app.get('/v2/sessions/:sessionId/follows/sessions', async (_request, reply) => reply.code(403).send(payload));
    const deps = createSessionFollowActionDeps({ token: 'token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'session.follow.sources.list', input: { destinationSessionId: 'session-1' }, serverId: 'home' }))
      .rejects.toMatchObject({ response: { status: 403 } });
  });
  it('rejects a fixed Home endpoint without its matching Home identity', () => {
    const partialFixedHome = { token: 'token', serverHttpBaseUrl: 'http://follow.test' };
    // @ts-expect-error -- Untyped JavaScript callers can still provide a partial fixed-Home binding.
    expect(() => createSessionFollowActionDeps(partialFixedHome)).toThrow('fixed_action_server_target_incomplete');
  });
  it('uses the declared verb, encodes path IDs and sends only the strict replacement body', async () => {
    const prepareSourceKeyAfterSet = vi.fn().mockResolvedValue({ kind: 'prepared' });
    app.put('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId', async (request) => {
      expect(request.params).toEqual({ destinationSessionId: 'dest/one', sourceSessionId: 'src/two' });
      expect(request.body).toEqual({});
      expect(request.headers.authorization).toBe('Bearer token');
      return { changed: true, source: { sourceSessionId: 'src/two', destinationSessionId: 'dest/one', deliveryState: 'eligible', hasPendingUpdates: false } };
    });
    const deps = createSessionFollowActionDeps({
      token: 'token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://follow.test',
      prepareSourceKeyAfterSet,
    });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'session.follow.sources.set', serverId: 'home', input: { sourceSessionId: 'src/two', destinationSessionId: 'dest/one' } })).resolves.toMatchObject({ changed: true });
    expect(prepareSourceKeyAfterSet).toHaveBeenCalledWith({
      sourceSessionId: 'src/two',
      destinationSessionId: 'dest/one',
      context: {},
    });
  });
  it('uses the one-shot external execution authorization without disclosing the daemon bearer', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const authorization: ExternalActionExecutionAuthorizationV1 = {
      v: 1,
      token: 'execution-proof',
      binding: {
        serverIdentityId: 'home', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1', actionId: 'session.follow.preferences.get', requestId: 'request-1',
        requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    };
    app.get('/v2/account/session-follow-preferences', async (request) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('execution-proof');
      expect(request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('session.follow.preferences.get');
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: authorization.token,
        effectActionId: 'session.follow.preferences.get',
        target,
        installationId: 'installation-1',
        requestId: authorization.binding.requestId,
        method: 'GET',
        path: '/v2/account/session-follow-preferences',
        publicKey: keyPair.publicKey,
        signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
      })).toBe(true);
      return { assigned: true, direct: false, team: false, group: false };
    });
    const deps = createSessionFollowActionDeps({
      token: 'daemon-token',
      serverId: 'home',
      serverIdentityId: 'home',
      serverHttpBaseUrl: 'http://follow.test',
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
      externalActionMachineInstallationId: 'installation-1',
    });
    await deps.sessionFollowAction!({
      context: {
        externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: authorization.binding.grant },
        externalActionExecutionAuthorization: authorization,
        externalActionTarget: target,
      },
      actionId: 'session.follow.preferences.get',
      serverId: 'home',
      input: {},
    });
  });
  it('binds an external Follow authorization to the observed Home identity, not its local profile id', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const authorization: ExternalActionExecutionAuthorizationV1 = {
      v: 1,
      token: 'execution-proof',
      binding: {
        serverIdentityId: 'srv-cryptographic-home', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1', actionId: 'session.follow.preferences.get', requestId: 'request-1',
        requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    };
    let reached = 0;
    app.get('/v2/account/session-follow-preferences', async () => {
      reached += 1;
      return { assigned: true, direct: false, team: false, group: false };
    });
    const deps = createSessionFollowActionDeps({
      token: 'daemon-token',
      serverId: 'local-profile-id',
      serverIdentityId: 'srv-cryptographic-home',
      serverHttpBaseUrl: 'http://follow.test',
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
      externalActionMachineInstallationId: 'installation-1',
    });
    await expect(deps.sessionFollowAction!({
      context: { externalActionExecutionAuthorization: authorization, externalActionTarget: target },
      actionId: 'session.follow.preferences.get',
      serverId: 'local-profile-id',
      input: {},
    })).resolves.toMatchObject({ assigned: true });
    expect(reached).toBe(1);
  });
  it('retains external invocation authority while preparing a committed Follow source key', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'session' as const, sessionId: 'destination' };
    const authorization: ExternalActionExecutionAuthorizationV1 = {
      v: 1,
      token: 'execution-proof',
      binding: {
        serverIdentityId: 'home', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1', actionId: 'session.follow.sources.set', requestId: 'request-1',
        requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    };
    app.put('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId', async (request) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: authorization.token,
        effectActionId: 'session.follow.sources.set',
        target,
        installationId: 'installation-1',
        requestId: authorization.binding.requestId,
        method: 'PUT',
        path: '/v2/sessions/destination/follows/sessions/source',
        body: {},
        publicKey: keyPair.publicKey,
        signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
      })).toBe(true);
      return {
        changed: true,
        source: { sourceSessionId: 'source', destinationSessionId: 'destination', deliveryState: 'eligible', hasPendingUpdates: true },
      };
    });
    const prepareSourceKeyAfterSet = vi.fn().mockResolvedValue({ kind: 'prepared' });
    const deps = createSessionFollowActionDeps({
      token: 'daemon-token',
      serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'http://follow.test',
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
      externalActionMachineInstallationId: 'installation-1',
      prepareSourceKeyAfterSet,
    });
    const context = {
        externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: authorization.binding.grant },
        externalActionExecutionAuthorization: authorization,
        externalActionTarget: target,
      };
    await expect(deps.sessionFollowAction!({
      context,
      actionId: 'session.follow.sources.set', serverId: 'home',
      input: { sourceSessionId: 'source', destinationSessionId: 'destination' },
    })).resolves.toMatchObject({ changed: true });
    expect(prepareSourceKeyAfterSet).toHaveBeenCalledWith({
      sourceSessionId: 'source', destinationSessionId: 'destination',
      context,
    });
  });
  it('keeps the committed edge successful when optional key preparation is unavailable', async () => {
    app.put('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId', async () => ({
      changed: true,
      source: { sourceSessionId: 'source', destinationSessionId: 'destination', deliveryState: 'eligible', hasPendingUpdates: true },
    }));
    const deps = createSessionFollowActionDeps({
      token: 'token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://follow.test',
      prepareSourceKeyAfterSet: vi.fn().mockResolvedValue({ kind: 'waiting', reason: 'runner_unreachable' }),
    });

    await expect(deps.sessionFollowAction!({
      context: {},
      actionId: 'session.follow.sources.set',
      serverId: 'home',
      input: { sourceSessionId: 'source', destinationSessionId: 'destination' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_follow_source_key_preparation_waiting',
      error: 'session_follow_source_key_preparation_waiting',
      details: {
        status: 'waiting',
        reason: 'runner_unreachable',
        edgeCommitted: true,
        source: {
          sourceSessionId: 'source',
          destinationSessionId: 'destination',
          deliveryState: 'eligible',
          hasPendingUpdates: true,
          mode: 'next_turn',
        },
      },
    });
  });
  it('does not swallow an unexpected preparation exception after the edge commits', async () => {
    app.put('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId', async () => ({
      changed: true,
      source: { sourceSessionId: 'source', destinationSessionId: 'destination', deliveryState: 'eligible', hasPendingUpdates: false },
    }));
    const deps = createSessionFollowActionDeps({
      token: 'token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://follow.test',
      prepareSourceKeyAfterSet: vi.fn().mockRejectedValue(new Error('unexpected preparation failure')),
    });

    await expect(deps.sessionFollowAction!({
      context: {},
      actionId: 'session.follow.sources.set',
      serverId: 'home',
      input: { sourceSessionId: 'source', destinationSessionId: 'destination' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'session_follow_source_key_preparation_waiting',
      details: { status: 'waiting', edgeCommitted: true },
    });
  });
  it('does not activate source-key delivery without a Lane 09 preparation request backed by Lane 13 verified Machine material', async () => {
    let unexpectedFollowupReads = 0;
    app.put('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId', async () => ({
      changed: true,
      source: { sourceSessionId: 'source', destinationSessionId: 'destination', deliveryState: 'eligible', hasPendingUpdates: true },
    }));
    app.setNotFoundHandler(async (_request, reply) => {
      unexpectedFollowupReads += 1;
      return await reply.code(404).send({ error: 'not_found' });
    });
    const legacyImplicitCredentials = {
      token: 'token',
      credentials: { token: 'token', encryption: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) } },
      serverId: 'home',
      serverHttpBaseUrl: 'http://follow.test',
    };
    const deps = createSessionFollowActionDeps(legacyImplicitCredentials);

    await expect(deps.sessionFollowAction!({
      context: {},
      actionId: 'session.follow.sources.set',
      serverId: 'home',
      input: { sourceSessionId: 'source', destinationSessionId: 'destination' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'session_follow_source_key_preparation_waiting',
      details: {
        status: 'waiting',
        reason: 'source_key_unavailable',
        edgeCommitted: true,
      },
    });
    expect(unexpectedFollowupReads).toBe(0);
  });
  it('rejects wrong Home before disclosure and preserves domain failures', async () => {
    app.get('/v2/account/session-follow-preferences', async (_request, reply) => reply.code(403).send({ error: 'account_inactive' }));
    const deps = createSessionFollowActionDeps({ token: 'token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'session.follow.preferences.get', serverId: 'other', input: {} })).resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'session.follow.preferences.get', serverId: 'home', input: {} })).resolves.toEqual({ ok: false, errorCode: 'account_inactive', error: 'account_inactive' });
  });
  it('rejects a valid projection for a different Session', async () => {
    app.get('/v2/sessions/:sessionId/follow', async () => ({
      follow: {
        sessionId: 'other',
        following: true,
        notificationLevel: 'none',
        includeInVoice: true,
      },
      isSessionOwner: false,
      capabilities: { manageFollow: true },
      voiceInitialSnapshotPending: false,
    }));
    const deps = createSessionFollowActionDeps({ token: 'token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'session.follow.get', serverId: 'home', input: { sessionId: 'target' } })).rejects.toThrow('session_follow_response_target_mismatch');
  });
});
