import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionExecutor, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER, ArtifactBlobWriteV1Schema, ApprovalRequestV2Schema, FeaturesResponseSchema, readLegacyRolesV1, type ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol';
import { buildHomeHubArtifactIdV1, HOME_HUB_ARTIFACT_KIND_V1, HomeHubLayoutV1Schema } from '@happier-dev/protocol/home';
import { BUILTIN_WIDGET_DESCRIPTORS_V1, buildWidgetDefinitionArtifactHeaderV1, WidgetInstanceActionOutputSchemasV1, type WidgetDefinitionV1 } from '@happier-dev/protocol/widgets';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import * as persistence from '@/persistence';
import { configuration } from '@/configuration';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { cmdSessionActionsExecute } from '@/cli/commands/session/actions/execute';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import type { ActionId, ActionExecuteResult } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1, loadPromptLibraryCatalogV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ARTIFACT_HTML_BUNDLE_MIME_V1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import tweetnacl from 'tweetnacl';
import { DOC_EDIT_PROPOSAL_HTTP_PATHS_V1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { DiscussionMessageRefV1Schema } from '@happier-dev/protocol/discussions/messageRefs';
import { AccountNoticeArtifactBodyV1Schema, AccountNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import { ArtifactReadBatchInputV1Schema, ArtifactReadBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), request: vi.fn(), isCancel: () => false }));
vi.mock('axios', () => ({ default: http }));
const machineTransport = vi.hoisted(() => ({ exact: vi.fn() }));
vi.mock('@/session/transport/rpc/machineRpc', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(), callExactMachineRpc: machineTransport.exact,
}));

describe('Account Artifact Actions through the real CLI host composition', () => {
  let root: string;
  const artifactId = '11111111-1111-4111-8111-111111111111';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cli-artifact-actions-'));
    await mkdir(join(root, 'workspace'));
    http.get.mockReset(); http.post.mockReset(); http.put.mockReset(); http.delete.mockReset(); http.request.mockReset();
    machineTransport.exact.mockReset();
    // Machine identity is persistent machine-local configuration, a system boundary.
    await persistence.writeSettings({ schemaVersion: persistence.SUPPORTED_SCHEMA_VERSION,
      onboardingCompleted: true, machineIdByServerId: { [configuration.activeServerId]: 'local-machine' } });
  });
  afterEach(async () => { clearActiveAccountSettingsSnapshot(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
  function deps(onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void) {
    return createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      onPublicLinkIssued,
      sessionId: 'session', mode: 'plain', ctx: null,
      rawSession: { machineId: 'local-machine', path: join(root, 'workspace'),
        metadata: JSON.stringify({ machineId: 'local-machine', path: join(root, 'workspace') }) } });
  }
  function workspaceArtifactExecutor(host: ReturnType<typeof createCliActionDeps>) {
    // These source-custody fixtures model Account-waived Agent operations, not
    // a CLI confirmation that could override authenticated Session identity.
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
      'artifact.create': ['agent'], 'artifact.update': ['agent'], 'artifact.publish_from_file': ['agent'],
    } });
    return createActionExecutor({ ...host,
      isActionApprovalRequired: (actionId, context, input) =>
        isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, input),
    });
  }
  it('reads owned notices through the CLI Inbox without a mounted app, and reports app-only sources as partial', async () => {
    const accountId = 'notice-owner';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const content = AccountNoticeArtifactBodyV1Schema.parse({ v: 1, source: { kind: 'plugin', pluginId: 'qa.notice', itemId: 'stable-item' },
      type: 'update', resolved: false, body: 'Saved notice', page: { pageId: 'notice', subPath: 'stable-item' } });
    const header = AccountNoticeArtifactHeaderV1Schema.parse({ ...content, kind: 'account_notice.v1', status: 'open', title: 'Notice' });
    const row = { id: artifactId, ownerAccountId: accountId, access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const ordinary = { ...row, id: '22222222-2222-4222-8222-222222222222',
      header: encodePlainArtifactStoredContent({ kind: 'document.v1', title: 'Unrelated document' }) };
    let credentialCurrent = true;
    let retireOnList = false;
    http.get.mockImplementation(async (url: string) => {
      const address = new URL(url);
      if (address.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (address.pathname === '/v1/artifacts') {
        if (retireOnList) credentialCurrent = false;
        // The real header inventory omits exact-read exposure facts.
        const headers = [row, ordinary].map(({ body: _body, publicAudience: _audience, ...entry }) => entry);
        return { status: 200, data: artifactListResponse(address.toString(), headers) };
      }
      if (address.pathname === `/v1/artifacts/${artifactId}`) return { status: 200, data: row };
      throw new Error(`Unexpected notice read ${address.pathname}`);
    });
    http.post.mockImplementation(async (url: string, input: unknown) => {
      if (new URL(url).pathname !== '/v1/artifacts/read') throw new Error('Unexpected notice write');
      const { artifactIds } = ArtifactReadBatchInputV1Schema.parse(input);
      // The genuine transport boundary must not open unrelated document bodies.
      expect(artifactIds).toEqual([artifactId]);
      return { status: 200, data: ArtifactReadBatchResponseV1Schema.parse({ items: [
        { artifactId, ok: true, artifact: row, recipientCensus: null },
      ] }) };
    });
    const executor = createCliActionExecutor({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'notice-home', serverHttpBaseUrl: 'https://notice.test', isCredentialCurrent: () => credentialCurrent });
    const context = { surface: 'cli', authority: 'account_automation', bypassApprovals: true } as const;
    const result = await executor.execute('inbox.get', {}, context);
    expect(result).toMatchObject({ ok: true, result: { status: 'partial', accountNoticeIds: [artifactId], items: [
      { producer: 'notice', type: 'update', title: 'Notice', read: false, source: { id: artifactId, serverId: 'notice-home' } },
    ], coverage: { sources: expect.arrayContaining([{ source: 'action_operations', status: 'unavailable', reason: 'device_local' }]) } } });
    if (!result.ok) throw new Error('Expected Inbox result');
    expect(AppShellActionOutputSchemas['inbox.get'].safeParse(result.result).success).toBe(true);
    expect(result.result).toMatchObject({ coverage: { sources: expect.arrayContaining([{ source: 'notices', status: 'complete' }]) } });
    // The selected body read, not a header's claimed privacy, admits the item.
    row.publicAudience = 'retained';
    expect(await executor.execute('inbox.get', {}, context)).toMatchObject({ ok: true, result: { items: [],
      coverage: { sources: expect.arrayContaining([{ source: 'notices', status: 'partial', reason: 'content_unavailable' }]) } } });
    row.publicAudience = 'none';
    expect(await executor.execute('artifact.list', { kind: 'account_notice.v1' }, context)).toMatchObject({ ok: true, result: { items: [] } });
    expect(await executor.execute('artifact.get', { artifactId }, context)).toMatchObject({ ok: true, result: { artifact: { artifactId, header } } });
    expect(await executor.execute('inbox.get', {}, { ...context, expectedAccountId: 'foreign' }))
      .toMatchObject({ ok: false, errorCode: 'forbidden' });
    retireOnList = true;
    expect(await executor.execute('inbox.get', {}, context)).toMatchObject({ ok: false, errorCode: 'credential_scope_retired' });
  });
  it('uses the captured Doc decision proof for read-only Artifact preparation and the encoded decision packet', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const accountId = 'doc-owner';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const target = { kind: 'machine' as const, machineId: 'executor-machine' };
    const authorization = { v: 1, token: 'captured-root-proof', binding: {
      serverIdentityId: 'physical-home', accountId, authentication: { kind: 'account', tokenEpoch: 0 },
      machineId: target.machineId, custodianAccountId: accountId, installationId: 'installation',
      actionId: 'doc.edit.accept', requestId: 'accept-request', requestEnvelopeDigest: 'd'.repeat(43), target,
    } } satisfies ExternalActionExecutionAuthorizationV1;
    const proposalRef = DiscussionMessageRefV1Schema.parse({ kind: 'discussion', discussion: { serverId: 'home', discussionId: 'thread' }, messageId: 'proposal' });
    const expectedRevision = { headerVersion: 1, bodyVersion: 1 };
    const result = { proposalRef, docEditProposalDispositionV1: { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 },
      decidedBy: { accountId, atMs: 1 } } };
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith(`/v1/artifacts/${artifactId}`)) return { status: 200, data: {
        id: artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        header: encodePlainArtifactStoredContent({ title: 'Doc' }), body: encodePlainArtifactStoredContent({ body: 'Passage' }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
      throw new Error(`Unexpected read ${new URL(url).pathname}`);
    });
    http.post.mockResolvedValue({ status: 200, data: result });
    const host = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverIdentityId: 'physical-home', serverHttpBaseUrl: 'https://doc-home.test',
      externalActionMachineRequestPrivateKey: keyPair.secretKey, externalActionMachineInstallationId: 'installation' });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home',
      externalActionExecutionAuthorization: authorization, externalActionTarget: target };
    expect(await host.artifactAction!({ actionId: 'artifact.get', input: { artifactId }, readOnly: true, context }))
      .toMatchObject({ artifact: { artifactId, body: 'Passage' } });
    expect(await host.artifactAction!({ actionId: 'doc.edit.accept', input: { proposalRef, expectedRevision,
      preparation: { doc: { ref: { kind: 'doc', artifactId, serverId: 'home' }, revision: expectedRevision }, body: 'Accepted passage' } }, context })).toEqual(result);
    const requests = [...http.get.mock.calls.map(([url, config]) => ({ method: 'GET', url, body: undefined, config })),
      ...http.post.mock.calls.map(([url, body, config]) => ({ method: 'POST', url, body, config }))];
    expect(requests.some(request => new URL(request.url).pathname === '/v1/account/encryption')).toBe(false);
    expect(requests.at(-1)?.url).toBe(`https://doc-home.test${DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.accept}`);
    for (const request of requests) {
      const headers = request.config.headers;
      expect(headers.Authorization).toBeUndefined();
      expect(headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      const effectActionId = request.method === 'POST' ? 'doc.edit.accept' : 'artifact.get';
      expect(headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe(effectActionId);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId,
        target, installationId: 'installation', requestId: 'accept-request', method: request.method,
        path: new URL(request.url).pathname, body: request.body, publicKey: keyPair.publicKey,
        signature: headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] })).toBe(true);
    }
    // The real composition narrows an ordinary bearer at the incumbent HTTP
    // authority boundary too; a lower invocation never borrows its user's floor.
    http.post.mockImplementation(async (_url, _body, config) => config.headers[AUTHORITY_CEILING_HEADER_V1] === 'account_automation'
      ? { status: 403, data: { error: 'present_user_required' } } : { status: 200, data: result });
    expect(await host.artifactAction!({ actionId: 'doc.edit.decline', input: { proposalRef },
      context: { surface: 'cli', authority: 'account_automation', serverId: 'home' } }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(http.post.mock.lastCall?.[2].headers).toMatchObject({ Authorization: `Bearer ${token}`,
      [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' });
  });
  it('keeps source grants and their reads under the original signed second-opinion invocation', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const accountId = 'source-owner';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const target = { kind: 'machine' as const, machineId: 'executor-machine' };
    const authorization = { v: 1, token: 'second-opinion-root-proof', binding: {
      serverIdentityId: 'physical-home', accountId, authentication: { kind: 'account', tokenEpoch: 0 },
      machineId: target.machineId, custodianAccountId: accountId, installationId: 'installation',
      actionId: 'discussion.second_opinion.start', requestId: 'opinion-request', requestEnvelopeDigest: 'd'.repeat(43), target,
    } } satisfies ExternalActionExecutionAuthorizationV1;
    const grant = { artifactId, principal: { kind: 'account' as const, accountId: 'reviewer' }, accessLevel: 'view' as const };
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith(`/v1/artifacts/${artifactId}`)) return { status: 200, data: {
        id: artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        header: encodePlainArtifactStoredContent({ title: 'Source' }), body: encodePlainArtifactStoredContent({ body: 'Passage' }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
      throw new Error(`Unexpected source read ${new URL(url).pathname}`);
    });
    const granted = { artifactId, ownerAccountId: accountId, access: 'owner', changed: true, grants: [] };
    http.put.mockResolvedValue({ status: 200, data: granted });
    const host = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverIdentityId: 'physical-home', serverHttpBaseUrl: 'https://source-home.test',
      externalActionMachineRequestPrivateKey: keyPair.secretKey, externalActionMachineInstallationId: 'installation' });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home',
      externalActionExecutionAuthorization: authorization, externalActionTarget: target };
    await expect(host.artifactAccessAction!({ actionId: 'artifact.access.grants.set', input: grant, context })).resolves.toEqual(granted);
    expect(http.put.mock.calls[0]?.[1]).toEqual(grant);
    const requests = [...http.get.mock.calls.map(([url, config]) => ({ method: 'GET', url, body: undefined, config })),
      ...http.put.mock.calls.map(([url, body, config]) => ({ method: 'PUT', url, body, config }))];
    expect(requests.some(request => new URL(request.url).pathname === '/v1/account/encryption')).toBe(false);
    for (const request of requests) {
      const headers = request.config.headers;
      expect(headers.Authorization).toBeUndefined();
      expect(headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('artifact.access.grants.set');
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: 'artifact.access.grants.set',
        target, installationId: 'installation', requestId: 'opinion-request', method: request.method,
        path: new URL(request.url).pathname, body: request.body, publicKey: keyPair.publicKey,
        signature: headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] })).toBe(true);
    }
    http.get.mockClear(); http.put.mockClear();
    const unsignedHost = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverIdentityId: 'physical-home', serverHttpBaseUrl: 'https://source-home.test' });
    await expect(unsignedHost.artifactAccessAction!({ actionId: 'artifact.access.grants.set', input: grant, context }))
      .rejects.toMatchObject({ code: 'execution_not_authorized' });
    expect(http.get).not.toHaveBeenCalled();
    expect(http.put).not.toHaveBeenCalled();
  });
  it('creates the same host-derived editable guide starter through CLI Action admission without caller provenance', async () => {
    const accountId = 'cli-guide-starter';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const rows: Record<string, unknown>[] = [];
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      throw new Error(`unexpected_get:${url}`);
    });
    http.post.mockImplementation(async (_url: string, wire: unknown) => {
      const input = readCarrierMutation(wire);
      const row = { ...input, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      rows.push(row);
      return { status: 200, data: row };
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'cli-guide-home', serverHttpBaseUrl: 'https://cli-guide.test' }));
    const context = { surface: 'cli', authority: 'present_user', bypassApprovals: true,
      presentUserConfirmation: { actionId: 'prompt_doc.create' } } as const;
    expect(await executor.execute('prompt_doc.create', { starter: 'happier_guide' }, context))
      .toMatchObject({ ok: true, result: { ok: true, artifactId: expect.any(String) } });
    expect(rows).toHaveLength(1);
    expect(decodePlainArtifactStoredContent(String(rows[0]!.header))).toMatchObject({ kind: 'prompt_doc.v2', origin: 'built_in', locked: false });
    expect(await executor.execute('prompt_doc.create', { title: 'Forged', markdown: 'Caller content', origin: 'built_in' }, context))
      .toMatchObject({ ok: false });
    expect(rows).toHaveLength(1);
  });
  it('refuses generic deletion of a retained Role when current guidance is malformed, without blocking unrelated documents', async () => {
    const accountId = 'retained-guidance-deletion-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const [retainedRole] = readLegacyRolesV1({ executionRunsGuidanceEntries: [
      { id: 'retained-role', description: 'Retained guidance' },
    ] }, accountId);
    if (!retainedRole) throw new Error('Expected retained Role identity');
    const unrelatedRoleId = '22222222-2222-4222-8222-222222222222';
    const unclassifiedId = '33333333-3333-4333-8333-333333333333';
    const corruptedDocumentId = '44444444-4444-4444-8444-444444444444';
    let rawSettings: Readonly<Record<string, unknown>> = {
      executionRunsGuidanceEntries: [{ id: 'retained-role', description: null }],
    };
    let retainedKind = 'role.v1';
    const wireRow = (id: string) => ({ id, header: encodePlainArtifactStoredContent({
      ...(id === unclassifiedId ? {} : { kind: id === retainedRole.artifactId ? retainedKind : id === artifactId || id === corruptedDocumentId ? 'document.v1' : 'role.v1' }), title: 'Retained content',
    }), body: encodePlainArtifactStoredContent(id === corruptedDocumentId ? { corruptBody: true } : { body: 'Retained content' }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1,
        content: { t: 'plain', v: rawSettings } } };
      const id = new URL(url).pathname.split('/').at(-1);
      if (id === retainedRole.artifactId || id === unrelatedRoleId || id === artifactId || id === unclassifiedId || id === corruptedDocumentId) return { status: 200, data: wireRow(id) };
      throw new Error(`unexpected_get:${url}`);
    });
    http.delete.mockResolvedValue({ status: 200, data: { success: true } });
    // CLI composition starts inside the authenticated Account lifetime. Load
    // actual catalog records through its owner rather than mocking admission.
    const promptLibraryCatalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
      readRows: async () => ({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
        key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
      })) }),
    });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(rawSettings), rawSettings,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], promptLibraryCatalog,
      scopeKey: runWithServerHttpBaseUrl('https://retained-guidance-deletion.test', () => resolveAccountSettingsScopeKeyForToken(token)) });
    const hostDeps = createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'retained-guidance-deletion',
      serverHttpBaseUrl: 'https://retained-guidance-deletion.test' });
    const executor = createActionExecutor(hostDeps);
    const context = { surface: 'cli', authority: 'present_user', bypassApprovals: true,
      presentUserConfirmation: { actionId: 'artifact.delete' } } as const;
    expect(await executor.execute('artifact.delete', { artifactId: retainedRole.artifactId,
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
    expect(http.delete).not.toHaveBeenCalled();
    expect(await executor.execute('artifact.delete', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: true, result: { artifactId, deleted: true } });
    expect(await executor.execute('artifact.delete', { artifactId: unrelatedRoleId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: true, result: { artifactId: unrelatedRoleId, deleted: true } });
    // The public frontdoor already opens content for actual-kind admission.
    // Exercise the real host adapter separately so this guard adds no body read.
    if (!hostDeps.artifactAction) throw new Error('Expected Artifact host adapter');
    const corruptDeletion = await hostDeps.artifactAction({ actionId: 'artifact.delete',
      input: { artifactId: corruptedDocumentId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context });
    expect(corruptDeletion, JSON.stringify(corruptDeletion)).toMatchObject({ artifactId: corruptedDocumentId, deleted: true });
    rawSettings = { executionRunsGuidanceEntries: [{ id: 'retained-role', description: null }, { description: 'Missing identity' }] };
    retainedKind = 'document.v1';
    http.delete.mockClear();
    expect(await executor.execute('artifact.delete', { artifactId: retainedRole.artifactId,
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
    expect(http.delete).not.toHaveBeenCalled();
    rawSettings = { executionRunsGuidanceEntries: null };
    http.delete.mockClear();
    expect(await executor.execute('artifact.delete', { artifactId: unrelatedRoleId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
    expect(http.delete).not.toHaveBeenCalled();
    expect(await executor.execute('artifact.delete', { artifactId: unclassifiedId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
    expect(http.delete).not.toHaveBeenCalled();
    expect(await executor.execute('artifact.delete', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: true, result: { artifactId, deleted: true } });
  });
  it.each(['declarative', 'builtin'] as const)('projects authored %s Home size and catalog availability without rewriting stale saved intent', async bodyKind => {
    const accountId = 'authored-home-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const homeArtifactId = buildHomeHubArtifactIdV1(accountId);
    const definition: WidgetDefinitionV1 = { v: 1, id: artifactId, name: 'Authored',
      sizeDeclaration: { sizes: ['wide'], defaultSize: 'wide' },
      body: bodyKind === 'builtin' ? { kind: 'builtin', id: 'usage_daily' }
        : { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Hello' } } },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
      provenance: { source: { kind: 'authored' } } };
    const instance = { v: 1 as const, id: 'authored-copy', definition: { kind: 'artifact' as const, artifactId }, bindings: {} };
    const layout = HomeHubLayoutV1Schema.parse({ v: 1, order: [instance.id], hidden: [],
      items: [{ kind: 'widget', instance, size: 'medium', frameStyle: 'plain' }] });
    const wireRow = (id: string, header: Readonly<Record<string, unknown>>, body?: string) => ({ id,
      header: encodePlainArtifactStoredContent(header), ...(body ? { body: encodePlainArtifactStoredContent({ body }) } : {}),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    let inventoryReads = 0;
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (new URL(url).pathname === '/v1/artifacts') {
        inventoryReads += 1;
        const items = [wireRow(artifactId, buildWidgetDefinitionArtifactHeaderV1(definition))];
        return { status: 200, data: new URL(url).searchParams.has('kind') ? { items, hasUnclassified: false } : items };
      }
      if (new URL(url).pathname === `/v1/artifacts/${artifactId}/access/grants`) return { status: 200,
        data: { artifactId, ownerAccountId: accountId, access: 'owner', grants: [] } };
      if (new URL(url).pathname === `/v1/artifacts/${artifactId}/access/recipients`) return { status: 200,
        data: { artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, callerDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          provenanceDataEncryptionKey: null, callerProvenanceDataEncryptionKey: null, recipients: [] } };
      if (url.endsWith(`/v1/artifacts/${artifactId}`)) return { status: 200,
        data: wireRow(artifactId, buildWidgetDefinitionArtifactHeaderV1(definition), JSON.stringify(definition)) };
      if (url.endsWith(`/v1/artifacts/${homeArtifactId}`)) return { status: 200,
        data: wireRow(homeArtifactId, { kind: HOME_HUB_ARTIFACT_KIND_V1, v: 1 }, JSON.stringify(layout)) };
      throw new Error(`unexpected_get:${url}`);
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'authored-home', serverHttpBaseUrl: 'https://authored-home.test' }));
    const described = await executor.execute('home.hub.layout.get', {}, { surface: 'cli', bypassApprovals: true });
    expect(described, JSON.stringify(described))
      .toMatchObject({ ok: true, result: { layout, sections: expect.arrayContaining([
        expect.objectContaining({ id: instance.id, size: 'wide', frameStyle: 'plain' }),
      ]) } });
    // Describing Home reads the definitions it places by id; the Account's whole artifact inventory is not paged for it.
    expect(inventoryReads).toBe(0);
    const catalog = await executor.execute('widgets.catalog.list', { surface: { serverId: 'authored-home', accountId, owner: { kind: 'home' } } },
      { surface: 'cli', bypassApprovals: true });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) throw new Error(catalog.errorCode);
    const entries = WidgetInstanceActionOutputSchemasV1['widgets.catalog.list'].parse(catalog.result).entries;
    expect(entries.find(entry => entry.definition.kind === 'artifact' && entry.definition.artifactId === artifactId))
      .toMatchObject({ definition: { kind: 'artifact', artifactId }, availability: 'available', instanceCount: 1 });
    expect(http.post.mock.calls.filter(([url]) => !String(url).endsWith('/v2/sessions/lookup-by-tags'))).toEqual([]);
  });
  it.each(['widget-area-layout.v1', 'home-hub-layout.v1'])('refuses approved agent public publication of %s before transport', async kind => {
    http.get.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/encryption')
      ? { mode: 'plain', updatedAt: 1 } : { id: artifactId, header: encodePlainArtifactStoredContent({ kind }),
        body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } }));
    const publicShare = { id: 'share-1', subject: { kind: 'artifact', id: artifactId }, expiresAt: null, maxUses: null,
      useCount: 0, isConsentRequired: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
    http.post.mockResolvedValue({ status: 200, data: { publicShare, viewerOrigin: 'https://public.example.test' } });
    const executor = createActionExecutor(deps());
    expect(await executor.execute('artifact.public_link.create', { artifactId }, { surface: 'cli',
      // The host resumes an approved invocation with this canonical execution context.
      bypassApprovals: true, authority: 'present_user',
      actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'session',
      presentUserConfirmation: { actionId: 'artifact.public_link.create' } })).toMatchObject({ ok: false, errorCode: 'artifact_kind_not_shareable' });
    expect(http.post).not.toHaveBeenCalled();
  });
  it('keeps native widgets available without a daemon and edits independent Home copies through the Account Artifact owner', async () => {
    const accountId = 'native-widget-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const homeArtifactId = buildHomeHubArtifactIdV1(accountId);
    const serverId = configuration.activeServerId;
    const copy = (id: string, sessionId: string) => ({ v: 1 as const, id,
      definition: { kind: 'builtin' as const, id: 'session_summary' },
      bindings: { session: { kind: 'value' as const, value: { serverId, sessionId } } } });
    let layout = HomeHubLayoutV1Schema.parse({ v: 1, order: ['one', 'two'], hidden: [],
      items: [{ kind: 'widget', instance: copy('one', 'A') }, { kind: 'widget', instance: copy('two', 'B'), frameStyle: 'plain', size: 'full' }] });
    let version = 1;
    const selectedSessionId = 'c000000000000000000000003';
    const selectedSession = V2SessionByIdResponseSchema.parse({ session: { id: selectedSessionId, seq: 1, createdAt: 1, updatedAt: 1,
      active: false, activeAt: 1, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata: JSON.stringify({ host: 'offline-session-host', path: join(root, 'workspace') }), metadataVersion: 1,
      agentState: null, agentStateVersion: 1,
    } });
    const row = () => ({ id: homeArtifactId,
      header: encodePlainArtifactStoredContent({ kind: HOME_HUB_ARTIFACT_KIND_V1, v: 1, title: 'Home layout' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(layout) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: AccountEncryptionCurrentnessResponseSchema.parse({
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      }) };
      if (new URL(url).pathname === `/v2/sessions/${selectedSessionId}`) return { status: 200,
        data: selectedSession };
      if (new URL(url).pathname === '/v2/sessions' || new URL(url).pathname === '/v2/sessions/active') return { status: 200,
        data: { sessions: [selectedSession.session], nextCursor: null, hasNext: false } };
      if (url.endsWith(`/v1/artifacts/${homeArtifactId}`)) return { status: 200, data: row() };
      throw new Error(`unexpected_get:${url}`);
    });
    http.post.mockImplementation(async (url: string, wire: Record<string, unknown> | Buffer) => {
      if (new URL(url).pathname === '/v2/sessions/query') return { status: 200, data: SessionListQueryResponseV1Schema.parse({
        sessions: [{ ...selectedSession.session, responsibleAccountId: null, responsibleAccount: null,
          effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
          viewer: { latestFailureSeq: null, readState: { state: 'not_started' }, relevance: { relevant: false, reasons: [] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: 'none' }, notification: { level: 'none', source: 'preference' } },
        }], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) };
      expect(url).toBe(`https://native-home.test/v1/artifacts/${homeArtifactId}`);
      const input = readCarrierMutation(wire);
      expect(input.expectedBodyVersion).toBe(version);
      const content = decodePlainArtifactStoredContent(input.body as string);
      if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('invalid Artifact body');
      layout = HomeHubLayoutV1Schema.parse(JSON.parse(content.body));
      version += 1;
      return { status: 200, data: { success: true, headerVersion: version, bodyVersion: version } };
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: selectedSessionId, mode: 'plain', ctx: null, serverId, serverHttpBaseUrl: 'https://native-home.test' }));
    const context = { surface: 'cli', serverId, bypassApprovals: true } as const;
    const described = await executor.execute('home.hub.layout.get', {}, context);
    expect(described, JSON.stringify(described)).toMatchObject({ ok: true, result: {
      availableWidgetIds: BUILTIN_WIDGET_DESCRIPTORS_V1.map(widget => widget.key),
      layout: { items: [{ instance: copy('one', 'A') }, { instance: copy('two', 'B') }] },
    } });
    expect(http.post).not.toHaveBeenCalled();
    const edited = await executor.execute('home.hub.layout.update', { intent: { kind: 'widget_inputs', instanceId: 'one',
      bindings: copy('one', selectedSessionId).bindings } }, context);
    expect(edited, JSON.stringify(edited)).toMatchObject({ ok: true });
    expect(layout.items).toMatchObject([{ instance: copy('one', selectedSessionId) }, { instance: copy('two', 'B'), frameStyle: 'plain', size: 'full' }]);
    expect(layout.items).toHaveLength(2);
  });
  it('creates, updates, reads and publishes private HTML through approved Artifact Actions without byte-bearing URLs', async () => {
    await writeFile(join(root, 'workspace', 'document.html'), '<h1>Published HTML</h1>');
    let row: Record<string, unknown> = {};
    let version = 0;
    http.get.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/encryption')
      ? { mode: 'plain', updatedAt: 1 } : url.endsWith('/html-preview')
      ? { url: `https://isolated.example/a/${row.id}` } : url.includes('/blobs/')
      ? ArtifactBlobWriteV1Schema.parse(row.blob) : row }));
    http.post.mockImplementation(async (_url: string, wire: Record<string, unknown> | Buffer) => {
      const input = readCarrierMutation(wire);
      version += 1;
      row = { ...row, ...input, id: input.id ?? row.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version };
      return { status: 200, data: { ...row, success: true } };
    });
    const executor = workspaceArtifactExecutor(deps());
    const context = { surface: 'cli' as const,
      actionCaller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'session' };
    await expect(executor.execute('artifact.create', { artifactId, header: { kind: 'html' }, body: '<h1>Private HTML</h1>' },
      { ...context, presentUserConfirmation: { actionId: 'artifact.create' } })).resolves.toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 1, bodyVersion: 1 } } });
    await expect(executor.execute('artifact.update', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind: 'html' }, uploadPath: 'document.html' }, { ...context, presentUserConfirmation: { actionId: 'artifact.update' } }))
      .resolves.toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 2, bodyVersion: 2 } } });
    const read = await executor.execute('artifact.get', { artifactId }, context);
    expect(read).toMatchObject({ ok: true, result: { artifact: { header: { kind: 'html' },
      body: { mime: 'text/html', sizeBytes: Buffer.byteLength('<h1>Published HTML</h1>') } } } });
    expect(read).not.toHaveProperty('result.previewUrl');
    expect(read).not.toHaveProperty('result.previewError');
    const published = await executor.execute('artifact.publish_from_file', { path: 'document.html' },
      { ...context, presentUserConfirmation: { actionId: 'artifact.publish_from_file' } });
    expect(published).toEqual({ ok: true, result: { artifactId: row.id, revision: { headerVersion: 3, bodyVersion: 3 } } });
    expect(decodePlainArtifactStoredContent(row.header as string)).toMatchObject({ kind: 'html', mime: 'text/html' });
    expect(http.post.mock.calls.some(([url]) => String(url).includes('/public-shares'))).toBe(false);
    expect(http.get.mock.calls.some(([url]) => String(url).endsWith('/html-preview'))).toBe(false);
  });
  it('publishes a declared folder entrypoint through the approved Artifact Action as the exact acquired bundle', async () => {
    await mkdir(join(root, 'workspace', 'site', 'pages'), { recursive: true });
    await mkdir(join(root, 'workspace', 'site', 'assets'));
    const assets = {
      'pages/index.html': { mime: 'text/html', bytes: Buffer.from('<script type="module" src="../assets/main.js"></script>') },
      'assets/main.js': { mime: 'text/javascript', bytes: Buffer.from('import "./dep.mjs"; fetch("../data.json")') },
      'assets/dep.mjs': { mime: 'text/javascript', bytes: Buffer.from('document.body.dataset.loaded="yes"') },
      'assets/style.css': { mime: 'text/css', bytes: Buffer.from('@font-face {src:url("./font.woff2")}') },
      'assets/icon.png': { mime: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 0, 255]) },
      'assets/font.woff2': { mime: 'font/woff2', bytes: Buffer.from([119, 79, 70, 50, 0, 255]) },
      'data.json': { mime: 'application/json', bytes: Buffer.from('{"value":42}') },
    };
    for (const [path, asset] of Object.entries(assets)) await writeFile(join(root, 'workspace', 'site', path), asset.bytes);
    const bundle = { v: 1, entrypoint: 'pages/index.html', files: Object.fromEntries(Object.entries(assets)
      .map(([path, asset]) => [path, { mime: asset.mime, contentBase64: asset.bytes.toString('base64') }])) };
    let publication: Record<string, unknown> = {};
    http.get.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/encryption')
      ? { mode: 'plain', updatedAt: 1 } : { url: 'https://isolated.example/a/published' } }));
    http.post.mockImplementation(async (_url: string, wire: unknown) => {
      publication = readCarrierMutation(wire);
      return { status: 200, data: { id: publication.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const executor = workspaceArtifactExecutor(deps());
    const context = { surface: 'cli', actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      defaultSessionId: 'session', runtimeAccountId: 'owner', presentUserConfirmation: { actionId: 'artifact.publish_from_file' } } as const;
    const result = await executor.execute('artifact.publish_from_file', { path: 'site', entrypoint: 'pages/index.html', title: 'Experiment' }, context);
    expect(result).toEqual({ ok: true, result: { artifactId: publication.id, revision: { headerVersion: 1, bodyVersion: 1 } } });
    expect(decodePlainArtifactStoredContent(String(publication.header))).toMatchObject({ title: 'Experiment', kind: 'html', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 });
    const blob = ArtifactBlobWriteV1Schema.parse(publication.blob);
    if (!blob.content || blob.content.t !== 'plain') throw new Error('Expected plaintext publication blob');
    expect(JSON.parse(Buffer.from(blob.content.v, 'base64').toString('utf8'))).toEqual(bundle);
    expect(decodePlainArtifactStoredContent(String(publication.provenance))).toMatchObject({ provenance: { source: {
      sessionId: 'session', machineId: 'local-machine', path: 'site',
    } } });
    http.post.mockClear();
    await expect(executor.execute('artifact.publish_from_file', { path: 'site', entrypoint: '../index.html' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    await expect(executor.execute('artifact.publish_from_file', { path: 'site' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'artifact_source_forbidden' });
    expect(http.post).not.toHaveBeenCalled();
  });
  it('lists, revokes and creates owner public links without a mounted delivery consumer', async () => {
    const publicShare = { id: 'share-1', subject: { kind: 'artifact', id: artifactId }, expiresAt: null, maxUses: null,
      useCount: 0, isConsentRequired: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
    http.get.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
      : url.includes('/v1/public-shares') ? { publicShares: [publicShare] }
      : { id: artifactId, header: encodePlainArtifactStoredContent({ title: 'Note' }),
        body: encodePlainArtifactStoredContent({ body: 'note' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } }));
    http.delete.mockResolvedValue({ status: 200, data: { success: true } });
    http.post.mockResolvedValue({ status: 200, data: { publicShare, viewerOrigin: 'https://public.example.test' } });
    const executor = createActionExecutor(deps());
    const context = { surface: 'cli' as const, authority: 'present_user' as const };
    await expect(executor.execute('artifact.public_link.list', { artifactId },
      { ...context, presentUserConfirmation: { actionId: 'artifact.public_link.list' } })).resolves.toEqual({ ok: true, result: { publicShares: [{ ...publicShare, networkOff: false }] } });
    await expect(executor.execute('artifact.public_link.revoke', { artifactId, shareId: 'share-1' },
      { ...context, presentUserConfirmation: { actionId: 'artifact.public_link.revoke' } })).resolves.toMatchObject({ ok: true, result: { revoked: true } });
    await expect(executor.execute('artifact.public_link.create', { artifactId },
      { ...context, presentUserConfirmation: { actionId: 'artifact.public_link.create' } })).resolves.toMatchObject({ ok: true, result: { publicShare, url: expect.stringMatching(/^https:\/\/public.example.test\/s\/[^#]+#k=.+$/) } });
  });
  it.each([
    { actionId: 'artifact.public_link.create', entry: 'host' },
    { actionId: 'session.public_link.create', entry: 'host' },
    { actionId: 'artifact.public_link.create', entry: 'command' },
    { actionId: 'session.public_link.create', entry: 'command' },
  ] as const)(
    '$entry retains $actionId in approval custody when the CLI has not confirmed the public consequence', async ({ actionId, entry }) => {
      const accountId = 'cli-public-link-account';
      const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
      const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
      const serverId = configuration.activeServerId;
      const serverHttpBaseUrl = 'https://cli-public-link.test';
      const sessionId = 'c000000000000000000000001';
      const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {
        serverIdentity: { serverIdentityId: 'srv_cli-public-link' },
      } });
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
        throw new Error(`unexpected_fetch:${path}`);
      }));
      const rows = new Map<string, Record<string, unknown>>();
      rows.set(artifactId, { id: artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ kind: 'html', title: 'Shared visual', requestedCapabilities: { network: 'open' } }),
        body: encodePlainArtifactStoredContent({ body: '<p>Shared visual</p>', mime: 'text/html' }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      const publicWrites: unknown[] = [];
      http.request.mockImplementation(async ({ method, url, data }: { method: string; url: string; data?: unknown }) => {
        if (method === 'POST') return http.post(url, data);
        if (method === 'GET') return http.get(url);
        throw new Error(`unexpected_request:${method}`);
      });
      http.get.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: AccountEncryptionCurrentnessResponseSchema.parse({
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        }) };
        if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
        if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: V2SessionByIdResponseSchema.parse({ session: createSessionRecordFixture({
          id: sessionId, encryptionMode: 'plain', dataEncryptionKey: null,
          metadata: JSON.stringify({ machineId: 'local-machine', path: join(root, 'workspace') }),
        }) }) };
        const id = path.split('/').at(-1)!;
        if (path.startsWith('/v1/artifacts/')) return { status: rows.has(id) ? 200 : 404, data: rows.get(id) };
        throw new Error(`unexpected_get:${path}`);
      });
      // Replace HTTP persistence only: the CLI's credential-derived authority,
      // Action approval policy, carrier codecs and versioned CAS remain real.
      http.post.mockImplementation(async (url: string, wire: unknown) => {
        const path = new URL(url).pathname;
        if (path === '/v1/auth/api-tokens/list') return { status: 200, data: { tokens: [] } };
        if (path === '/v1/artifacts') {
          const mutation = readCarrierMutation(wire);
          const id = String(mutation.id);
          rows.set(id, { ...mutation, id, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
          return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
        }
        if (path.startsWith('/v1/artifacts/')) {
          const id = path.split('/').at(-1)!;
          const current = rows.get(id)!;
          const mutation = readCarrierMutation(wire);
          if (mutation.expectedHeaderVersion !== current.headerVersion || mutation.expectedBodyVersion !== current.bodyVersion) {
            return { status: 200, data: { success: false, error: 'version-mismatch' } };
          }
          const next = { ...current, ...mutation, headerVersion: Number(current.headerVersion) + 1,
            bodyVersion: Number(current.bodyVersion) + 1 };
          rows.set(id, next);
          return { status: 200, data: { success: true, headerVersion: next.headerVersion, bodyVersion: next.bodyVersion } };
        }
        publicWrites.push(wire);
        return { status: 200, data: { publicShare: { id: 'share-1', subject: {
          kind: actionId === 'artifact.public_link.create' ? 'artifact' : 'session',
          id: actionId === 'artifact.public_link.create' ? artifactId : sessionId,
        }, expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false, networkOff: false,
        createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' }, viewerOrigin: 'https://public.example.test' } };
      });
      const executor = createCliActionExecutor({ token, credentials, serverId, serverHttpBaseUrl,
        serverIdentityId: 'srv_cli-public-link', sessionId, mode: 'plain', ctx: null,
        rawSession: { machineId: 'local-machine', path: join(root, 'workspace'),
          metadata: JSON.stringify({ machineId: 'local-machine', path: join(root, 'workspace') }) },
        pluginActionExecutionOwner: 'current_process',
        accountServerActionDeps: createAccountServerActionDeps({ token, credentials, serverId, serverHttpBaseUrl }),
        isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
          credentials, machineId: 'local-machine', serverId, serverApiUrl: serverHttpBaseUrl,
        }),
      });
      const input = actionId === 'artifact.public_link.create' ? { artifactId } : { sessionId };
      // The credential-backed host supplies the exact execution origin. No
      // human stamp or confirmation is supplied: terminal access is not disclosure.
      const context = { surface: 'cli' as const, defaultSessionId: sessionId, serverId,
        serverIdentityId: 'srv_cli-public-link', defaultSessionMachineId: 'local-machine', actionRequestId: 'public-link-request' };
      const invokeCommand = async (requestedActionId: ActionId, requestedInput: unknown): Promise<ActionExecuteResult> => {
        const output = captureConsoleJsonOutput();
        try {
          await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => cmdSessionActionsExecute([
            'actions', 'execute', sessionId, requestedActionId, '--input-json', JSON.stringify(requestedInput), '--json',
          ], { readCredentialsFn: async () => credentials }));
          const envelope = output.json<
            Readonly<{ ok: true; data: { result: unknown } }>
            | Readonly<{ ok: false; error: { code: string; message?: string } }>
          >();
          return envelope.ok ? { ok: true, result: envelope.data.result }
            : { ok: false, errorCode: envelope.error.code, error: envelope.error.message ?? envelope.error.code };
        } finally { output.restore(); }
      };
      const created = entry === 'command' ? await invokeCommand(actionId, input) : await executor.execute(actionId, input, context);
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: expect.any(String) } });
      if (!created.ok || typeof created.result !== 'object' || created.result === null || !('artifactId' in created.result)) {
        throw new Error('Expected durable public-link approval');
      }
      const approvalId = String(created.result.artifactId);
      const readApproval = () => {
        const body = decodePlainArtifactStoredContent(String(rows.get(approvalId)?.body));
        if (!body || typeof body !== 'object' || !('body' in body)) throw new Error('Expected plain approval body');
        return ApprovalRequestV2Schema.parse(JSON.parse(String(body.body)));
      };
      const pending = readApproval();
      expect(pending).toMatchObject({ status: 'open', actionId, actionArgs: input,
        approval: { flow: 'deferred' } });
      expect(publicWrites).toEqual([]);
      const decideInput = { artifactId: approvalId, decision: 'approve' };
      const decided = entry === 'command' ? await invokeCommand('approval.request.decide', decideInput)
        : await executor.execute('approval.request.decide', decideInput, context);
      expect(publicWrites).toEqual([]);
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(readApproval()).toEqual(pending);
      expect(publicWrites).toEqual([]);
      if (entry === 'host') {
        // This is the executor's trusted host boundary, not a CLI input. A
        // confirmation for the decision Action itself does not disclose sharing.
        expect(await executor.execute('approval.request.decide', decideInput, {
          ...context, presentUserConfirmation: { actionId: 'approval.request.decide' },
        })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(readApproval()).toEqual(pending);
        expect(publicWrites).toEqual([]);
        const approved = await executor.execute('approval.request.decide', decideInput, {
          ...context, presentUserConfirmation: { actionId },
        });
        expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(readApproval().status).toBe('executed');
        expect(publicWrites).toHaveLength(1);
      } else {
        expect(await invokeCommand('approval.request.decide', { artifactId: approvalId, decision: 'reject' }))
          .toMatchObject({ ok: true, result: { status: 'rejected' } });
        expect(readApproval().status).toBe('rejected');
        expect(publicWrites).toEqual([]);
      }
    },
  );
  it('returns an approved Artifact fragment link and also notifies an optional mounted host', async () => {
    const issued: ArtifactPublicLinkIssuedV1[] = [];
    const publicShare = { id: 'share-1', subject: { kind: 'artifact', id: artifactId }, expiresAt: null, maxUses: null,
      useCount: 0, isConsentRequired: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
    http.get.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
      : { id: artifactId, header: encodePlainArtifactStoredContent({ title: 'Note' }),
      body: encodePlainArtifactStoredContent({ body: 'note' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } }));
    http.post.mockResolvedValue({ status: 200, data: { publicShare, viewerOrigin: 'https://public.example.test' } });
    const executor = createActionExecutor({ ...deps(link => { issued.push(link); }), isActionApprovalRequired: () => false });
    const result = await executor.execute('artifact.public_link.create', { artifactId },
      { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'artifact.public_link.create' } });
    expect(result).toEqual({ ok: true, result: { publicShare: { ...publicShare, networkOff: false }, url: issued[0]?.url } });
    expect(issued).toHaveLength(1);
    expect(issued[0]?.url).toBe(`https://public.example.test/s/${issued[0]?.lookupId}#k=${issued[0]?.secret}`);
    expect(JSON.stringify(http.post.mock.calls[0]?.[1])).not.toContain(issued[0]?.secret);
    expect(http.post.mock.calls[0]?.[1]).not.toHaveProperty('encryptedDataKey');
  });
  it('creates and reads Account content through the Action executor and existing mode-aware store', async () => {
    let row: unknown;
    http.get.mockImplementation(async (url: string) => ({ status: 200,
      data: url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
        : new URL(url).pathname === '/v1/artifacts' ? artifactListResponse(url, [row]) : row }));
    http.post.mockImplementation(async (_url: string, value: Record<string, unknown>) => {
      row = { ...value, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: { id: value.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const executor = createActionExecutor({ ...deps(), isActionApprovalRequired: () => false });
    await expect(executor.execute('artifact.create', { artifactId, header: { title: 'Note', kind: 'published.v1' }, body: 'note' },
      { surface: 'cli', presentUserConfirmation: { actionId: 'artifact.create' } })).resolves.toMatchObject({ ok: true,
        result: { artifactId, revision: { headerVersion: 1, bodyVersion: 1 } } });
    await expect(executor.execute('artifact.get', { artifactId }, { surface: 'cli' })).resolves.toMatchObject({ ok: true,
      result: { artifact: { artifactId, header: { title: 'Note' }, body: 'note', access: 'owner' } } });
    await expect(executor.execute('artifact.list', { search: 'Note', kind: 'published.v1', sort: 'title_asc' }, { surface: 'cli' }))
      .resolves.toMatchObject({ ok: true, result: { items: [{ artifactId, header: { title: 'Note' } }] } });
  });

  it('preserves quota details through the public Action failure envelope', async () => {
    http.get.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    http.post.mockResolvedValue({ status: 413, data: { error: 'quota_exceeded', budget: 'account', limitBytes: 10, usedBytes: 20 } });
    const executor = createActionExecutor({ ...deps(), isActionApprovalRequired: () => false });
    await expect(executor.execute('artifact.create', { artifactId, header: {}, body: 'note' },
      { surface: 'cli', presentUserConfirmation: { actionId: 'artifact.create' } })).resolves.toMatchObject({
        ok: false, errorCode: 'quota_exceeded', details: { budget: 'account', limitBytes: 10, usedBytes: 20 },
      });
  });

  it('exports authenticated binary bytes to the caller workspace without overwriting or escaping it', async () => {
    const bytes = Buffer.from([0xff, 0, 42]);
    const body = { blobId: '22222222-2222-4222-8222-222222222222', mime: 'application/pdf', sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    http.get.mockImplementation(async (url: string) => ({ status: 200,
      data: url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
        : url.includes('/blobs/') ? { blobId: body.blobId, content: { t: 'plain', v: bytes.toString('base64') } }
        : { id: artifactId, header: encodePlainArtifactStoredContent({ kind: 'file', title: 'Binary' }),
          body: encodePlainArtifactStoredContent({ body }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          ownerAccountId: 'owner', access: 'view', encryptionMode: 'plain',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } }));
    const executor = createActionExecutor(deps());
    const context = { surface: 'cli' as const, authority: 'present_user' as const,
      serverId: configuration.activeServerId, defaultSessionMachineId: 'local-machine', actionRequestId: 'export-binary-request',
      actionCaller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      defaultSessionId: 'session', presentUserConfirmation: { actionId: 'artifact.export' as const } };
    http.post.mockImplementation(async (url: string, wire: unknown) => {
      // Short Session ids resolve through the indexed tag lookup first; the foreign id matches nothing.
      if (url.endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      const input = readCarrierMutation(wire);
      return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const input = { artifactId, path: 'downloads/binary.pdf' };
    const admission = await executor.execute('artifact.export', input, context);
    // Session callers retain Agent approval even with a CLI hint. This fixture has no human-decision transport.
    expect(admission, JSON.stringify(admission)).toMatchObject({
      ok: false, errorCode: 'approvals_not_supported',
    });
    await expect(readFile(join(root, 'workspace/downloads/binary.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
    const approval = readCarrierMutation(http.post.mock.calls[0]?.[1]);
    const envelope = decodePlainArtifactStoredContent(approval.body as string);
    if (!envelope || typeof envelope !== 'object' || !('body' in envelope) || typeof envelope.body !== 'string') {
      throw new Error('invalid_approval_body');
    }
    expect(JSON.parse(envelope.body)).toMatchObject({
      status: 'open', actionId: 'artifact.export', actionArgs: input,
      executionOriginV1: { surface: 'agent', serverId: configuration.activeServerId, machineId: 'local-machine' },
    });
    // The host's approved replay is a trusted invocation boundary, not an Action input or policy mock.
    const approvedContext = { ...context, bypassApprovals: true };
    const result = await executor.execute('artifact.export', input, approvedContext);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { artifactId, path: 'downloads/binary.pdf', sizeBytes: bytes.length } });
    expect(await readFile(join(root, 'workspace/downloads/binary.pdf'))).toEqual(bytes);
    await writeFile(join(root, 'workspace/downloads/binary.pdf'), 'keep');
    expect(await executor.execute('artifact.export', { artifactId, path: 'downloads/binary.pdf' }, approvedContext)).toMatchObject({ ok: false });
    expect(await readFile(join(root, 'workspace/downloads/binary.pdf'), 'utf8')).toBe('keep');
    expect(await executor.execute('artifact.export', { artifactId, path: '../private.pdf' }, approvedContext))
      .toMatchObject({ ok: false, errorCode: 'artifact_destination_forbidden' });
    await symlink(root, join(root, 'workspace/escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await executor.execute('artifact.export', { artifactId, path: 'escape/private.pdf' }, approvedContext))
      .toMatchObject({ ok: false, errorCode: 'artifact_destination_forbidden' });
    const wrongHost = await executor.execute('artifact.export', { artifactId, path: 'foreign.pdf' },
      { ...approvedContext, actionCaller: { ...context.actionCaller, sessionId: 'foreign' } });
    expect(wrongHost).toMatchObject({ ok: false, errorCode: 'account_encryption_currentness_unavailable' });
    await expect(readFile(join(root, 'workspace/foreign.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
    const remoteMachine = createActionExecutor(createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'session', mode: 'plain', ctx: null,
      rawSession: { machineId: 'remote-machine', path: join(root, 'workspace') } }));
    expect(await remoteMachine.execute('artifact.export', { artifactId, path: 'foreign.pdf' }, approvedContext))
      .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
    await expect(readFile(join(root, 'workspace/foreign.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates and updates binary content only from the host-proved caller workspace', async () => {
    const bytes = Buffer.from([0xff, 0, 42]);
    await writeFile(join(root, 'workspace', 'image.png'), bytes);
    let row: Record<string, unknown> = {};
    http.get.mockImplementation(async (url: string) => ({ status: 200,
      data: url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 } : row }));
    http.post.mockImplementation(async (_url: string, wire: Record<string, unknown> | Buffer) => {
      const input = readCarrierMutation(wire);
      row = { ...row, ...input, id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: { ...row, success: true } };
    });
    const executor = workspaceArtifactExecutor(deps());
    const caller = { surface: 'cli' as const,
      actionCaller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'session' };
    await expect(executor.execute('artifact.create', { artifactId, header: {}, uploadPath: 'image.png', mime: 'image/png' },
      { ...caller, presentUserConfirmation: { actionId: 'artifact.create' } })).resolves.toMatchObject({ ok: true });
    expect(row.blob).toMatchObject({ content: { t: 'plain', v: bytes.toString('base64') } });
    await expect(executor.execute('artifact.update', { artifactId, header: {}, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      uploadPath: 'image.png', mime: 'image/png' }, { ...caller, presentUserConfirmation: { actionId: 'artifact.update' } }))
      .resolves.toMatchObject({ ok: true });
    http.post.mockClear();
    await expect(executor.execute('artifact.create', { header: {}, uploadPath: '../private.png' },
      { ...caller, presentUserConfirmation: { actionId: 'artifact.create' } })).resolves.toMatchObject({ ok: false, errorCode: 'artifact_source_forbidden' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('publishes only the authenticated caller workspace and refuses retargeting identity or another machine', async () => {
    await writeFile(join(root, 'workspace', 'result.txt'), 'result');
    http.get.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    http.post.mockImplementation(async (_url: string, value: { id: string }) => ({ status: 200,
      data: { id: value.id, headerVersion: 1, bodyVersion: 1 } }));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const host = createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'session', mode: 'plain', ctx: null,
      rawSession: { machineId: 'local-machine', path: join(root, 'workspace'),
        metadata: JSON.stringify({ machineId: 'local-machine', path: join(root, 'workspace') }) } });
    const executor = workspaceArtifactExecutor(host);
    const context = { surface: 'cli' as const,
      actionCaller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      defaultSessionId: 'session', runtimeRunId: 'run', presentUserConfirmation: { actionId: 'artifact.publish_from_file' as const } };
    await expect(executor.execute('artifact.publish_from_file', { path: 'result.txt' }, context)).resolves.toMatchObject({ ok: true });
    const written = readCarrierMutation(http.post.mock.calls[0]?.[1]);
    expect(decodePlainArtifactStoredContent(String(written.header))).not.toHaveProperty('source');
    expect(decodePlainArtifactStoredContent(String(written.body))).toEqual({ body: 'result' });
    expect(decodePlainArtifactStoredContent(String(written.provenance))).toMatchObject({ provenance: {
      savedBy: { kind: 'agent', accountId: 'owner', sessionId: 'session' },
      source: { sessionId: 'session', runId: 'run', machineId: 'local-machine', path: 'result.txt' },
    } });
    http.post.mockClear();
    await expect(executor.execute('artifact.publish_from_file', { path: 'result.txt', sessionId: 'foreign' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    await expect(host.artifactAction?.({ actionId: 'artifact.publish_from_file', input: { path: 'result.txt' },
      context: { ...context, defaultSessionId: 'foreign' } })).resolves.toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
    const foreign = createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'session', mode: 'plain', ctx: null,
      rawSession: { machineId: 'remote-machine', path: join(root, 'workspace') } });
    await expect(foreign.artifactAction?.({ actionId: 'artifact.publish_from_file', input: { path: 'result.txt' }, context }))
      .resolves.toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
    expect(http.post.mock.calls.filter(([url]) => !String(url).endsWith('/v2/sessions/lookup-by-tags'))).toEqual([]);
  });

  it('never falls back to the ambient Session for an explicit workspace publication source', async () => {
    await writeFile(join(root, 'workspace', 'result.txt'), 'Ambient Session bytes');
    const selectedRoot = join(root, 'selected-workspace');
    await mkdir(selectedRoot);
    await writeFile(join(selectedRoot, 'result.txt'), 'Selected Machine bytes');
    http.get.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    http.post.mockImplementation(async (_url: string, wire: unknown) => ({ status: 200,
      data: { ...readCarrierMutation(wire), headerVersion: 1, bodyVersion: 1 } }));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const remote = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null });
    // Exact-Machine RPC and machine-local identity are system boundaries.
    // Both hosts retain the actual source, transfer and publication owners.
    machineTransport.exact.mockImplementation(async ({ machineId, method, request: input }: { machineId: string; method: string; request: unknown }) => {
        expect(machineId).toBe('other-machine');
        expect(method).toBe(getActionSpec('artifact.publish_from_file').bindings?.rpcMethod);
        const request = TargetedActionRpcRequestV1Schema.parse(input);
        expect(request.target).toMatchObject({ kind: 'machine', machineId: 'other-machine' });
        await persistence.writeSettings({ schemaVersion: persistence.SUPPORTED_SCHEMA_VERSION,
          onboardingCompleted: true, machineIdByServerId: { [configuration.activeServerId]: 'other-machine' } });
        return await remote.artifactAction!({ actionId: 'artifact.publish_from_file', input: request.input,
          context: { surface: 'rpc', runtimeAccountId: 'owner', externalActionTarget: request.target,
            ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}) } });
      });
    const host = createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'session', mode: 'plain', ctx: null,
      rawSession: { machineId: 'local-machine', path: join(root, 'workspace') },
    });
    const context = { surface: 'cli' as const,
      actionCaller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      defaultSessionId: 'session', presentUserConfirmation: { actionId: 'artifact.publish_from_file' as const } };
      await expect(host.artifactAction?.({ actionId: 'artifact.publish_from_file',
        input: { path: 'result.txt', workspace: { machineId: 'other-machine', rootPath: selectedRoot } }, context }))
        .resolves.toMatchObject({ artifactId: expect.any(String) });
      const written = readCarrierMutation(http.post.mock.calls[0]?.[1]);
      expect(decodePlainArtifactStoredContent(String(written.body))).toEqual({ body: 'Selected Machine bytes' });
      expect(decodePlainArtifactStoredContent(String(written.provenance))).toMatchObject({ provenance: {
        source: { machineId: 'other-machine', rootPath: selectedRoot, path: 'result.txt' },
      } });
      expect(decodePlainArtifactStoredContent(String(written.provenance))).not.toHaveProperty('provenance.source.sessionId');
  });
  it('refuses a received workspace publication when local Machine authority is unavailable instead of forwarding again', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const invoke = vi.fn();
    const host = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'selected-machine', invoke } });
    expect(await host.artifactAction!({ actionId: 'artifact.publish_from_file',
      input: { path: 'result.txt', workspace: { machineId: 'selected-machine', rootPath: '/selected' } },
      context: { surface: 'rpc', runtimeAccountId: 'owner', externalActionTarget: { kind: 'machine', machineId: 'selected-machine' } },
    })).toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
    expect(invoke).not.toHaveBeenCalled();
    expect(machineTransport.exact).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });
});
