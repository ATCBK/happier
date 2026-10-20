import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as bootstrap from './sessionRequesterBootstrapV1.js';
import { SessionHandoffPrepareTargetRequestSchema } from '../control/handoff/handoffSchemas.js';
import { ExternalActionExecutionAuthorizationV1Schema } from '../../actions/externalActionApi.js';
import { RPC_METHODS } from '../../rpc/methods.js';

const request = {
  kind: 'requester_session_bootstrap_v1',
  input: {
    executionTarget: { serverId: 'home', machineId: 'machine' },
    directory: { kind: 'path', path: '/workspace' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
  },
  requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: {
    token: 'private-bob-token', secret: Buffer.from(new Uint8Array(32).fill(8)).toString('base64'),
  } },
} as const;

describe('requester bootstrap installation confidentiality', () => {
  it('retains the reviewed second-opinion root when sealing exact public spawn custody to its selected installation', () => {
    const recipient = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'opinion-root', binding: {
      accountId: 'bob', custodianAccountId: 'source-owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: 'source', installationId: 'source-installation', accountEncryptionMode: 'plain',
      actionId: 'discussion.second_opinion.start', requestId: 'opinion', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'source' },
    } });
    const purpose = { kind: 'machine_rpc', method: RPC_METHODS.SESSION_SPAWN_NEW, params: request.input,
      recipient: { machineId: 'machine', installationId: 'recipient-installation' } } as const;
    const credentials = { token: 'bob-private', secret: null, encryption: null };
    const sealed = bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials, purpose,
      installationPublicKey: recipient.publicKey, randomBytes: tweetnacl.randomBytes });
    const input = { authorization: sealed, purpose, machineId: 'machine', installationId: 'recipient-installation',
      serverIdentityId: 'home', installationPrivateKey: recipient.secretKey };
    expect(sealed.binding).toEqual(authorization.binding);
    expect(bootstrap.openExternalActionRequesterAccountContextV1(input)).toEqual(credentials);
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { ...purpose,
      params: { ...request.input, directory: { kind: 'path', path: '/unreviewed' } } } })).toBeNull();
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { ...purpose,
      method: RPC_METHODS.SPAWN_HAPPY_SESSION } })).toBeNull();
    expect(() => bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials,
      purpose: { ...purpose, method: RPC_METHODS.SPAWN_HAPPY_SESSION },
      installationPublicKey: recipient.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
  });
  it('seals finite Sync preparation only to its named controller and exact request while retaining the worker root', () => {
    const worker = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4));
    const controller = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'finite-root', binding: {
      accountId: 'bob', custodianAccountId: 'owner', authentication: { kind: 'terminal', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: 'worker', installationId: 'worker-installation', accountEncryptionMode: 'plain',
      actionId: 'projects.script.run', requestId: 'run', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'worker' },
    } });
    const purpose = { kind: 'workspace_sync_prepare', controller: { machineId: 'controller', installationId: 'controller-installation' },
      request: { sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'target' } } as const;
    const credentials = { token: 'bob-private', secret: null, encryption: null };
    const sealed = bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials, purpose,
      installationPublicKey: controller.publicKey, randomBytes: tweetnacl.randomBytes });
    expect(sealed.binding).toEqual(authorization.binding);
    expect(sealed.requesterAccountContext?.installationId).toBe('controller-installation');
    const input = { authorization: sealed, purpose, machineId: 'controller', installationId: 'controller-installation',
      serverIdentityId: 'home', installationPrivateKey: controller.secretKey };
    expect(bootstrap.openExternalActionRequesterAccountContextV1(input)).toEqual(credentials);
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { ...purpose,
      request: { ...purpose.request, targetWorkspaceRefId: 'substituted' } } })).toBeNull();
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { kind: 'external_action' },
      machineId: 'worker', installationId: 'worker-installation', installationPrivateKey: worker.secretKey })).toBeNull();
    expect(() => bootstrap.sealExternalActionRequesterAccountContextV1({ authorization: { ...authorization,
      binding: { ...authorization.binding, actionId: 'projects.open' } }, credentials, purpose,
      installationPublicKey: controller.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
  });
  it('seals a read-only handoff preflight without transfer custody and refuses changed Session input', () => {
    const preflight = { kind: 'requester_session_handoff_preflight_bootstrap_v1', input: {
      sessionId: 'same-session', sourceMachineId: 'source', targetMachineId: 'machine',
      sourceSessionStorageMode: 'persisted', targetPath: '/destination',
    }, requesterBootstrap: request.requesterBootstrap } as const;
    const seal = Reflect.get(bootstrap, 'sealSessionRequesterHandoffPreflightBootstrapRpcRequestV1');
    const open = Reflect.get(bootstrap, 'openSessionRequesterHandoffPreflightBootstrapRpcRequestV1');
    expect(typeof seal).toBe('function');
    expect(typeof open).toBe('function');
    if (typeof seal !== 'function' || typeof open !== 'function') throw new Error('Missing private preflight carrier');
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const sealed = seal({ request: preflight, installationId: 'installation',
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.token);
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.secret);
    const read = (value: unknown, installationId = 'installation') => open({ request: value, machineId: 'machine',
      installationId, installationPrivateKey: installation.secretKey });
    expect(read(sealed)).toEqual(preflight);
    expect(read(sealed, 'replacement')).toBeNull();
    expect(read({ ...sealed, input: { ...preflight.input, sessionId: 'another-session' } })).toBeNull();
    expect(bootstrap.openSessionRequesterHandoffBootstrapRpcRequestV1({ request: sealed, machineId: 'machine',
      installationId: 'installation', installationPrivateKey: installation.secretKey })).toBeNull();
  });
  it('seals the existing-Session handoff on the same installed-key carrier without changing its identity', () => {
    const handoff = { kind: 'requester_session_handoff_bootstrap_v1', input: {
      handoffId: 'handoff', operationId: 'operation', sessionId: 'same-session',
      sourceMachineId: 'source', targetMachineId: 'machine', sourceSessionStorageMode: 'persisted',
      negotiatedTransportStrategy: 'server_routed_stream', targetPath: '/destination', endpointCandidates: [],
    }, requesterBootstrap: request.requesterBootstrap } as const;
    const seal = Reflect.get(bootstrap, 'sealSessionRequesterHandoffBootstrapRpcRequestV1');
    const open = Reflect.get(bootstrap, 'openSessionRequesterHandoffBootstrapRpcRequestV1');
    expect(typeof seal).toBe('function');
    expect(typeof open).toBe('function');
    if (typeof seal !== 'function' || typeof open !== 'function') throw new Error('Missing private handoff carrier');
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const sealed = seal({ request: handoff, installationId: 'installation',
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.token);
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.secret);
    const read = (value: unknown, installationId = 'installation', installationPrivateKey = installation.secretKey) =>
      open({ request: value, machineId: 'machine', installationId, installationPrivateKey });
    expect(read(sealed)).toEqual(handoff);
    expect(read(sealed, 'replacement')).toBeNull();
    expect(read(sealed, 'installation', tweetnacl.sign.keyPair().secretKey)).toBeNull();
    expect(read({ ...sealed, input: { ...handoff.input, sessionId: 'different-session' } })).toBeNull();
    expect(read({ ...sealed, input: { ...handoff.input, sourceMachineId: 'different-source' } })).toBeNull();
    expect(SessionHandoffPrepareTargetRequestSchema.safeParse({ ...handoff.input, predecessorExtension: true }).success).toBe(true);
    expect(() => seal({ request: { ...handoff, input: { ...handoff.input, predecessorExtension: true } },
      installationId: 'installation', installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
    expect(bootstrap.openSessionRequesterBootstrapRpcRequestV1({ request: sealed, machineId: 'machine',
      installationId: 'installation', installationPrivateKey: installation.secretKey })).toBeNull();
  });
  it('carries no requester sign-in bytes and opens only for the current exact installation and authored input', () => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const sealed = bootstrap.sealSessionRequesterBootstrapRpcRequestV1({ request,
      installationId: 'installation', installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    expect(bootstrap.SessionRequesterBootstrapRpcRequestV1Schema.safeParse(sealed).success).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.token);
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.secret);
    const open = (value: unknown, installationId = 'installation', installationPrivateKey = installation.secretKey) =>
      bootstrap.openSessionRequesterBootstrapRpcRequestV1({ request: value, machineId: 'machine', installationId, installationPrivateKey });
    expect(open(sealed)).toEqual(request);
    expect(open(sealed, 'replacement-installation')).toBeNull();
    expect(open(sealed, 'installation', tweetnacl.sign.keyPair().secretKey)).toBeNull();
    expect(open(sealed, 'installation', installation.secretKey.subarray(0, 32))).toBeNull();
    expect(open({ ...sealed, input: { ...request.input, directory: { kind: 'path', path: '/another' } } })).toBeNull();
    const ciphertext = sealed.requesterBootstrap.ciphertext;
    expect(open({ ...sealed, requesterBootstrap: { ...sealed.requesterBootstrap,
      ciphertext: `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}` } })).toBeNull();
  });

  it('rejects malformed or small-order installation keys before sealing sensitive material', () => {
    for (const installationPublicKey of [new Uint8Array(31), new Uint8Array(32)]) {
      expect(() => bootstrap.sealSessionRequesterBootstrapRpcRequestV1({ request, installationId: 'installation',
        installationPublicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
    }
  });
});
