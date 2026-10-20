import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, encodeV2SessionListCursorV2, API_TOKEN_FULL_GRANT_V1, wrapApiTokenEncryptionAccessV1,
  deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { getSessionStatus } from '@/session/services/getSessionStatus';
import * as sessionSockets from '@/api/session/sockets';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('CLI Session target composition', () => {
  const home = 'https://session-target-home.test';
  const sessionId = 'c111111111111111111111111';
  const managerId = 'c222222222222222222222222';
  const context = { surface: 'cli', authority: 'present_user', serverId: 'srv_target_home' } as const;

  function setup(manager: string | null = managerId, requester?: Readonly<{ privateKey: Uint8Array; installationId: string; secret?: Uint8Array }>) {
    const secret = requester?.secret;
    const encryption = secret ? { type: 'legacy' as const, secret } : null;
    const credentials = { token: 'token', encryption };
    const mode = secret ? 'e2ee' as const : 'plain' as const;
    const ownerMetadata = { v: 1 as const, workspace: { path: '/repo', host: 'host', machineId: 'machine-selected' } };
    const session = createSessionRecordFixture({ id: sessionId, encryptionMode: mode, metadataLayoutVersion: 1,
      share: null, dataEncryptionKey: null, metadata: secret
        ? encryptSessionPayload({ ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, payload: { v: 1 } })
        : JSON.stringify({ v: 1 }),
      ownerMetadata: encryption ? sealSessionOwnerMetadataEnvelopeV1({ material: encryption, ownerMetadata, randomBytes: nacl.randomBytes })
        : createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
      ...(manager ? { manager: { sessionId: manager } } : {}),
    });
    // Only Home HTTP is substituted; reference resolution, currentness,
    // access projection, Action dispatch and status projection stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(new URL(String(url)).origin).toBe(home);
      if (!requester) expect(config?.headers).toMatchObject({ Authorization: 'Bearer token' });
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode }) };
      if (requester && String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account-1' } };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200,
        data: AccountSettingsV2GetResponseSchema.parse({ content: encryption
          ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: encryption, payload: {}, randomBytes: nacl.randomBytes }) }
          : { t: 'plain', v: {} }, version: 1 }) };
      throw new Error(`Unexpected Home read: ${url}`);
    });
    const deps = createCliActionDeps({ token: 'token', credentials,
      sessionId, mode, ctx: secret ? { encryptionKey: secret, encryptionVariant: 'legacy' } : null, serverId: 'srv_target_home', serverIdentityId: 'srv_target_home',
      serverHttpBaseUrl: home,
      ...(requester ? { externalActionMachineRequestPrivateKey: requester.privateKey,
        externalActionMachineInstallationId: requester.installationId } : {}),
    });
    return { deps, get, session, credentials };
  }

  it('binds the canonical reference resolver and manager read to the exact Home', async () => {
    const { deps } = setup();
    const signal = new AbortController().signal;
    expect(await deps.resolveSessionReference!({ sessionId, context, actionId: 'session.status.get', signal }))
      .toEqual({ kind: 'unique', address: { serverId: 'srv_target_home', sessionId } });
    expect(await deps.readSessionManager!({ address: { serverId: 'srv_target_home', sessionId },
      context, actionId: 'session.status.get', signal }))
      .toEqual({ kind: 'manager', address: { serverId: 'srv_target_home', sessionId: managerId } });
    const result = await createActionExecutor(deps).execute('session.status.get', { sessionId, live: false }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, session: { id: sessionId } } });
  });

  it('distinguishes a successful no-manager read from unavailable current access', async () => {
    const { deps, get } = setup(null);
    const request = { address: { serverId: 'srv_target_home', sessionId }, context, actionId: 'session.status.get' as const };
    expect(await deps.readSessionManager!(request)).toEqual({ kind: 'manager', address: null });
    get.mockRejectedValue(new Error('Home unavailable'));
    expect(await deps.readSessionManager!(request)).toEqual({ kind: 'unavailable' });
    expect(await deps.resolveSessionReference!({ sessionId, context, actionId: 'session.status.get' }))
      .toEqual({ kind: 'incomplete' });
  });

  it('refuses another Home and cancellation before any transport read', async () => {
    const { deps, get } = setup();
    const foreign = { ...context, serverId: 'foreign-home' };
    expect(await deps.resolveSessionReference!({ sessionId, context: foreign, actionId: 'session.status.get' }))
      .toEqual({ kind: 'incomplete' });
    expect(await deps.readSessionManager!({ address: { serverId: 'foreign-home', sessionId },
      context, actionId: 'session.status.get' })).toEqual({ kind: 'unavailable' });
    expect(await deps.sessionStatusGet!({ sessionId, serverId: 'foreign-home', context, live: false }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    const controller = new AbortController();
    controller.abort(new Error('cancel target resolution'));
    await expect(deps.resolveSessionReference!({ sessionId, context, actionId: 'session.status.get', signal: controller.signal }))
      .rejects.toThrow('cancel target resolution');
    await expect(deps.sessionStatusGet!({ sessionId, context, live: false, signal: controller.signal }))
      .rejects.toThrow('cancel target resolution');
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps externally authorized live status on its admitted HTTP snapshot', async () => {
    const { deps, get } = setup();
    const socket = vi.spyOn(sessionSockets, 'createSessionScopedSocket').mockImplementation(() => {
      throw new Error('Own Account socket must not replace external authority');
    });
    const externalActionExecutionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted', binding: {
      accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'srv_target_home', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation',
      actionId: 'session.status.get', requestId: 'status-request', target: { kind: 'session', sessionId },
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'status-request',
        target: { kind: 'session', sessionId }, input: { sessionId, live: true } }),
    } });
    const result = await runWithServerHttpBaseUrl(home, () => getSessionStatus({
      credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, live: true,
      authorization: externalActionExecutionAuthorization,
      resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer token' }),
    }));
    expect(result).toMatchObject({ ok: true, session: { id: sessionId } });
    expect(socket).not.toHaveBeenCalled();
    // These deps have no Machine signer for this external authorization. Both
    // selector reads must fail closed before using the host's Account token.
    get.mockClear();
    const externalContext = { ...context, externalActionExecutionAuthorization,
      externalActionTarget: { kind: 'session' as const, sessionId } };
    expect(await deps.readSessionManager!({ address: { serverId: 'srv_target_home', sessionId },
      context: externalContext, actionId: 'session.status.get' })).toEqual({ kind: 'unavailable' });
    expect(await deps.resolveSessionReference!({ sessionId, context: externalContext, actionId: 'session.status.get' }))
      .toEqual({ kind: 'incomplete' });
    expect(get).not.toHaveBeenCalled();
  });

  it('uses the real paged query and summary projection for direct and recursive workers', async () => {
    const { deps, get, session } = setup();
    const childId = 'c333333333333333333333333';
    const grandchildId = 'c444444444444444444444444';
    const archivedChildId = 'c555555555555555555555555';
    const child = { ...createSessionNotificationContextFixture(childId), ...session, id: childId, manager: { sessionId } };
    const grandchild = { ...createSessionNotificationContextFixture(grandchildId), ...session, id: grandchildId, manager: { sessionId: childId } };
    const archivedChild = { ...createSessionNotificationContextFixture(archivedChildId), ...session,
      id: archivedChildId, archivedAt: 5, manager: { sessionId } };
    const currentGet = get.getMockImplementation()!;
    get.mockImplementation(async (url, config) => {
      const row = [child, grandchild, archivedChild].find(candidate => String(url).endsWith(`/v2/sessions/${candidate.id}`));
      return row ? { status: 200, data: { session: row } } : currentGet(url, config);
    });
    const cursor = encodeV2SessionListCursorV2({ sessionId: childId, meaningfulActivityAt: 1 });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(String(url)).toBe(`${home}/v2/sessions/query`);
      expect(body).toMatchObject({ underSessionId: sessionId, includeInactive: true, scope: 'all_accessible' });
      if (body.storage === 'archived') return { status: 200, data: SessionListQueryResponseV1Schema.parse({
        sessions: [archivedChild], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) };
      const next = body.cursor === cursor;
      return { status: 200, data: SessionListQueryResponseV1Schema.parse({ sessions: [next ? grandchild : child],
        nextCursor: next ? null : cursor, hasNext: !next, attentionNextCursor: null, attentionHasNext: false }) };
    });
    const executor = createActionExecutor(deps);
    const direct = await executor.execute('session.status.get', { sessionId: { selector: 'workers' }, live: false },
      { ...context, defaultSessionId: sessionId });
    expect(direct, JSON.stringify(direct)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
      { target: { sessionId: childId }, result: { ok: true, result: { session: { id: childId } } } },
      { target: { sessionId: archivedChildId }, result: { ok: true, result: { session: { id: archivedChildId } } } },
    ] } });
    const recursive = await executor.execute('session.status.get', { sessionId: { selector: 'workers', recursive: true }, live: false },
      { ...context, defaultSessionId: sessionId });
    expect(recursive, JSON.stringify(recursive)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
      { target: { sessionId: childId } }, { target: { sessionId: grandchildId } }, { target: { sessionId: archivedChildId } },
    ] } });
  });

  it.each(['complete', 'private_facts_unavailable', 'repeated_cursor'] as const)(
    'resolves matching from the complete authorized corpus (%s)', async coverage => {
      const { deps, get, session } = setup();
      const ids = ['c666666666666666666666666', 'c777777777777777777777777', 'c888888888888888888888888'] as const;
      const rows = ids.map((id, index) => {
        const row = { ...createSessionNotificationContextFixture(id), ...session, id };
        if (coverage !== 'private_facts_unavailable' || index !== 1) return row;
        const { ownerMetadata: _private, ...recipient } = row;
        const share = { accessLevel: 'view' as const, canApprovePermissions: false };
        return { ...recipient, share, effectiveAccess: { v: 1 as const, level: 'view' as const,
          sources: [{ kind: 'direct' as const, shareId: 'shared-session' }],
          capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [share] }),
        } };
      });
      const leafReads: string[] = [];
      const currentGet = get.getMockImplementation()!;
      get.mockImplementation(async (url, config) => {
        const row = rows.find(candidate => String(url).endsWith(`/v2/sessions/${candidate.id}`));
        if (!row) return currentGet(url, config);
        leafReads.push(row.id);
        return { status: 200, data: { session: row } };
      });
      const cursor = encodeV2SessionListCursorV2({ sessionId: ids[0], meaningfulActivityAt: 1 });
      const attentionCursor = encodeV2SessionListCursorV2({ sessionId: ids[2], meaningfulActivityAt: 1 });
      vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        expect(String(url)).toBe(`${home}/v2/sessions/query`);
        expect(body).toMatchObject({ underSessionId: sessionId, includeInactive: true, scope: 'all_accessible' });
        const attention = body.attentionCursor === attentionCursor;
        const next = body.cursor === cursor;
        return { status: 200, data: SessionListQueryResponseV1Schema.parse({
          sessions: [rows[attention ? 2 : next ? 1 : 0]],
          nextCursor: attention || next && coverage !== 'repeated_cursor' ? null : cursor,
          hasNext: !attention && (!next || coverage === 'repeated_cursor'),
          attentionNextCursor: attention ? null : attentionCursor, attentionHasNext: !attention,
        }) };
      });
      const filter = normalizeSessionListFilterV1({
          homeServerIds: ['srv_target_home'], show: 'sessions', scope: 'all_accessible',
          startedBy: ['you', 'triggers', 'agents'], source: 'persisted', underSessionId: sessionId,
      });
      if (coverage === 'private_facts_unavailable') {
        await expect(deps.sessionFollowPreview!({ context: { ...context, defaultSessionId: sessionId },
          input: { receiver: { kind: 'session', sessionId }, filter },
        })).resolves.toMatchObject({ coverage: 'partial', unavailable: [
          { serverId: 'srv_target_home', source: { kind: 'session', sessionId: ids[1] } },
        ] });
      }
      const result = await createActionExecutor(deps).execute('session.status.get', {
        sessionId: { selector: 'matching', filter }, live: false,
      }, { ...context, defaultSessionId: sessionId });
      if (coverage === 'complete') {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'fanout', results: ids.map(id => ({
          target: { serverId: 'srv_target_home', sessionId: id }, result: { ok: true, result: { session: { id } } },
        })) } });
        expect(leafReads).toEqual(ids);
      } else {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
        expect(leafReads).toEqual([]);
      }
    },
  );

  it.each(['plain', 'encrypted'] as const)('carries root selectors through transport and ingress into the real target resolver and native refusal (%s)', async mode => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-root-session-target-' }, async () => {
      const currentnessChannel = await createRequesterCurrentnessSocketHarness();
      try {
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
        const secret = mode === 'encrypted' ? new Uint8Array(32).fill(17) : undefined;
        const { deps, session, credentials } = setup(managerId, { privateKey: keys.secretKey, installationId: 'installation', secret });
        const childId = 'c666666666666666666666666';
        const child = { ...createSessionNotificationContextFixture(childId), ...session, id: childId, manager: { sessionId } };
        const currentGet = vi.mocked(axios.get).getMockImplementation()!;
        vi.mocked(axios.get).mockImplementation(async (url, config) => String(url).endsWith(`/v2/sessions/${childId}`)
          ? { status: 200, data: { session: child } } : currentGet(url, config));
        vi.spyOn(axios, 'post').mockImplementation(async (url) => {
          expect(String(url)).toBe(`${home}/v2/sessions/query`);
          return { status: 200, data: SessionListQueryResponseV1Schema.parse({ sessions: [child],
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }) };
        });
        const receiver = createActionExecutor(deps);
        const resolveTarget = createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: home });
        let wrongMachine = false;
        const tokenId = '123e4567-e89b-42d3-a456-426614174000';
        const bearer = `hap_v1_${tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
        const material = { type: 'dataKey' as const, machineKey: secret
          ? deriveAccountMachineKeyFromRecoverySecret(secret) : new Uint8Array(32).fill(17) };
        const wrappingSecret = new Uint8Array(32).fill(7);
        const pins = { serverIdentityId: 'srv_target_home', accountId: 'account-1', tokenId,
          contentPublicKey: encodeBase64(nacl.box.keyPair.fromSecretKey(material.machineKey).publicKey, 'base64') };
        const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context: pins, wrappingSecret, contentPrivateKey: material.machineKey,
          randomBytes: length => new Uint8Array(length).fill(3) });
        const token = mode === 'plain' ? bearer : formatAccountApiTokenCredentialV1({ bearer,
          serverIdentityId: pins.serverIdentityId, accountId: pins.accountId, contentPublicKey: pins.contentPublicKey,
          wrappingSecret: encodeBase64(wrappingSecret, 'base64url') });
        // Only the Home HTTP relay/authentication boundary is substituted. The
        // credential factory, SDK codec, ingress, resolver, reads and send stay real.
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          if (String(url).endsWith('/v1/machines')) return new Response(JSON.stringify([
            { id: 'machine-selected', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null },
          ]), { status: 200 });
          if (String(url).endsWith('/encryption-access')) return new Response(JSON.stringify({
            v: 1, accountId: pins.accountId, tokenId, encryptionAccess,
          }), { status: 200 });
          const actionId = decodeURIComponent(String(url).split('/').at(-1)!);
          const envelope: unknown = JSON.parse(String(init?.body));
          const parsedEnvelope = ExternalActionRequestEnvelopeSchema.parse(envelope);
          const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-proof', binding: {
            accountId: pins.accountId, principalId: 'principal-1', credentialId: tokenId, grant: API_TOKEN_FULL_GRANT_V1,
            accountEncryptionMode: secret ? 'e2ee' : 'plain',
            serverIdentityId: pins.serverIdentityId, custodianAccountId: pins.accountId, machineId: 'machine-selected',
            installationId: 'installation', actionId, requestId: parsedEnvelope.requestId ?? 'home-read-request', target: parsedEnvelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(parsedEnvelope),
          } });
          const admitted = await admitRequesterAccountActionContext({ authorization, credentials,
            serverId: 'srv_target_home', serverIdentityId: pins.serverIdentityId, serverHttpBaseUrl: home, isCurrent: async () => true });
          if (!admitted) throw new Error('Expected authenticated Home requester custody');
          try {
          const result = await executeExternalAction({ actionId, envelope,
            currentMachineId: wrongMachine ? 'misbound-machine' : 'machine-selected', currentServerId: 'srv_target_home',
            currentInstallationId: 'installation', externalActionMachineRequestPrivateKey: keys.secretKey,
            executionAuthorization: admitted.authorization, verifyExecutionAuthorization: async () => true,
            principal: { accountId: pins.accountId, principalId: 'principal-1', credentialId: tokenId,
              grant: API_TOKEN_FULL_GRANT_V1, authority: 'account_automation' },
            resolveEncryption: async () => ({ serverIdentityId: pins.serverIdentityId, material }),
            resolveTarget,
            executor: receiver,
          });
          if (wrongMachine && result.kind === 'invalid_request') {
            return new Response(JSON.stringify({ error: result.errorCode }), { status: 400 });
          }
          expect(result.kind).toBe('response');
          if (result.kind !== 'response') throw new Error('Expected an admitted Action response');
          return new Response(JSON.stringify(result.response), { status: 200 });
          } finally { await admitted.dispose(); }
        }));
        const root = createCliActionExecutorFromCredentials({ credentials: {
          token,
          encryption: null, credentialProvenance: 'api_token',
        }, serverId: 'srv_target_home', serverApiUrl: home, machineId: 'machine-selected' });
        const exactRoot = createCliActionExecutorFromCredentials({ credentials: {
          token, encryption: null, credentialProvenance: 'api_token',
        }, serverId: 'srv_target_home', serverApiUrl: home });
        for (const recipient of [
          { kind: 'agent_team_member' as const, teamId: 'native-team', memberId: 'native-member' },
          { kind: 'agent_team_broadcast' as const, teamId: 'native-team' },
        ]) {
          const refusal = await exactRoot.execute('session.message.send', {
            sessionId: childId, message: 'Must not reach primary', recipient, wait: false,
          }, { surface: 'cli' });
          expect(refusal, JSON.stringify(refusal)).toMatchObject({ ok: true, result: {
            status: 'rejected', code: 'session_input_target_update_required',
          } });
        }
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['srv_target_home'], show: 'sessions',
          scope: 'all_accessible', startedBy: ['you', 'triggers', 'agents'], source: 'persisted', underSessionId: sessionId });
        for (const of of [undefined, sessionId]) {
          const target = { selector: 'matching' as const, filter, ...(of ? { of } : {}) };
          const status = await root.execute('session.status.get', { sessionId: target, live: false }, { surface: 'cli' });
          expect(status, JSON.stringify(status)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
            { target: { sessionId: childId }, result: { ok: true, result: { session: { id: childId } } } },
          ] } });
          expect(getActionSpec('session.status.get').outputSchema!.safeParse(status.ok ? status.result : null).success).toBe(true);
          const send = await root.execute('session.message.send', { sessionId: target, message: 'Must not reach primary',
            recipient: { kind: 'agent_team_broadcast', teamId: 'native-team' }, wait: false }, { surface: 'cli' });
          expect(send, JSON.stringify(send)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
            { target: { sessionId: childId }, result: { ok: true, result: {
              status: 'rejected', code: 'session_input_target_update_required',
            } } },
          ] } });
        }
        const self = await root.execute('session.status.get', { sessionId: 'self', live: false },
          { surface: 'cli', defaultSessionId: childId });
        expect(self, JSON.stringify(self)).toMatchObject({ ok: true, result: { session: { id: childId } } });
        wrongMachine = true;
        await expect(root.execute('session.status.get', { sessionId: { selector: 'matching', filter }, live: false }, { surface: 'cli' }))
          .rejects.toThrow();
      } finally { await currentnessChannel.close(); }
    });
  });
});
