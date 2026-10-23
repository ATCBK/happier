import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import * as controlServer from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createLightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { auth } from '../../../../server/sources/app/auth/auth';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { registerExternalActionRoutes } from '../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { machineUpdateHandler } from '../../../../server/sources/app/api/socket/machineUpdateHandler';
import { createFakeSocket, getSocketHandler, createSocketRoomDiscoveryHarness } from '../../../../server/sources/app/api/testkit/socketHarness';
import { qualifyCurrentAccountStoredContentSocket } from '../../../../server/sources/app/api/testkit/accountStoredContentCompatibility';
import { createSessionPublisherPresence } from '../../../../server/sources/app/presence/sessionPublisherPresence';
import { resolveCurrentSessionMachineFromServer } from '../../../../server/sources/app/api/socket/externalActionDispatcher';
import { getAccountSessionSocketRoom } from '../../../../server/sources/app/api/socketRooms';
import { getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SessionPendingEnqueueByMachineResponseV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { verifyExternalActionMachineRpcExecution } from '../../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { readSessionInputRequest } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('admits runtime-bound native messaging through the production daemon composition', async () => {
  let installed: Parameters<typeof controlServer.startDaemonControlServer>[0] | null = null;
  // Only the daemon listener and Home HTTP are external boundaries.
  vi.spyOn(controlServer, 'startDaemonControlServer').mockImplementation(async input => {
    installed = input;
    return { port: 43129, stop: async () => {} };
  });
  const h = await createInstalledProjectAgentDaemonFixture(() => installed, undefined, true, undefined, undefined, {
    credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`, encryption: null },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_messaging', machineId: 'machine' }),
  });
  const destination = `c${'d'.repeat(24)}`;
  let grantAllowed = true;
  const admitted: ReturnType<typeof SessionPendingEnqueueByMachineRequestV1Schema.parse>[] = [];
  // The canonical Machine client still builds and signs the real wire request.
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, raw) => {
    if (event !== SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1) throw new Error(`Unexpected Machine event: ${event}`);
    const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(raw);
    expect(request.sessionId).toBe(destination);
    expect(request.content).toMatchObject({ t: 'plain', v: { meta: {
      happierProvenanceV1: { kind: 'happierSession', sourceSessionId: h.sessionId, callerDepth: 3 },
      happierInputRequestV1: { sourceSession: { sourceSessionId: h.sessionId, sourceTurnId: 'source-turn', sourceInputId: 'source-input' },
        permission: { requestedPermissionCeiling: 'default' } },
    } } });
    const proof = request.externalAction;
    expect(proof).toBeDefined();
    const { externalAction: _proof, ...unsigned } = request;
    expect(proof && verifyExternalActionMachineRpcRequestV1({ authorizationToken: proof.authorization.token,
      effectActionId: proof.effectActionId, target: proof.target, installationId: proof.installationId,
      event, method: event, requestId: proof.authorization.binding.requestId, params: unsigned,
      publicKey: decodeBase64(h.f.installation.publicKey, 'base64url'), signature: proof.machineSignature })).toBe(true);
    admitted.push(request);
    return { v: 1, result: { status: 'accepted', localId: request.localId } };
  } });
  Reflect.set(h.machine, 'socket', socket);
  const homeRead = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    return homeRead(...args);
  });
  const homeWrite = vi.mocked(axios.post).getMockImplementation()!;
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('session.message.send')) {
      return { status: 200, data: { ok: true } };
    }
    if (path === bindExternalActionExecutionAuthorizationHttpPathV1('session.message.send')) {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
      expect(request.sessionActionOrigin?.caller.sessionId).toBe(h.sessionId);
      expect(request.sessionActionSource).toEqual({ machineId: 'machine', installationId: h.f.installation.installationId });
      if (!grantAllowed) return { status: 403, data: { error: 'credential_scope_denied' } };
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'messaging-proof', binding: {
        accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_messaging',
        machineId: 'machine', custodianAccountId: 'custodian', installationId: h.f.installation.installationId,
        actionId: 'session.message.send', requestId: request.envelope.requestId, target: request.envelope.target,
        accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } }) };
    }
    return homeWrite(...args);
  });
  const send = (reply: 'none' | 'wait' | 'return') => h.dispatch({ kind: 'action.execute', actionId: 'session.message.send',
    requestId: h.operationBase().requestId, input: { sessionId: destination, message: 'Native message', reply },
    witness: { turnId: 'source-turn', inputId: 'source-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 3,
      agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 3, turnDepth: 1 },
      callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
  });
  grantAllowed = false;
  for (const mode of ['none', 'wait', 'return'] as const) {
    expect(await send(mode)).toMatchObject({ ok: true, result: { outcome: { ok: false,
      errorCode: 'target_unavailable', details: { reason: 'external_authorization_refused' } } } });
  }
  expect(admitted).toEqual([]);
  grantAllowed = true;
  const reply = await send('none');
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: true,
    result: { status: 'accepted' },
  } } });
  expect(admitted).toHaveLength(1);
});

it('admits native messaging through the installed requester, real Home and Machine socket owner', async () => {
  const home = await createLightSqliteHarness({ tempDirPrefix: 'happier-n1-ab1-', initAuth: true,
    env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
  const app = createAuthenticatedTestApp({ authentication: 'real' });
  try {
    const account = await db.account.create({ data: { id: 'requester', encryptionMode: 'plain', publicKey: 'ab1-public' } });
    const token = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
    const authenticated = await auth.verifyTokenForRoute(token);
    if (!authenticated) throw new Error('Missing authenticated Machine fixture');
    let installed: Parameters<typeof controlServer.startDaemonControlServer>[0] | null = null;
    vi.spyOn(controlServer, 'startDaemonControlServer').mockImplementation(async input => {
      installed = input;
      return { port: 43129, stop: async () => {} };
    });
    const homeId = await getOrCreateServerIdentityId();
    const credentials = { token, encryption: null };
    const h = await createInstalledProjectAgentDaemonFixture(() => installed, undefined, true, undefined, undefined, {
      credentials, requesterCredentials: credentials,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
    });
    await db.machine.create({ data: { id: 'machine', accountId: account.id,
      installationId: h.f.installation.installationId, installationPublicKey: decodeBase64(h.f.installation.publicKey, 'base64url'),
      metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
      active: true, lastActiveAt: new Date(), operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
        sessionInputAdmission: { protocolVersions: [1, 2] } },
    } });
    const destination = `c${'e'.repeat(24)}`;
    for (const id of [h.sessionId, destination]) {
      await db.session.create({ data: { id, accountId: account.id, tag: id, encryptionMode: 'plain',
        metadata: JSON.stringify({ machineId: 'machine' }), active: true, lastActiveAt: new Date() } });
      await db.accessKey.create({ data: { accountId: account.id, machineId: 'machine', sessionId: id, data: 'opaque' } });
    }
    const publisher = createFakeSocket({ data: {} });
    const presence = createSessionPublisherPresence();
    expect((await presence.registerPublisher({ socket: publisher,
      binding: { accountId: account.id, machineId: 'machine', sessionId: h.sessionId },
      completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
    let discoverPublisher = true;
    const sourceRoom = getAccountSessionSocketRoom(account.id, h.sessionId);
    const publisherReads: string[] = [];
    const io = createSocketRoomDiscoveryHarness(async room => {
      publisherReads.push(room);
      return discoverPublisher && room === sourceRoom ? [publisher] : [];
    });
    app.decorate('resolveCurrentSessionMachine', (input: Readonly<{ accountId: string; sessionId: string }>) =>
      resolveCurrentSessionMachineFromServer({ io, presence, ...input }));
    registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Unexpected external relay'); } });
    const network = createFakeSocket({ nsp: { server: io }, data: { clientType: 'machine-scoped', machineId: 'machine',
      userId: authenticated.userId, authAuthority: authenticated.authority, authTokenKind: authenticated.authTokenKind,
      authTokenAuthenticationEvidence: authenticated.authenticationEvidence,
      verifiedMachineInstallationId: h.f.installation.installationId } });
    qualifyCurrentAccountStoredContentSocket(network);
    machineUpdateHandler(account.id, network as never, { sessionPublisherPresence: presence,
      resolveCurrentSessionMachine: app.resolveCurrentSessionMachine,
      operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } });
    const pending = getSocketHandler(network, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1);
    const packets: ReturnType<typeof SessionPendingEnqueueByMachineRequestV1Schema.parse>[] = [];
    Reflect.set(h.machine, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (event, raw) => {
      if (event !== SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1) throw new Error('Unexpected Machine event');
      const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(raw);
      packets.push(request);
      let response: unknown;
      const priorReads = publisherReads.length;
      await pending(request, (value: unknown) => { response = value; });
      // Two fresh source fences are already owned by the verifier; there is
      // no Account inventory, polling or duplicated receiver enumeration.
      expect(publisherReads.slice(priorReads).every(room => room === sourceRoom)).toBe(true);
      expect(publisherReads.length - priorReads).toBeLessThanOrEqual(2);
      return SessionPendingEnqueueByMachineResponseV1Schema.parse(response);
    } }));
    // Replace HTTP delivery only. The existing bootstrap endpoints remain the
    // fixture's network boundary; Home mint/verify execute their real handlers.
    const oldPost = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (!path.includes('/execution-authorization')) return oldPost(...args);
      const response = await app.inject({ method: 'POST', url: path, payload: args[1],
        headers: Object.fromEntries(Object.entries(args[2]?.headers ?? {}).map(([key, value]) => [key, String(value)])) });
      return { status: response.statusCode, data: response.json() };
    });
    const oldGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (...args) => new URL(String(args[0])).pathname.endsWith('/delivery-mutes')
      ? { status: 200, data: { scopes: [] } } : oldGet(...args));
    const attribution = deriveSessionInputActionRequestAttributionV1({ requestRef: 'source-input',
      persona: { serverId: 'session-home', sessionId: h.sessionId }, messageRole: 'user', origin: null,
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: account.id, sessionRelationship: 'owner' } });
    expect(attribution?.requester?.accountId).toBe(account.id);
    const send = () => h.dispatch({ kind: 'action.execute', actionId: 'session.message.send', requestId: h.operationBase().requestId,
      input: { sessionId: destination, message: 'Native Home input', reply: 'none' },
      witness: { turnId: 'source-turn', inputId: 'source-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
        actionRequestAttributionV1: attribution,
        agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 },
        callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
    });
    const outcome = await send();
    // Inspect only bounded outcome facts: never render a signed packet on failure.
    expect(packets).toHaveLength(1);
    expect(outcome).not.toMatchObject({ ok: true, result: { outcome: { ok: true,
      result: { status: 'rejected', code: 'session_input_unauthorized' } } } });
    expect(outcome).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: true,
      result: { status: 'accepted' } } } });
    expect(await db.sessionPendingMessage.count({ where: { sessionId: destination } })).toBe(1);
    const retained = await db.sessionPendingMessage.findFirstOrThrow({ where: { sessionId: destination }, select: { content: true } });
    const content = SessionPendingEnqueueByMachineRequestV1Schema.shape.content.parse(retained.content);
    if (content.t !== 'plain' || !content.v || typeof content.v !== 'object' || !('meta' in content.v)) {
      throw new Error('Missing retained plain input request');
    }
    expect(readSessionInputRequest(content.v.meta)?.actionRequestAttributionV1).toEqual(attribution);
    const packet = packets[0]!;
    if (!packet.externalAction) throw new Error('Missing installed Machine proof');
    const { externalAction, ...unsigned } = packet;
    const unwiredSocket = createFakeSocket({ nsp: { server: io }, data: { ...network.data } });
    machineUpdateHandler(account.id, unwiredSocket as never, {
      operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } },
    });
    let unwiredResponse: unknown;
    await getSocketHandler(unwiredSocket, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1)(packet,
      (value: unknown) => { unwiredResponse = value; });
    expect(unwiredResponse).toMatchObject({ result: { status: 'rejected', code: 'session_input_unauthorized' } });
    const proof = { event: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, method: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
      requestId: externalAction.authorization.binding.requestId, params: unsigned,
      resolveCurrentSessionMachine: app.resolveCurrentSessionMachine };
    // This missing producer→consumer binding is the original refusal, even
    // with the genuine root and Machine signature that just committed input.
    expect(await verifyExternalActionMachineRpcExecution(externalAction, { ...proof, resolveCurrentSessionMachine: undefined }) === null).toBe(true);
    expect(await verifyExternalActionMachineRpcExecution(externalAction, proof) !== null).toBe(true);
    let substituted: unknown;
    await pending({ ...packet, localId: 'substituted-input' }, (value: unknown) => { substituted = value; });
    expect(substituted).toMatchObject({ result: { status: 'rejected', code: 'session_input_unauthorized' } });
    discoverPublisher = false;
    let refused: unknown;
    await pending(packet, (value: unknown) => { refused = value; });
    expect(refused).toMatchObject({ result: { status: 'rejected', code: 'session_input_unauthorized' } });
    discoverPublisher = true;
    await db.accessKey.delete({ where: { accountId_machineId_sessionId: {
      accountId: account.id, machineId: 'machine', sessionId: h.sessionId,
    } } });
    await pending(packet, (value: unknown) => { refused = value; });
    expect(refused).toMatchObject({ result: { status: 'rejected', code: 'session_input_unauthorized' } });
    expect(await db.sessionPendingMessage.count({ where: { sessionId: destination } })).toBe(1);
  } finally {
    await app.close();
    await home.close();
  }
}, 120_000);
