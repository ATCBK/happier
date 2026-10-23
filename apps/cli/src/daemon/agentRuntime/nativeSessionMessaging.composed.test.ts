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
