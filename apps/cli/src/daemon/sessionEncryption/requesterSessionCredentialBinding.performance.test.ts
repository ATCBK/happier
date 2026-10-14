import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { expect, it } from 'vitest';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import type { Credentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { verifyRequesterSessionCredentialBinding, verifyRequesterSessionMachineAdmissionCurrent } from './requesterSessionCredentials';

it('opens owner metadata only for creation correspondence while retaining fresh requester authorization', async () => {
  const app = fastify();
  const origin = 'http://requester-binding.test';
  const attribution = { serverId: 'bob-home', accountId: 'bob', machineId: 'machine', installationId: 'installation' };
  const secret = new Uint8Array(32).fill(19);
  const installation = tweetnacl.sign.keyPair();
  let materialReads = 0;
  let access = true;
  let mode: 'plain' | 'e2ee' = 'e2ee';
  let role: 'owner' | 'view' = 'owner';
  const requests: string[] = [];
  const responses: string[] = [];
  const credentials: Credentials = { token: 'bob-ordinary', encryption: {
    // Observe real key demand; decryption and authorization remain production code.
    type: 'legacy', get secret() { materialReads++; return secret; },
  } };
  const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag: `create:v1:${'a'.repeat(43)}`,
    recipe: { execution: { machineId: 'machine', directory: { kind: 'path', path: '/workspace' } },
      organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
      connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
      agentSessionStartupInstructionsMarkerV1: null, checkout: null } });
  const metadata = encodeBase64(encryptLegacy({ machineId: 'machine', path: '/workspace',
    sessionCreationCorrespondenceV1: correspondence }, secret));
  app.addHook('onRequest', async request => { requests.push(request.url); });
  app.addHook('onResponse', async (request, reply) => { responses.push(`${request.url} ${reply.statusCode}`); });
  app.get('/v1/account/profile', async () => ({ id: 'bob' }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null }));
  app.get('/v1/machines/machine/access', async (_request, reply) => access ? {
    machineId: 'machine', custodian: { accountId: 'alice', displayName: 'Custodian' },
    access: { custodian: { accountId: 'alice', displayName: 'Custodian' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
    canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [],
  } : reply.code(403).send({ kind: 'refused', code: 'access_denied' }));
  app.post('/v1/machines/machine/admission/verify', async (request, reply) => {
    // The Home HTTP service is the boundary; signing and verification stay real.
    const body = request.body as { context: SocketRpcMachineAdmissionContextV1;
      purpose: { kind: 'requester_session_currentness'; sessionId: string };
      proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
    const valid = body.purpose?.kind === 'requester_session_currentness' && body.purpose.sessionId === 'session'
      && verifyMachineInstallationProof({ publicKey: installation.publicKey, proof: body.proof,
        payload: { version: 1, accountId: 'alice', machineId: 'machine', installationId: 'installation',
          rpcAdmission: { context: body.context, purpose: body.purpose } } });
    return access && valid ? { v: 1, ok: true } : reply.code(403).send({ error: 'access_denied' });
  });
  app.get('/v2/sessions/session', async () => ({ session: createSessionRecordFixture({ id: 'session',
    encryptionMode: 'e2ee', metadata, dataEncryptionKey: null,
    share: role === 'owner' ? null : { accessLevel: 'view', canApprovePermissions: false },
  }) }));
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  try {
    const binding = { credentials, attribution, sessionId: 'session', serverHttpBaseUrl: origin,
      verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution,
        sessionId: 'session', serverHttpBaseUrl: origin, boundary: { machineId: 'machine', daemonToken: 'alice-daemon',
          isHomeCurrent: () => true, readInstallation: () => ({ installationId: 'installation', privateKey: installation.secretKey }) },
      }) };
    expect(await verifyRequesterSessionCredentialBinding(binding), JSON.stringify(responses)).toBe(true);
    expect(materialReads).toBe(0);
    expect(requests).toEqual(expect.arrayContaining(['/v1/account/profile', '/v1/account/encryption/currentness',
      '/v2/sessions/session', '/v1/machines/machine/admission/verify']));
    expect(await verifyRequesterSessionCredentialBinding({ ...binding, expectedSessionCreationTag: correspondence.sessionCreationTag })).toBe(true);
    expect(materialReads).toBeGreaterThan(0);
    expect(await verifyRequesterSessionCredentialBinding({ ...binding, expectedSessionCreationTag: `create:v1:${'b'.repeat(43)}` })).toBe(false);
    expect(await verifyRequesterSessionCredentialBinding({ ...binding, attribution: { ...attribution, machineId: 'other-machine' },
      expectedSessionCreationTag: correspondence.sessionCreationTag })).toBe(false);
    materialReads = 0;
    role = 'view';
    expect(await verifyRequesterSessionCredentialBinding(binding)).toBe(false);
    role = 'owner'; mode = 'plain';
    expect(await verifyRequesterSessionCredentialBinding(binding)).toBe(false);
    mode = 'e2ee'; access = false;
    expect(await verifyRequesterSessionCredentialBinding(binding)).toBe(false);
    access = true;
    expect(await verifyRequesterSessionCredentialBinding({ ...binding, signal: AbortSignal.abort() })).toBe(false);
    expect(materialReads).toBe(0);
  } finally { restore(); await app.close(); }
});
