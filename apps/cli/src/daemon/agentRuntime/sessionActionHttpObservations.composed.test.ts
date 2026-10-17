import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import {
  accountSettingsParse, normalizeActionsSettingsV1, SessionListQueryV1Schema, SessionListQueryResponseV1Schema,
} from '@happier-dev/protocol';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions';
import { parseSessionListQueryActionResultV1 } from '@happier-dev/protocol/sessions/awareness/action';
import { auth } from '../../../../server/sources/app/auth/auth';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { installedSessionExternalActionStorage as storage } from '../../../../server/sources/app/api/testkit/installedSessionExternalActionStorage';
import { registerExternalActionRoutes } from '../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import type { Fastify } from '../../../../server/sources/app/api/types';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { prepareExternalActionRequesterAccountAuthorization, resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { createSessionListActionDependency } from '@/session/actions/sessionListActionDependency';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import { logger } from '@/ui/logger';
import { createDaemonSessionAccountActionExecutor } from './createDaemonSessionAccountActionExecutor';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';

// Only database I/O and HTTP delivery are substituted. Home issuance, signature
// verification, Session custody, scope admission and the transport readers run.
vi.mock('../../../../server/sources/storage/db', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../server/sources/storage/db')>(),
  db: (await import('../../../../server/sources/app/api/testkit/installedSessionExternalActionStorage')).installedSessionExternalActionStorage.db,
}));

const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
const sessionId = 'c123456789012345678901230';
const childId = 'c123456789012345678901231';
const serverId = 'signed-session-home';
const serverHttpBaseUrl = 'https://signed-session.test';
type Operation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;

beforeAll(async () => {
  vi.stubEnv('HANDY_MASTER_SECRET', 'session-observation-test-secret');
  vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
  await auth.init();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => vi.unstubAllEnvs());

async function fixture() {
  storage.state.sessionId = sessionId;
  storage.state.bound = true;
  storage.state.publisherBound = true;
  storage.state.revokedAt = null;
  storage.state.publicKey = installation.publicKey;
  const token = await auth.createToken(storage.account.id, undefined, { kind: 'account', authority: 'present_user' });
  const credentials = { token, encryption: null };
  const app: Fastify = createAuthenticatedTestApp({ authentication: 'real' });
  app.decorate('resolveCurrentSessionMachine', async () => storage.state.bound ? storage.state.machineId : null);
  registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Unexpected external dispatch'); } });
  const observations: { method: string; path: string; status: number; code?: string; signed: boolean; bearer: boolean }[] = [];
  app.addHook('onSend', async (request, reply, payload) => {
    let code: string | undefined;
    if (reply.statusCode >= 400 && typeof payload === 'string') {
      const body: unknown = JSON.parse(payload);
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      if (error === 'invalid_token' || error === 'credential_scope_denied') code = error;
    }
    observations.push({ method: request.method, path: request.url, status: reply.statusCode,
      ...(code ? { code } : {}),
      signed: typeof request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'string',
      bearer: request.headers.authorization !== undefined });
    return payload;
  });
  const members = new Set([childId]);
  let currentnessRefused = false;
  const row = (id: string) => ({ ...createSessionNotificationContextFixture(id), encryptionMode: 'plain' as const,
    metadata: JSON.stringify({ machineId: storage.state.machineId, path: '/workspace', flavor: 'codex' }), active: true,
    ...(id === childId ? { reportsTo: { sessionId } } : {}) });
  app.get('/v1/account/encryption/currentness', { preHandler: app.authenticate }, async (_request, reply) =>
    currentnessRefused ? reply.code(401).send({ error: 'private-error-body' }) : createAccountEncryptionCurrentnessFixture());
  app.get('/v2/account/settings', { preHandler: app.authenticate }, async () => ({ version: 1, content: { t: 'plain', v: {} } }));
  app.post('/v2/sessions/query', { preHandler: app.authenticate }, async request => {
    const query = SessionListQueryV1Schema.parse(request.body);
    expect(query.underSessionId).toBe(sessionId);
    return SessionListQueryResponseV1Schema.parse({ sessions: query.storage === 'active' ? [...members].map(row) : [],
      nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
  });
  app.get('/v2/sessions/:sessionId', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.status.get', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async request => ({ session: row((request.params as { sessionId: string }).sessionId) }));
  app.get('/v1/sessions/:sessionId/messages', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.messages.recent.get', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async () => ({ messages: [{ id: 'message-child', seq: 1, localId: null, sidechainId: null, createdAt: 1, updatedAt: 1,
    messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Child ready' } } } }],
    hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }));
  app.post('/v2/sessions/:sessionId/archive', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.archive', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async () => ({ success: true }));
  const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
  // The incumbent host supplies its launch snapshot; this producer does not
  // grant subtree membership. The real scope owner must still read Home fresh.
  const agentStartContext = resolveCliAgentStartContextV1({ sessionId, machineId: storage.state.machineId, directory: '/workspace',
    backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, metadata: {},
    starterDepth: 0, turnDepth: 0, callerPermissionMode: 'default', settings: accountSettingsParse({}), roles: {} });
  if (!agentStartContext) throw new Error('Missing host launch snapshot');
  const prepare = async (operation: Pick<Operation, 'actionId' | 'input' | 'requestId'>,
    sessionActionOrigin: Parameters<typeof prepareExternalActionRequesterAccountAuthorization>[0]['sessionActionOrigin']) => {
    const target = { kind: 'machine' as const, machineId: storage.state.machineId };
    const authorization = await prepareExternalActionRequesterAccountAuthorization({ ...operation,
      target, machineId: storage.state.machineId, sourceMachineId: storage.state.machineId,
      accountId: storage.account.id, accountEncryptionMode: 'plain', tokenEpochHint: 1, token,
      serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
      installationId: storage.state.installationId, privateKey: installation.secretKey, sessionActionOrigin });
    if (!authorization) return null;
    ExternalActionExecutionAuthorizationV1Schema.parse(authorization);
    return { authorization, target };
  };
  const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl, token, credentials,
    machineId: storage.state.machineId,
    prepareExternalActionAuthorization: ({ operation, sessionActionOrigin }) => prepare(operation, sessionActionOrigin),
    createExecutor: () => {
      const executor = createCliActionExecutor({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
        serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
        externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId,
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }),
          getAccountSettings: () => accountSettingsParse({}) },
      });
      return { execute: (id, input, context) => executor.execute(id, input, { ...context, agentStartContext }) };
    },
  });
  const operation = (actionId: Operation['actionId'], input: Operation['input']): Operation => ({ kind: 'action.execute',
    actionId, input, requestId: 'signed-observation', surface: 'agent',
    witness: { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } } });
  return { credentials, app, observations, members, prepare, execute, operation,
    refuseCurrentness: () => { currentnessRefused = true; },
    close: async () => { restore(); await app.close(); } };
}

it.each(['session.status.get', 'session.messages.recent.get'] as const)(
  'admits fresh subtree observation through the real daemon/Home preparer: %s', async actionId => {
  const f = await fixture();
  try {
    const run = () => f.execute(f.operation(actionId, { sessionId: childId }), { sessionId, isCurrent: async () => true });
    const result = await run();
    expect(result, JSON.stringify({ result, observations: f.observations })).toMatchObject(actionId === 'session.status.get'
      ? { ok: true, result: { session: { id: childId } } }
      : { ok: true, result: { sessionId: childId, items: [{ text: 'Child ready' }] } });
    const queries = f.observations.filter(row => row.path === '/v2/sessions/query');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(row => row.status === 200 && row.signed && !row.bearer)).toBe(true);
    f.members.clear();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  } finally { await f.close(); }
});

it.each(['session.status.get', 'session.messages.recent.get'] as const)(
  'signs the policy subtree read as %s at the production list owner', async actionId => {
  const f = await fixture();
  try {
    const op = f.operation(actionId, { sessionId: childId });
    const prepared = await f.prepare(op, { v: 1, caller: op.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: op.requestId });
    if (!prepared) throw new Error('Missing original root');
    const list = createSessionListActionDependency({ credentials: f.credentials, serverId,
      serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
      resolveAccountSettings: () => accountSettingsParse({}),
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId });
    const query = SessionListQueryV1Schema.parse({ v: 1, storage: 'active', includeInactive: true,
      scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [], underSessionId: sessionId });
    const context = { surface: 'agent' as const, defaultSessionId: sessionId, serverId,
      externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target };
    const result = parseSessionListQueryActionResultV1(await list({ context, query }));
    expect(result, JSON.stringify(f.observations)).toMatchObject({ sessions: [{ id: childId }], hasNext: false });
    const signed = f.observations.filter(row => row.signed);
    expect(signed.length).toBeGreaterThan(0);
    expect(signed.every(row => row.status === 200 && !row.bearer)).toBe(true);
    for (const path of [`/v2/sessions/${childId}`,
      ...(actionId === 'session.messages.recent.get' ? [`/v1/sessions/${childId}/messages`] : [])]) {
      const authorization = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId, method: 'GET', path,
        daemonToken: f.credentials.token, serverIdentityId: storage.state.homeId,
        privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!authorization.ok) throw new Error('Missing reader signature');
      const response = await f.app.inject({ method: 'GET', url: path, headers: authorization.headers });
      expect(response.statusCode, JSON.stringify(f.observations)).toBe(200);
    }
    const signedQuery = async (body: unknown, effectActionId = op.actionId) => {
      const authorization = resolveExternalActionServerRequestHeaders({ context,
        effectActionId, method: 'POST', path: '/v2/sessions/query', body, daemonToken: f.credentials.token,
        serverIdentityId: storage.state.homeId, privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!authorization.ok) throw new Error('Missing query signature');
      return f.app.inject({ method: 'POST', url: '/v2/sessions/query', payload: body, headers: authorization.headers });
    };
    const { underSessionId: _root, ...unscopedQuery } = query;
    for (const [body, effect] of [[{ ...query, underSessionId: childId }, op.actionId],
      [unscopedQuery, op.actionId], [query, 'session.list']] as const) {
      const refused = await signedQuery(body, effect);
      expect(refused.statusCode).toBe(401);
      expect(refused.json()).toMatchObject({ error: 'invalid_token' });
    }
    storage.state.bound = false;
    expect((await signedQuery(query)).statusCode).toBe(401);
  } finally { await f.close(); }
});

it.each(['session.spawn_new', 'session.follow.sources.set', 'session.reports_to.set'] as const)(
  'uses the original %s root for post-commit source/destination transport reads', async actionId => {
  const f = await fixture();
  try {
    const sourceSessionId = actionId === 'session.reports_to.set' ? sessionId : childId;
    const destinationSessionId = actionId === 'session.reports_to.set' ? childId : sessionId;
    const operation = f.operation(actionId, actionId === 'session.spawn_new'
      ? { creationKey: 'signed-source-key-child', executionTarget: { serverId, machineId: storage.state.machineId },
        directory: { kind: 'path', path: '/workspace' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        reportsTo: { sessionId } }
      : actionId === 'session.follow.sources.set' ? { sourceSessionId, destinationSessionId }
        : { sessionId: sourceSessionId, leadSessionId: destinationSessionId, expectedLeadSessionId: null });
    const prepared = await f.prepare(operation, { v: 1, caller: operation.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: operation.requestId });
    expect(prepared, JSON.stringify(f.observations)).not.toBeNull();
    if (!prepared) throw new Error('Missing Home root');
    const context = { surface: 'agent' as const, defaultSessionId: sessionId, serverId,
      externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target };
    const preparation = createSessionFollowSourceKeyPreparationAfterSet({ credentials: f.credentials,
      effectActionId: actionId, serverHttpBaseUrl, serverIdentityId: storage.state.homeId,
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId });
    expect(await preparation({ sourceSessionId, destinationSessionId, context }), JSON.stringify(f.observations))
      .toEqual({ kind: 'not_needed' });
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    f.refuseCurrentness();
    expect(await preparation({ sourceSessionId, destinationSessionId, context }))
      .toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'source_transport_exception' });
    expect(diagnostics).toHaveBeenCalledWith('[Session Follow source-key preparation] Transport refused', {
      cause: 'source_transport_exception', httpStatus: 401, errorCode: 'not_authenticated',
    });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private-error-body');
    // The root cannot be spent on unrelated Account operations or Session writes.
    for (const request of [{ method: 'GET', path: '/v2/account/settings' },
      { method: 'POST', path: `/v2/sessions/${sessionId}/archive` }]) {
      const headers = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId, ...request,
        daemonToken: f.credentials.token, serverIdentityId: storage.state.homeId,
        privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!headers.ok) throw new Error('Missing signed headers');
      const response = await f.app.inject({ method: request.method as 'GET' | 'POST', url: request.path, headers: headers.headers });
      expect(response.statusCode).toBe(401);
    }
  } finally { await f.close(); }
});
