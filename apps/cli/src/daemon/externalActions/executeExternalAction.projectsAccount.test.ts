import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeExternalActionRequestEnvelopeDigestV1, type SignedRootActionId } from '@happier-dev/protocol/actions';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1, type ExternalActionExecutionAuthorizationV1 }
  from '@happier-dev/protocol/actions/externalActionApi';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectAccountRowV1Schema, ProjectAccountRowMutationRequestV1Schema,
  buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { auth } from '../../../../server/sources/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest, verifyExternalActionExecutionAuthorizationCurrentness }
  from '../../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { updateSettings } from '@/persistence';
import { reloadConfiguration } from '@/configuration';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { prepareRequesterAccountActionContext } from "../sessionEncryption/requesterAccountActionProjection";
import { type RequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { executeExternalAction } from './executeExternalAction';
import type { JsonValue } from '@happier-dev/protocol';
import { projectAccountRowReadResponse } from '@/testkit/http/projectAccountRows';

// Database I/O and HTTP are the only substitutes. Home token minting, signed
// request verification, private custody, Action policy and row semantics stay real.
const storage = vi.hoisted(() => {
  const account = { id: 'project-owner', status: 'active', tokenEpoch: 1, encryptionMode: 'plain', terminalPresentUserPolicy: 'never' };
  const state: { publicKey: Uint8Array; revokedAt: Date | null } = { publicKey: new Uint8Array(), revokedAt: null };
  const machine = () => ({ id: 'project-machine', accountId: account.id, kind: 'persistent', active: true,
    installationId: 'project-installation', installationPublicKey: state.publicKey, revokedAt: state.revokedAt,
    metadata: encodePlainMachineStoredContent({}), daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    replacedByMachineId: null, account, accountGrants: [], teamGrants: [], groupGrants: [] });
  const reader = { $executeRaw: async () => 0,
    $queryRaw: async () => [{ statement_timeout: '0' }],
    $executeRawUnsafe: async () => 0,
    account: { findUnique: async () => account },
    machine: { findUnique: async () => machine(), findFirst: async () => machine(), findMany: async () => [machine()] },
    simpleCache: { findUnique: async () => ({ value: 'srv_PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP' }) } };
  return { state, account, db: { ...reader, $transaction: async <T>(run: (tx: typeof reader) => Promise<T>) => run(reader) } };
});
vi.mock('../../../../server/sources/storage/db', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../server/sources/storage/db')>(), db: storage.db,
}));

const homeId = 'srv_PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
const profileId = 'project-local-profile';
const serverUrl = 'https://project-home.test';
const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'project-owner' })).toString('base64url')}.signature`;
const credentials = { token, encryption: null };
const target = { kind: 'machine' as const, machineId: 'project-machine' };
const source = { id: 'source/a', revision: 2, name: 'App', repository: {
  provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'happier-dev/happier', cloneUrl: 'https://github.com/happier-dev/happier.git', visibility: 'public' as const },
  protocol: 'https' as const }, audience: [], createdByAccountId: 'project-owner' };

beforeAll(async () => {
  vi.stubEnv('HANDY_MASTER_SECRET', 'project-account-test-secret');
  vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
  vi.stubEnv('AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS', '0');
  storage.state.publicKey = installation.publicKey;
  await auth.init();
});
afterEach(() => { vi.restoreAllMocks(); storage.state.revokedAt = null; storage.account.tokenEpoch = 1; });
afterAll(() => vi.unstubAllEnvs());

async function withHome(run: () => Promise<void>) {
  await withTempDir('project-terminal-home-', async home => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
    const currentness = await createRequesterCurrentnessSocketHarness();
    try {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: profileId });
      reloadConfiguration();
      await updateSettings(settings => ({ ...settings, activeServerId: profileId, servers: { [profileId]: {
        id: profileId, name: 'Project Home', serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({
          v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl, revision: 1,
          endpoints: [{ kind: 'https', url: serverUrl }] }),
      } } }));
      await run();
    } finally { await currentness.close(); env.restore(); reloadConfiguration(); }
  });
}

function httpBoundary() {
  const workspace = { id: 'workspace', serverId: homeId, machineId: target.machineId,
    rootPath: '/repo', projectKey: 'project', createdAtMs: 1 };
  const key = { kind: 'workspace-ref' as const, serverId: homeId, id: workspace.id };
  const rows = [ProjectAccountRowV1Schema.parse({ key, revision: 2, content: { t: 'plain', v: { key, value: workspace } } })];
  const admitted: { actionId: string; path: string; authority: string; kind: string }[] = [];
  async function request(method: string, url: string, body: unknown, headers: unknown) {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const record = headers && typeof headers === 'object' ? headers as Readonly<Record<string, unknown>> : {};
    if ('Authorization' in record) {
      expect(record.Authorization).toBe(`Bearer ${token}`);
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'project-owner' } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.workspace.forget': ['cli'] } },
      } }, version: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Ambient credential reached Project effect: ${path}`);
    }
    const field = (name: string) => typeof record[name] === 'string' ? record[name] as string : '';
    const proof = { authorizationToken: field(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER),
      effectActionId: field(EXTERNAL_ACTION_EFFECT_ACTION_HEADER), machineSignature: field(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER),
      encodedTarget: field(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER), method, path, body };
    const currentness = path.endsWith('/execution-authorization/verify');
    const verified = currentness ? await verifyExternalActionExecutionAuthorizationCurrentness({ ...proof, outerActionId: proof.effectActionId })
      : await verifyExternalActionDomainExecutionRequest(proof);
    if (!verified) return { status: 401, data: { error: 'invalid_token' } };
    expect(verified.principal.accountId).toBe('project-owner');
    if (currentness) return { status: 200, data: { ok: true } };
    expect('authentication' in verified.principal).toBe(true);
    admitted.push({ actionId: verified.binding.actionId, path, authority: verified.principal.authority,
      kind: 'authentication' in verified.principal ? verified.principal.authentication.kind : 'pat' });
    if (path === '/v1/account/project-rows/list') return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
    if (path === '/v1/account/project-rows/read') return projectAccountRowReadResponse(rows, body);
    if (path === '/v1/account/project-rows/mutate') {
      const mutation = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = mutation.mutations.map(value => {
        const index = rows.findIndex(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(value.key));
        const revision = index < 0 ? -1 : rows[index]!.revision;
        expect(value.expectedRevision).toBe(revision < 0 ? 'absent' : revision);
        const row = ProjectAccountRowV1Schema.parse({ key: value.key, revision: revision + 1, content: value.content });
        if (index < 0) rows.push(row); else rows[index] = row;
        return row;
      });
      return { status: 200, data: { status: 'updated', rows: changed, cursor: Math.max(...changed.map(row => row.revision)) } };
    }
    if (path === '/v1/account/authoring-memory') return { status: 200, data: { rows: [] } };
    if (path === '/v1/machines') return { status: 200, data: [] };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/projects/execution/config/read') return { status: 200, data: { status: 'absent' } };
    if (parsed.pathname === '/v1/projects/sources') return { status: 200,
      data: method === 'GET' ? { ok: true, sources: [source], coverage: { complete: true, nextCursor: null } } : { ok: true, source, canManage: true } };
    if (parsed.pathname === '/v1/projects/sources/source%2Fa') return { status: 200,
      data: method === 'DELETE' ? { ok: true, sourceId: source.id, revision: 3 } : { ok: true, source, canManage: true } };
    throw new Error(`Unexpected signed Project effect: ${path}`);
  }
  vi.spyOn(axios, 'get').mockImplementation((url, config) => request('GET', String(url), undefined, config?.headers));
  vi.spyOn(axios, 'post').mockImplementation((url, body, config) => request('POST', String(url), body, config?.headers));
  vi.spyOn(axios, 'request').mockImplementation(config => request(String(config.method).toUpperCase(), String(config.url), config.data, config.headers));
  return { rows, admitted, request };
}

async function original(actionId: SignedRootActionId, input: Readonly<Record<string, JsonValue>>, kind: 'account' | 'terminal' = 'terminal') {
  const envelope = { v: 1 as const, requestId: `request-${actionId}`, target, input };
  const authentication = { kind, tokenEpoch: 1 };
  const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: 'project-owner', authentication,
    serverIdentityId: homeId, machineId: target.machineId, actionId, requestId: envelope.requestId,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target });
  return { envelope, authorization, principal: { accountId: 'project-owner', authentication,
    authority: kind === 'terminal' ? 'account_automation' as const : 'present_user' as const } };
}

async function run(actionId: SignedRootActionId, input: Readonly<Record<string, JsonValue>>, kind: 'account' | 'terminal' = 'terminal') {
  const request = await original(actionId, input, kind);
  expect(await verifyExternalActionExecutionAuthorizationCurrentness({ ...signedProof(request.authorization,
    'POST', bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId), { v: 1, effectActionId: actionId, target }),
    outerActionId: actionId }), 'fixture must have real current Home and Machine admission').not.toBeNull();
  const executor = (context?: RequesterAccountActionContext) => {
    const accountInput = { token, credentials: context?.credentials ?? credentials,
      serverId: profileId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: 'project-installation' };
    return createCliActionExecutorHarness({ ...accountInput, sessionId: 'cli-global', mode: 'plain', ctx: null,
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey: 'project-fixture',
        getAccountSettings: () => context?.savedSecretOperationContext.readSnapshot()?.settings ?? null }),
      ...(context ? { savedSecretOperationContext: context.savedSecretOperationContext } : {}),
      projectWorkerAccountAction: createAccountServerActionDeps(accountInput).projectWorkerAction }).executor;
  };
  return executeExternalAction({ actionId, ...request, executionAuthorization: request.authorization,
    currentMachineId: target.machineId, currentServerId: profileId, currentServerHttpBaseUrl: serverUrl,
    currentInstallationId: 'project-installation', externalActionMachineRequestPrivateKey: installation.secretKey,
    surface: kind === 'terminal' ? 'cli' : 'ui', resolveTarget: async () => target,
    verifyExecutionAuthorization: async () => storage.state.revokedAt === null, executor: executor(),
    prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ ...input,
      purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'project-installation',
      installationPrivateKey: installation.secretKey, serverId: profileId, serverIdentityId: homeId,
      serverHttpBaseUrl: serverUrl, ownCredentials: credentials, isCurrent: async () => storage.state.revokedAt === null,
      createExecutor: executor }),
  });
}

function signedProof(authorization: ExternalActionExecutionAuthorizationV1, method: string, path: string, body?: unknown) {
  const headers = createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: authorization.binding.actionId,
    target, installationId: 'project-installation', privateKey: installation.secretKey, method, path, body });
  return { authorizationToken: headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]!,
    effectActionId: headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]!, machineSignature: headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]!,
    encodedTarget: headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]!, method, path, body };
}

describe('paired terminal Project Account Actions through CLI custody and signed Home verification', () => {
  it('reads Sources as the original paired terminal actor', async () => withHome(async () => {
    const boundary = httpBoundary();
    const result = await run('projects.sources.read', { serverId: homeId, sourceId: source.id });
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: {
      execution: { ok: true, result: { ok: true, source } } } });
    expect(boundary.admitted).toContainEqual({ actionId: 'projects.sources.read', path: `/v1/projects/sources/source%2Fa?serverId=${homeId}`,
      kind: 'terminal', authority: 'account_automation' });
  }));

  it('pins an accepted workspace with portable Home through the real Action executor', async () => withHome(async () => {
    const boundary = httpBoundary();
    const result = await run('projects.workspace.update', { serverId: homeId, workspaceId: 'workspace', pinned: true });
    expect(result, JSON.stringify(result))
      .toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { ok: true, organization: { pinned: true } } } } });
    expect(boundary.rows.find(row => row.key.kind === 'project-organization')?.content).toMatchObject({ t: 'plain', v: { value: { pinned: true } } });
  }));

  it('lists private Projects with current signed requester custody', async () => withHome(async () => {
    const boundary = httpBoundary();
    const result = await run('projects.list', { serverId: homeId });
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
      result: { items: [{ workspaceAddress: { serverId: homeId, workspaceId: 'workspace' } }] } } } });
    expect(boundary.admitted.map(row => row.path)).toContain('/v1/account/authoring-memory');
  }));

  it('keeps visibility, personal context and Forget on the original private Account row owner', async () => withHome(async () => {
    const boundary = httpBoundary();
    const key = { kind: 'project-organization' as const, serverId: homeId, projectKey: 'project' };
    boundary.rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 2, content: { t: 'plain', v: { key, value: {
      hidden: false, pinned: true, promptStack: [{ id: 'entry', ref: { kind: 'doc', artifactId: 'doc', serverId: homeId }, enabled: true,
        placement: 'system_append' }],
    } } } }));
    const visibility = await run('projects.visibility.set', { target: { serverId: homeId, projectKey: 'project' }, expectedRevision: 2, hidden: true });
    expect(visibility, JSON.stringify(visibility)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
      result: { ok: true, row: { hidden: true, pinned: true }, revision: 3 } } } });
    const context = await run('projects.context.update', { target: { serverId: homeId, projectKey: 'project' }, expectedRevision: 3,
      intent: { kind: 'detach', entryId: 'entry' } });
    expect(context, JSON.stringify(context)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
      result: { ok: true, row: { hidden: true, pinned: true, promptStack: [] }, revision: 4 } } } });
    const forget = await run('projects.workspace.forget', { serverId: homeId, workspaceId: 'workspace' });
    expect(forget, JSON.stringify(forget)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
      result: { ok: true, workspaceId: 'workspace' } } } });
    expect(boundary.rows.find(row => row.key.kind === 'workspace-ref')?.content).toBeNull();
    expect(boundary.rows.find(row => row.key.kind === 'project-organization')?.content).toMatchObject({ t: 'plain', v: { value: { pinned: true } } });
    expect(boundary.admitted.every(row => row.kind === 'terminal' && row.authority === 'account_automation')).toBe(true);
  }));

  it('reads worker and desired service preferences through their original signed config-row client', async () => withHome(async () => {
    const boundary = httpBoundary();
    for (const actionId of ['projects.worker.preferences.get', 'projects.service.placement.get'] as const) {
      const result = await run(actionId, { workspace: { serverId: homeId, refId: 'workspace' },
        ...(actionId === 'projects.service.placement.get' ? { serviceName: 'web' } : {}) });
      expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { status: 'ready' } } } });
    }
    expect(boundary.admitted.map(row => row.path)).toContain('/v1/projects/execution/config/read');
    expect(boundary.admitted.every(row => row.kind === 'terminal')).toBe(true);
  }));

  it('translates an admitted local Source Home to the signed portable Home', async () => withHome(async () => {
    const boundary = httpBoundary();
    expect(await run('projects.sources.read', { serverId: profileId, sourceId: source.id }))
      .toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { ok: true, source } } } });
    expect(boundary.admitted[0]?.path).toBe(`/v1/projects/sources/source%2Fa?serverId=${homeId}`);
  }));

  it('spends each Source root only on its own metadata method and Home', async () => {
    const cases = [
      ['projects.sources.list', 'GET', `/v1/projects/sources?serverId=${homeId}`, { serverId: homeId }, undefined],
      ['projects.sources.read', 'GET', `/v1/projects/sources/source%2Fa?serverId=${homeId}`, { serverId: homeId, sourceId: source.id }, undefined],
      ['projects.sources.create', 'POST', '/v1/projects/sources', { serverId: homeId, requestKey: 'create', name: source.name, repository: source.repository }],
      ['projects.sources.update', 'PATCH', '/v1/projects/sources/source%2Fa', { serverId: homeId, sourceId: source.id, expectedRevision: 2, patch: { name: 'Renamed' } }],
      ['projects.sources.delete', 'DELETE', '/v1/projects/sources/source%2Fa', { serverId: homeId, sourceId: source.id, expectedRevision: 2 }],
    ] as const;
    for (const [actionId, method, path, input] of cases) {
      const { authorization } = await original(actionId, input);
      const body = method === 'GET' ? undefined : input;
      expect(await verifyExternalActionDomainExecutionRequest(signedProof(authorization, method, path, body)))
        .toMatchObject({ binding: { actionId }, principal: { accountId: 'project-owner', authority: 'account_automation',
          authentication: { kind: 'terminal' } } });
      const foreignPath = method === 'GET' ? path.replace(homeId, 'srv_foreign') : path;
      const foreignBody = method === 'GET' ? undefined : { ...input, serverId: 'srv_foreign' };
      expect(await verifyExternalActionDomainExecutionRequest(signedProof(authorization, method, foreignPath, foreignBody))).toBeNull();
      expect(await verifyExternalActionDomainExecutionRequest(signedProof(authorization, 'GET', '/v2/account/settings'))).toBeNull();
      expect(await verifyExternalActionDomainExecutionRequest(signedProof(authorization, 'POST', '/v1/account/project-rows/mutate', {}))).toBeNull();
      const tampered = { ...signedProof(authorization, method, path, body), method: method === 'GET' ? 'DELETE' : 'GET' };
      expect(await verifyExternalActionDomainExecutionRequest(tampered)).toBeNull();
    }
  });

  it('refuses foreign Home before any private Project or Source effect', async () => withHome(async () => {
    const boundary = httpBoundary();
    for (const actionId of ['projects.sources.read', 'projects.workspace.update', 'projects.list'] as const) {
      const input = { serverId: 'srv_foreign', ...(actionId === 'projects.sources.read' ? { sourceId: source.id }
        : actionId === 'projects.workspace.update' ? { workspaceId: 'workspace', pinned: true } : {}) };
      expect(await run(actionId, input)).toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'server_scope_mismatch' } } });
    }
    expect(await run('projects.worker.preferences.get', { workspace: { serverId: 'srv_foreign', refId: 'workspace' } }))
      .toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'server_target_mismatch' } } });
    expect(boundary.admitted).toEqual([]);
  }));

  it('limits worker and service roots to strict config requests without lending generic Account authority', async () => {
    const address = { serverId: homeId, refId: 'workspace' };
    const mutation = { address, expectedRevision: 'absent', content: { t: 'plain', v: {
      enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {}, services: {},
    } } };
    for (const actionId of ['projects.worker.preferences.get', 'projects.worker.preferences.set', 'projects.worker.preferences.reset',
      'projects.service.placement.get', 'projects.service.placement.set'] as const) {
      const { authorization } = await original(actionId, { workspace: address });
      const verify = (method: string, path: string, body?: unknown) =>
        verifyExternalActionDomainExecutionRequest(signedProof(authorization, method, path, body));
      expect(await verify('GET', '/v1/account/encryption')).not.toBeNull();
      expect(await verify('POST', '/v1/projects/execution/config/read', { address })).not.toBeNull();
      const write = await verify('POST', '/v1/projects/execution/config/mutate', mutation);
      if (actionId.endsWith('.get')) expect(write).toBeNull(); else expect(write).not.toBeNull();
      expect(await verify('POST', '/v1/projects/execution/config/read', { address, unrelated: true })).toBeNull();
      expect(await verify('POST', '/v1/projects/execution/config/mutate', { ...mutation, expectedRevision: -1 })).toBeNull();
      expect(await verify('GET', '/v2/account/settings')).toBeNull();
      expect(await verify('GET', '/v1/account/encryption?unrelated=true')).toBeNull();
      expect(await verify('POST', '/v1/account/project-rows/mutate', {})).toBeNull();
    }
  });

  it('rejects retired credential and Machine custody on a correctly signed Source read', async () => {
    const { authorization } = await original('projects.sources.read', { serverId: homeId, sourceId: source.id });
    const proof = signedProof(authorization, 'GET', `/v1/projects/sources/source%2Fa?serverId=${homeId}`);
    expect(await verifyExternalActionDomainExecutionRequest(proof)).not.toBeNull();
    storage.account.tokenEpoch = 2;
    expect(await verifyExternalActionDomainExecutionRequest(proof)).toBeNull();
    storage.account.tokenEpoch = 1;
    storage.state.revokedAt = new Date();
    expect(await verifyExternalActionDomainExecutionRequest(proof)).toBeNull();
  });
});
