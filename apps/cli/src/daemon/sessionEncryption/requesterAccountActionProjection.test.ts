import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { bindRequesterSessionCredentialScope, sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { projectRequesterAccountActionAuthorization } from './requesterSessionCredentials';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import * as requesterAccountOwner from './requesterAccountActionProjection';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActionOperationRunner } from '../actionOperations/actionOperationRunner';
import { createActionOperationStore } from '../actionOperations/actionOperationStore';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';

let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
beforeEach(async () => { channel = await createRequesterCurrentnessSocketHarness(); });
afterEach(async () => { await channel.close(); vi.restoreAllMocks(); });

const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-invocation', binding: {
  accountId: 'bob', principalId: 'bob', credentialId: 'pat', custodianAccountId: 'alice',
  serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
  actionId: 'projects.context.update', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
  target: { kind: 'machine', machineId: 'machine' },
  grant: ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['projects.context.update'] },
    targets: { sessions: [], machines: ['machine'] }, approve: false, origins: [], models: null,
    permissionModes: null, create: null }),
} });

function bootstrap(credentials: StoredCredentials, isCurrent = async () => true) {
  return { credentials, serverHttpBaseUrl: 'https://requester-home.test', isCurrent,
    attribution: { serverId: 'home-profile', accountId: 'bob', machineId: 'machine', installationId: 'installation' } };
}

describe('admitted requester Action projection', () => {
  it('evaluates distinct Account and bootstrap facts once on each side of Home verification', async () => {
    const root = { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' as const } };
    const privateKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey;
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Unexpected requester GET ${url}`);
    });
    const posts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    // The installed bootstrap checks its root at Home. Keep that real owner;
    // only its HTTP reply is replaced, so nested bootstrap reads are counted.
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-ordinary', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({
        authorization: root, effectActionId: root.binding.actionId, target: root.binding.target,
        installationId: 'installation', privateKey, serverHttpBaseUrl: 'https://requester-home.test',
      }) });
    if (!admitted) throw new Error('Missing real private custody');
    try {
      const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
        serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
        target: root.binding.target, installationId: 'installation', privateKey, isCurrent: admitted.isCurrent });
      if (!carrier?.requesterHttpProjection) throw new Error('Missing real HTTP projection');
      reads.mockClear(); posts.mockClear();
      expect(await carrier.requesterHttpProjection.isCurrent()).toBe(true);
      expect({ encryption: reads.mock.calls.filter(([url]) => String(url).endsWith('/currentness')).length,
        verify: posts.mock.calls.filter(([url]) => String(url).endsWith('/verify')).length }).toEqual({ encryption: 0, verify: 3 });
      // A different Machine/local guard is a separate fact, even with the same
      // Account facet. It must still veto headers before any Home request.
      let installedCurrent = true;
      const distinct = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
        serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
        target: root.binding.target, installationId: 'installation', privateKey, isCurrent: async () => installedCurrent });
      expect(distinct).not.toBeNull();
      installedCurrent = false;
      reads.mockClear(); posts.mockClear();
      expect(await distinct?.requesterHttpProjection?.createRequestHeaders({ effectActionId: root.binding.actionId,
        method: 'POST', path: '/v1/account/project-rows/list' })).toBeNull();
      expect(reads).not.toHaveBeenCalled();
      expect(posts).not.toHaveBeenCalled();
    } finally {
      await admitted.dispose();
      reads.mockClear(); posts.mockClear();
      expect(await admitted.isCurrent()).toBe(false);
      expect(reads).not.toHaveBeenCalled();
      expect(posts).not.toHaveBeenCalled();
    }
  });

  it.each(['mode', 'signing key', 'content key', 'retirement'] as const)('refuses headers and projection output when %s changes during Home verification', async change => {
    const secret = new Uint8Array(32).fill(8);
    const mode = change === 'signing key' || change === 'content key' ? 'e2ee' : 'plain';
    const signingKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.sign.keyPair.fromSeed(secret).publicKey);
    const contentKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.box.keyPair.fromSecretKey(
      deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey);
    const changedKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey);
    let currentness = { mode: mode as 'plain' | 'e2ee', version: 1, updatedAt: 1,
      signingKeyFingerprint: mode === 'e2ee' ? signingKeyFingerprint : null,
      contentKeyFingerprint: mode === 'e2ee' ? contentKeyFingerprint : null };
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: mode === 'e2ee'
        ? { content: null, version: 0 } : { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: currentness };
      throw new Error(`Unexpected private requester read ${url}`);
    });
    let holdVerify = false;
    let entered!: () => void;
    let release!: () => void;
    const awaited = new Promise<void>(resolve => { entered = resolve; });
    const pendingVerify = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (!url.endsWith('/verify')) throw new Error(`Unexpected private requester write ${url}`);
      if (holdVerify) { entered(); await pendingVerify; }
      return { status: 200, data: { ok: true } };
    });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
      binding: { ...authorization.binding, accountEncryptionMode: mode } });
    const privateKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey;
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-ordinary', encryption: mode === 'e2ee' ? { type: 'legacy', secret } : null },
      serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: () => change === 'retirement'
        ? verifyExternalActionExecutionAuthorizationCurrent({ authorization: root, effectActionId: root.binding.actionId,
          target: root.binding.target, installationId: 'installation', privateKey, serverHttpBaseUrl: 'https://requester-home.test' })
        : Promise.resolve(true) });
    if (!admitted) throw new Error('Missing real private custody');
    const input = { authorization: admitted.authorization, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', target: root.binding.target, installationId: 'installation',
      privateKey, isCurrent: admitted.isCurrent };
    const carrier = await projectExternalActionRequesterHttpAuthorization(input);
    if (!carrier?.requesterHttpProjection) throw new Error('Missing real HTTP projection');
    holdVerify = true;
    try {
      const headers = carrier.requesterHttpProjection.createRequestHeaders({ effectActionId: root.binding.actionId,
        method: 'POST', path: '/v1/account/project-rows/list', body: { keys: [] } });
      const projection = projectExternalActionRequesterHttpAuthorization(input);
      const local = change === 'retirement' ? admitted.isCurrent() : null;
      await awaited;
      if (change === 'retirement') await admitted.dispose();
      else {
        currentness = { ...currentness, ...(change === 'mode' ? { mode: 'e2ee' as const, signingKeyFingerprint, contentKeyFingerprint }
          : change === 'signing key' ? { signingKeyFingerprint: changedKeyFingerprint } : { contentKeyFingerprint: changedKeyFingerprint }) };
        await channel.push('bob', currentness);
      }
      release();
      expect(await headers).toBeNull();
      expect(await projection).toBeNull();
      if (local) expect(await local).toBe(false);
    } finally { release(); await admitted.dispose(); }
  });

  it.each(['plain', 'e2ee'] as const)('scopes borrowed own-Account credentials without retiring installed custody (%s)', async mode => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'own-account-root', binding: {
      accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: mode, serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
      actionId: 'projects.context.update', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
    } });
    const credentials: StoredCredentials = { token: 'own-account', credentialProvenance: 'stored_session',
      encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(8) } };
    const installed = { ...credentials };
    // HTTP is the system boundary; admission, provenance, scoping and projection stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: mode === 'plain'
        ? { content: { t: 'plain', v: {} }, version: 0 } : { content: null, version: 0 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected own-Account read');
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const input: Parameters<typeof requesterAccountOwner.prepareRequesterAccountActionContext>[0] = {
      authorization: root, purpose: { kind: 'external_action' }, machineId: 'machine', installationId: 'installation',
      installationPrivateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      ownCredentials: credentials, isCurrent: async () => true,
      createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
    };
    const prepared = await requesterAccountOwner.prepareRequesterAccountActionContext(input);
    expect(prepared).not.toBeNull();
    expect(sameStoredCredentials(credentials, installed)).toBe(true);
    expect(credentials.requesterSessionCredentialScope).toBeUndefined();
    const requester = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
    expect(requester?.credentials).toMatchObject({ credentialProvenance: 'stored_session', requesterSessionCredentialScope: {
      serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
    } });
    expect(ExternalActionExecutionAuthorizationV1Schema.parse(prepared?.authorization)).toEqual(root);
    await prepared?.dispose?.();
    expect(await requester?.isCurrent()).toBe(false);
    // Existing private scope remains binding; borrowing must not strip it.
    bindRequesterSessionCredentialScope(credentials, { serverId: 'other-home', serverHttpBaseUrl: 'https://other-home.test' });
    expect(await requesterAccountOwner.prepareRequesterAccountActionContext(input)).toBeNull();
    expect(credentials.requesterSessionCredentialScope?.serverId).toBe('other-home');
    expect(await requesterAccountOwner.prepareRequesterAccountActionContext({ ...input, isCurrent: async () => false })).toBeNull();
    expect(await requesterAccountOwner.prepareRequesterAccountActionContext({ ...input, authorization: {
      ...root, binding: { ...root.binding, custodianAccountId: 'alice' },
    } })).toBeNull();
  });

  it.each(['plain', 'e2ee'] as const)('binds scoped Project Open ports to the observed Home before private HTTP effects (%s)', async mode => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-open', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'terminal', tokenEpoch: 0 },
      serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation', accountEncryptionMode: mode,
      actionId: 'projects.open', requestId: 'open', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
    } });
    const credentials: StoredCredentials = { token: 'bob', encryption: mode === 'plain' ? null
      : { type: 'legacy', secret: new Uint8Array(32).fill(8) } };
    // Account mode and Home root verification are HTTP boundaries; both projection owners stay real.
    const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    const posts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const accountInput = { authorization: root, serverIdentityId: 'stable-home', bootstrap: bootstrap(credentials) };
    const account = await projectRequesterAccountActionAuthorization(accountInput);
    expect(account?.requesterAccountProjection).toMatchObject({ accountId: 'bob', accountEncryptionMode: mode });
    if (!account) throw new Error('Expected admitted Project Open Account custody');
    const httpInput = { authorization: account, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', target: root.binding.target, installationId: 'installation',
      privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey };
    const carrier = await projectExternalActionRequesterHttpAuthorization(httpInput);
    expect(carrier?.requesterHttpProjection).toMatchObject({ accountId: 'bob', serverIdentityId: 'stable-home',
      accountEncryptionMode: mode });
    expect(ExternalActionExecutionAuthorizationV1Schema.parse(carrier)).toEqual(root);
    expect(Object.isFrozen(carrier?.requesterHttpProjection)).toBe(true);
    reads.mockClear(); posts.mockClear();
    expect(await projectRequesterAccountActionAuthorization({ ...accountInput, serverIdentityId: 'another-home' })).toBeNull();
    expect(await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root, credentials,
      serverId: 'home-profile', serverIdentityId: 'another-home', serverHttpBaseUrl: 'https://requester-home.test',
      isCurrent: async () => true })).toBeNull();
    expect(await projectExternalActionRequesterHttpAuthorization({ ...httpInput, serverIdentityId: 'another-home' })).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect(posts).not.toHaveBeenCalled();
    expect(ExternalActionExecutionAuthorizationV1Schema.safeParse({ ...root,
      requesterHttpProjection: { ...carrier?.requesterHttpProjection, serverIdentityId: 'another-home' } }).success).toBe(false);
  });

  it('keeps private custody current across unrelated Account sequence updates but retires it on encryption transitions', async () => {
    let version = 1;
    let updatedAt = 1;
    // Home root verification is the network boundary; Account custody remains real.
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: {
      mode: 'plain', version: version++, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt,
    } }));
    const projected = await projectRequesterAccountActionAuthorization({ authorization,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob', encryption: null }) });
    expect(projected?.requesterAccountProjection).toBeDefined();
    expect(await projected?.requesterAccountProjection?.isCurrent()).toBe(true);
    const http = projected && await projectExternalActionRequesterHttpAuthorization({ authorization: projected,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      target: authorization.binding.target, installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey,
      isCurrent: async () => true });
    expect(http).not.toBeNull();
    updatedAt = 2;
    expect(await projected?.requesterAccountProjection?.isCurrent()).toBe(false);
  });
  it('keeps accepted private work current after the ingress releases custody and retires it on actual settlement', async () => {
    const admit = Reflect.get(requesterAccountOwner, 'admitRequesterAccountActionContext');
    expect(typeof admit).toBe('function');
    if (typeof admit !== 'function') throw new Error('Missing standalone requester Account admission');
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected private requester read');
    });
    const admitted = await admit({ authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob-ordinary', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true });
    expect(admitted).not.toBeNull();
    const scope = { accountId: 'bob', machineId: 'machine' };
    const runner = createActionOperationRunner({ store: createActionOperationStore(), generateOperationId: () => 'private-operation',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }) });
    let settle!: () => void;
    const nativeSettlement = new Promise<void>(resolve => { settle = resolve; });
    await runner.observe({ actionId: 'projects.script.run', scope, execute: async context => {
      const release = admitted.retain();
      try {
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home-profile',
          machineId: 'machine', workspaceRefId: 'workspace', cwd: '/project' }, state: 'running' });
        await nativeSettlement;
        return { ok: true, result: { requesterCurrent: await admitted.isCurrent() } };
      } finally { await release(); }
    } });
    await admitted.dispose();
    expect(await admitted.isCurrent()).toBe(true);
    settle();
    expect(await runner.waitForTerminal(scope, 'private-operation')).toMatchObject({ state: 'succeeded', result: { requesterCurrent: true } });
    expect(await admitted.authorization.requesterAccountProjection.isCurrent()).toBe(false);
  });
  it('admits an arbitrary-Machine Account invocation without creating a Session or changing daemon settings', async () => {
    const admit = Reflect.get(requesterAccountOwner, 'admitRequesterAccountActionContext');
    expect(typeof admit).toBe('function');
    if (typeof admit !== 'function') throw new Error('Missing standalone requester Account admission');
    const before = getActiveAccountSettingsSnapshot();
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
      expect(config?.headers?.Authorization).toBe('Bearer bob-ordinary');
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected private requester read');
    });
    let live = true;
    const context = await admit({ authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob-ordinary', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => live });
    expect(context?.authorization.requesterAccountProjection?.accountId).toBe('bob');
    expect(context?.accountSettingsContext.source).toBe('network');
    const readContext = Reflect.get(requesterAccountOwner, 'readRequesterAccountActionContext');
    expect(typeof readContext).toBe('function');
    if (typeof readContext !== 'function') throw new Error('Missing admitted private custody consumer port');
    expect(readContext(context.authorization)).toBe(context);
    expect(readContext(ExternalActionExecutionAuthorizationV1Schema.parse(context.authorization))).toBeNull();
    expect(JSON.stringify(context.authorization)).not.toContain('bob-ordinary');
    expect(getActiveAccountSettingsSnapshot()).toBe(before);
    expect(reads.mock.calls.some(([url]) => String(url).includes('/sessions'))).toBe(false);
    await context.dispose();
    expect(await context.authorization.requesterAccountProjection.isCurrent()).toBe(false);
    live = false;
    expect(await admit({ authorization, credentials: { token: 'bob-ordinary', encryption: null },
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      isCurrent: async () => live })).toBeNull();
  });
  it('refuses stale requester E2EE material against the published Home content fingerprint before first private writes', async () => {
    const secret = new Uint8Array(32).fill(12);
    const fingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.box.keyPair.fromSecretKey(
      deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey);
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: fingerprint, updatedAt: 1,
      } };
      throw new Error('Unexpected private requester read');
    });
    const admit = requesterAccountOwner.admitRequesterAccountActionContext;
    const input = { authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'e2ee' as const } },
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true };
    const admitted = await admit({ ...input, credentials: { token: 'bob-private', encryption: { type: 'legacy', secret } } });
    expect(admitted).not.toBeNull();
    await admitted?.dispose();
    expect(await admit({ ...input, credentials: { token: 'bob-private', encryption: {
      type: 'legacy', secret: new Uint8Array(32).fill(13),
    } } })).toBeNull();
  });
  it('uses the exact admitted source Session for a Home-proved remote Project Action', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    const sourceAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      ...authorization, binding: { ...authorization.binding, machineId: 'destination', installationId: 'destination-installation',
        target: { kind: 'machine', machineId: 'destination' },
        sessionActionSource: { machineId: 'machine', installationId: 'installation' },
        sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'bob-session', starterDepth: 0, turnDepth: 0 },
          sourceTurnId: 'turn', callerPermissionMode: null, requestId: 'request' } },
    });
    const admitted = { ...bootstrap({ token: 'bob-ordinary', encryption: null }), getBoundSessionId: () => 'bob-session' };
    expect((await projectRequesterAccountActionAuthorization({ authorization: sourceAuthorization,
      serverIdentityId: 'stable-home', bootstrap: admitted }))?.requesterAccountProjection?.accountId).toBe('bob');
    expect(await projectRequesterAccountActionAuthorization({ authorization: sourceAuthorization,
      serverIdentityId: 'stable-home', bootstrap: { ...admitted, getBoundSessionId: () => 'another-session' } })).toBeNull();
  });
  it.each(['continuation', 'preflight'] as const)('projects the verified handoff %s to its exact admitted target Session without replacing the original source', async phase => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    const child = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: {
      ...authorization.binding, actionId: phase === 'preflight' ? 'session.handoff' : 'session.handoff.prepare',
      sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'original-caller', starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'turn', callerPermissionMode: null, requestId: 'request' },
      sessionActionSource: { machineId: 'source', installationId: 'source-installation' },
      handoffAdmission: { sessionId: 'transferred-session', sourceMachineId: 'source', targetMachineId: 'machine',
        sourceInstallationId: 'source-installation', targetInstallationId: 'installation' },
      ...(phase === 'preflight'
        ? { handoffPreflight: { rootRequestId: 'request', rootRequestEnvelopeDigest: 'b'.repeat(43) } }
        : { handoffContinuation: { handoffId: 'handoff', rootRequestId: 'request', rootRequestEnvelopeDigest: 'b'.repeat(43) } }),
    } });
    const admitted = { ...bootstrap({ token: 'bob-ordinary', encryption: null }), getBoundSessionId: () => 'transferred-session' };
    expect((await projectRequesterAccountActionAuthorization({ authorization: child,
      serverIdentityId: 'stable-home', bootstrap: admitted }))?.requesterAccountProjection?.accountId).toBe('bob');
    expect(await projectRequesterAccountActionAuthorization({ authorization: child,
      serverIdentityId: 'stable-home', bootstrap: { ...admitted, getBoundSessionId: () => 'other-session' } })).toBeNull();
  });

  it('retains the original requester HTTP proof while attaching private Account ports on the same carrier', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    let live = true;
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: live ? 200 : 403,
      data: live ? { ok: true } : {} }));
    const original = await projectExternalActionRequesterHttpAuthorization({ authorization,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      target: authorization.binding.target, installationId: 'installation', privateKey: keys.secretKey });
    if (!original?.requesterHttpProjection) throw new Error('Expected the original Home HTTP proof');
    const carrier = await projectRequesterAccountActionAuthorization({ authorization: original,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: null }) });
    expect(carrier?.requesterAccountProjection?.accountId).toBe('bob');
    expect(await carrier?.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'projects.context.update',
      method: 'POST', path: '/v1/projects/account-rows/list', body: {} })).toMatchObject({
      [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
    });
    expect(JSON.parse(JSON.stringify(carrier))).toEqual(authorization);
    live = false;
    expect(await carrier?.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'projects.context.update',
      method: 'POST', path: '/v1/projects/account-rows/list', body: {} })).toBeNull();
  });

  it('uses the admitted requester Artifact owner at the original Home and withholds a read after access loss', async () => {
    const artifactId = '11111111-1111-4111-8111-111111111111';
    let live = true;
    let loseAdmissionDuringRead = false;
    const header = { kind: 'prompt_doc.v2', title: 'Bob private doc' };
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/access/grants')) return { status: 200, data: { artifactId, ownerAccountId: 'bob', access: 'owner', grants: [] } };
      if (loseAdmissionDuringRead) live = false;
      return { status: 200, data: { id: artifactId, ownerAccountId: 'bob', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: 'private body' }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    const projected = await projectRequesterAccountActionAuthorization({ authorization,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: null }, async () => live) });
    if (!projected?.requesterAccountProjection) throw new Error('Expected admitted reader');
    const ref = { kind: 'doc' as const, serverId: 'home-profile', artifactId };
    expect(await projected.requesterAccountProjection.readArtifact(ref)).toMatchObject({ artifactId, header,
      promptLibraryArtifact: { id: artifactId, header, body: 'private body', revision: { headerVersion: 1, bodyVersion: 1 } } });
    expect(reads.mock.calls.every(([url, config]) => String(url).startsWith('https://requester-home.test/')
      && config?.headers?.Authorization === 'Bearer bob-ordinary')).toBe(true);
    loseAdmissionDuringRead = true;
    expect(await projected.requesterAccountProjection.readArtifact(ref)).toBeNull();
  });

  it('supplies Bob private-row crypto on the existing carrier without serializing private ports', async () => {
    const secret = new Uint8Array(32).fill(7);
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'e2ee', version: 1,
      signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1 } });
    const result = await projectRequesterAccountActionAuthorization({ authorization,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: { type: 'legacy', secret } }) });
    const projection = result?.requesterAccountProjection;
    expect(projection).toBeDefined();
    const key = { kind: 'project-organization', serverId: 'home-profile', projectKey: 'project' } as const;
    const payload = { key, value: { pinned: true } };
    const sealed = projection!.projectAccountRowCipher.seal(payload);
    expect(createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret },
      randomBytes: length => new Uint8Array(length) }).open(key, sealed)).toEqual(payload);
    expect(() => createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
      randomBytes: length => new Uint8Array(length) }).open(key, sealed)).toThrow();
    expect(JSON.parse(JSON.stringify(result))).toEqual(authorization);
    expect(ExternalActionExecutionAuthorizationV1Schema.parse(result)).toEqual(authorization);
    expect(await projection!.readArtifact({ kind: 'doc', serverId: 'another-home', artifactId: 'artifact' })).toBeNull();
  });

  it('refuses wrong requester, Home, installation and lost admission before opening any private content', async () => {
    const read = vi.spyOn(axios, 'get');
    const admitted = bootstrap({ token: 'bob', encryption: null });
    for (const binding of [
      { ...authorization.binding, accountId: 'alice' },
      { ...authorization.binding, installationId: 'replaced' },
      { ...authorization.binding, machineId: 'another-machine' },
    ]) {
      expect(await projectRequesterAccountActionAuthorization({ authorization: { ...authorization, binding },
        serverIdentityId: 'stable-home', bootstrap: admitted })).toBeNull();
    }
    expect(await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'another-home', bootstrap: admitted })).toBeNull();
    expect(await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'stable-home',
      bootstrap: bootstrap(admitted.credentials, async () => false) })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('does not turn missing E2EE material into plaintext, or expose a read that loses current admission', async () => {
    let live = true;
    vi.spyOn(axios, 'get').mockImplementation(async () => {
      live = false;
      return { status: 200, data: { mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1 } };
    });
    expect(await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'stable-home',
      bootstrap: bootstrap({ token: 'bob', encryption: null }, async () => live) })).toBeNull();
  });

  it('refuses private ports when the authenticated Account mode no longer matches the Home proof', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 2,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 2 } });
    const e2eeProof = { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'e2ee' as const } };
    expect(await projectRequesterAccountActionAuthorization({ authorization: e2eeProof,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob', encryption: null }) })).toBeNull();
  });
});
