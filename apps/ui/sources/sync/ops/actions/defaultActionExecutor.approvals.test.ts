import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    API_TOKEN_FULL_GRANT_V1, ApprovalRequestSchema, ARTIFACT_PLAIN_DATA_KEY_MARKER,
    MACHINE_PLAIN_DATA_KEY_MARKER, buildApprovalRequestArtifactHeaderV1, encodePlainArtifactStoredContent,
    type AccountApiTokenSummaryV1, type ApprovalRequest,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { PENDING_INPUT_PROTOCOL_VERSION_V3 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

// Only HTTP, device credentials and Socket.IO network acknowledgements are replaced.
// Home/Account policy, Sync, scoped RPC, the Artifact codec and versioned CAS remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const outgoing: SocketRpcRequestPayload[] = [];
let rpcResult: unknown = { ok: true };
installDisconnectedServerSocketBoundary((socket) => {
    socket.connected = true;
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (_event: string, payload: SocketRpcRequestPayload) => {
        outgoing.push(payload);
        return { ok: true, result: rpcResult };
    });
});
const apiTokenSummary = {
    tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'CI deploy', displayPrefix: 'hap_v1_dd03e74b',
    createdAt: '2026-08-22T12:00:00.000Z', lastUsedAt: null, expiresAt: '2026-11-20T12:00:00.000Z',
    hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1,
    parentTokenId: null, activeChildCount: 0, embedConfig: null,
} satisfies AccountApiTokenSummaryV1;
const token = 'hap_v1_' + apiTokenSummary.tokenId + '_' + 'A'.repeat(43);
type Executor = ReturnType<typeof import('./defaultActionExecutor').createDefaultActionExecutor>;
type StoreState = ReturnType<ReturnType<typeof import('@/sync/domains/state/storage').getStorage>['getState']>;
let initialState: StoreState;
let executor: Executor;
let homeId: string;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
const context = () => ({ surface: 'ui' as const, serverId: homeId });

function approvalRequest(actionId: 'session.title.set' | 'session.stop' = 'session.title.set'): ApprovalRequest {
    return ApprovalRequestSchema.parse({
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'mcp', sessionId: 's1' }, requestedSurface: 'mcp',
        executionOriginV1: {
            v: 1, authority: 'account_automation', surface: 'mcp', caller: { kind: 'host' },
            serverId: homeId, sessionId: 's1', target: { kind: 'session', sessionId: 's1' },
            actionId, requestId: 'request-' + actionId,
        },
        actionId, actionArgs: actionId === 'session.stop' ? { sessionId: 's1' } : { sessionId: 's1', title: 'Renamed from approval' },
        summary: actionId === 'session.stop' ? 'Stop session' : 'Set session title',
    });
}
async function seedApproval(id: string, request: ApprovalRequest): Promise<void> {
    const response = await homes.artifacts(homeId).handle('/v1/artifacts', {
        method: 'POST', body: JSON.stringify({
            id, header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }),
    });
    expect(response?.ok).toBe(true);
}
function persistedApproval(id: string): ApprovalRequest {
    return ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(homeId).readPlainBody(id) ?? 'null'));
}
function expectFailedApproval(id: string): void {
    expect(persistedApproval(id)).toMatchObject({
        status: 'failed', decision: { kind: 'approve' }, execution: { ok: false, errorCode: 'approval_stale' },
    });
    expect(outgoing).toEqual([]);
    // Tuple mutations PATCH the Session row; metadata-upgrades is a legitimate
    // background GET. Legacy Socket metadata writes are covered by outgoing.
    expect(homes.requests.filter(({ path, input }) => path === '/v2/sessions/s1' && input !== null)).toEqual([]);
}

describe('createDefaultActionExecutor approvals', () => {
    beforeEach(async () => {
        webLocks = installWebLockManagerMock();
        await homes.reset();
        installHomeGovernanceBoundaries(homes);
        const { getStorage } = await import('@/sync/domains/state/storage');
        initialState = getStorage().getState();
        homeId = await homes.addHome({
            name: 'Approval Home', serverUrl: 'https://approval-actions.test',
            serverIdentityId: 'srv_approval-actions', accountId: 'account-a', currentAccount: true,
        });
        const baseFeatures = createRootLayoutFeaturesResponse();
        const features = createRootLayoutFeaturesResponse({ capabilities: { session: {
            ...baseFeatures.capabilities.session, pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V3 },
        } } });
        homes.answer(homeId, '/v1/features', { body: features });
        homes.answer(homeId, '/v1/features/authenticated', { body: features });
        homes.answer(homeId, '/v2/cursor', { body: { cursor: '0' } });
        const accountCredential = homes.findByServerUrl('https://approval-actions.test')?.token;
        if (!accountCredential) throw new Error('missing_current_account_credential');
        connection = await restoreServerAccountForTest({ serverUrl: 'https://approval-actions.test',
            serverIdentityId: 'srv_approval-actions', accountId: 'account-a', request: homes.request,
            credentials: { token: accountCredential } });
        getStorage().getState().applySettingsForScope({ serverId: connection.serverId, accountId: 'account-a' }, getStorage().getState().settings, 0);
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        getStorage().setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: connection.serverId, active: true }) } });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => homeId });
        await seedApproval('artifact-1', approvalRequest());
        homes.requests.length = 0;
        outgoing.length = 0;
        rpcResult = { ok: true };
    });
    afterEach(async () => {
        await connection.dispose();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        await serverScopedRpcSocketPool.stopAll();
        resetScopedMachineTransportCacheForTests();
        await homes.reset();
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().setState(initialState, true);
        vi.restoreAllMocks();
        webLocks.restore();
    });

    it('exposes the approval replay entry point through the app client executor', async () => {
        await expect(executor.replayApprovedApprovalRequest({ artifactId: 'artifact-missing' }))
            .resolves.toMatchObject({ ok: false, errorCode: 'approval_not_found' });
    });

    it('admits the original Account signed HTTP approval decision at foreign Machine custody', async () => {
        const machineId = 'foreign-controller';
        const installationId = 'foreign-installation';
        const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
        const credential = homes.findByServerUrl('https://approval-actions.test')?.token;
        if (!credential) throw new Error('missing_original_account_credential');
        homes.answer(homeId, '/v1/machines', { body: [{ id: machineId, kind: 'persistent', active: true,
            installationId, installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null,
            replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
            access: { custodian: { accountId: 'foreign-owner', displayName: 'Owner' }, role: 'manage',
                resourceMode: 'plain', accessState: 'ready' } }] });
        const actionId = 'machines.managed.rebuild';
        const nativeInput = { homeId: 'srv_approval-actions', managedMachineId: 'foreign-child', kind: 'rebuild',
            expectedRevision: 4, reviewedEffectDigest: 'a'.repeat(64) };
        const originalEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'original-native-request',
            target: { kind: 'machine', machineId }, input: nativeInput });
        const originalRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-native-home-root', binding: {
            accountId: 'account-a', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_approval-actions',
            machineId, installationId, custodianAccountId: 'foreign-owner', accountEncryptionMode: 'plain',
            actionId, requestId: originalEnvelope.requestId, target: originalEnvelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalEnvelope),
        } });
        await seedApproval('foreign-native-approval', ApprovalRequestSchema.parse({ v: 2, status: 'open', createdAtMs: 1,
            updatedAtMs: 1, createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs: nativeInput,
            approval: { result: 'required', flow: 'deferred' }, summary: 'Reviewed rebuild', executionOriginV1: {
                v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' }, serverId: homeId,
                serverIdentityId: 'srv_approval-actions', accountId: 'account-a', machineId, target: originalEnvelope.target,
                actionId, requestId: originalEnvelope.requestId, externalActionExecutionAuthorization: originalRoot,
                externalActionInputSignature: 's'.repeat(86),
            } }));
        let decisionRequestId: string | undefined;
        homes.answer(homeId, '/v1/actions/approval.request.decide/execution-authorization', { select: body => {
            const mint = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            decisionRequestId = mint.envelope.requestId;
            expect(decisionRequestId).toBeTruthy();
            expect(mint.envelope).toMatchObject({ requestId: decisionRequestId, target: originalEnvelope.target });
            return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fresh-decision-home-root', binding: {
                accountId: 'account-a', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_approval-actions',
                machineId, installationId, custodianAccountId: 'foreign-owner', accountEncryptionMode: 'plain',
                actionId: 'approval.request.decide', requestId: decisionRequestId, target: mint.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(mint.envelope),
            } }) };
        } });
        const nativeResult = { kind: 'conflict', currentRevision: 5 };
        homes.answer(homeId, '/v1/actions/approval.request.decide', { select: body => {
            const carried = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(openExternalActionRequesterAccountContextV1({ authorization: carried.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId, installationId, serverIdentityId: 'srv_approval-actions',
                installationPrivateKey: installation.secretKey })).toEqual({ token: credential });
            if (carried.envelope.v !== 1) throw new Error('expected_plain_account_envelope');
            // The remote HTTP/daemon boundary uses the real canonical Action admission schema.
            const admitted = getActionSpec('approval.request.decide').inputSchema.safeParse(carried.envelope.input);
            if (!admitted.success) return { body: { v: 1, actionId: 'approval.request.decide', requestId: decisionRequestId,
                execution: { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' } } };
            expect(admitted.data).toEqual({ artifactId: 'foreign-native-approval', decision: 'approve',
                serverIdentityId: 'srv_approval-actions', originServerId: homeId });
            expect(persistedApproval('foreign-native-approval')).toMatchObject({ status: 'approved', executionOriginV1: {
                requestId: 'original-native-request', externalActionExecutionAuthorization: originalRoot } });
            expect(JSON.stringify(carried)).not.toContain(credential);
            return { body: { v: 1, actionId: 'approval.request.decide', requestId: decisionRequestId,
                execution: { ok: true, result: nativeResult } } };
        } });
        const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
        const result = await createFrontDoorActionExecute(executor)('approval.request.decide', {
            artifactId: 'foreign-native-approval', decision: 'approve',
        }, { ...context(), expectedAccountId: 'account-a' });
        expect(result, JSON.stringify({ result, paths: homes.requests.map(request => request.path) }))
            .toEqual({ ok: true, result: nativeResult });
        expect(outgoing).toEqual([]);
        const sent = homes.requestsFor('/v1/actions/approval.request.decide');
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ serverId: homeId, token: credential });
    });
    it('routes durable review-comment actions through the shared HTTP action executor', async () => {
        const path = '/v1/reviews/comments?projectId=project-1&states=open&includeHistory=false&limit=50&stored=true';
        homes.answer(homeId, path, { body: { items: [], cursor: null } });
        await expect(executor.execute('reviews.comments.list', { projectId: 'project-1', states: ['open'] }, context()))
            .resolves.toEqual({ ok: true, result: { items: [], cursor: null } });
        expect(homes.requestsFor(path)).toHaveLength(1);
    });
    it('routes permission grants and webhook endpoints through the Action front door dependencies', async () => {
        homes.answer(homeId, '/v1/plugins/permissions/grants/list', { body: { grants: [], pendingRequests: [] } });
        await expect(executor.execute('plugins.permissions.grants.list', { pluginId: 'example.plugin' }, context()))
            .resolves.toEqual({ ok: true, result: { grants: [], pendingRequests: [] } });
        expect(homes.requestsFor('/v1/plugins/permissions/grants/list')[0]?.input).toMatchObject({ pluginId: 'example.plugin' });
        const input = {
            webhookContribution: { pluginId: 'example.github', localId: 'events' },
            targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'example.github' },
            sourceInstanceId: 'channel:github:primary', setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
            idempotencyKey: 'ensure-github-primary-0001',
        } as const;
        homes.answer(homeId, '/v1/plugins/webhooks/endpoints/ensure', { body: {
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', revision: 1,
            publicUrl: 'https://example.test/v1/plugins/webhooks/opaque-route', readiness: 'ready',
        } });
        await expect(executor.execute('plugin.webhook.endpoint.ensure', input, context()))
            .resolves.toMatchObject({ ok: true, result: { readiness: 'ready' } });
        expect(homes.requestsFor('/v1/plugins/webhooks/endpoints/ensure')[0]?.input).toEqual(input);
    });
    it('routes the host-present Account plugin erase action without forwarding generic retry identity metadata', async () => {
        homes.answer(homeId, '/v1/plugins/data/account-erase', { body: { status: 'erased', changed: false } });
        await expect(executor.execute('account.plugins.data.erase', { pluginId: 'example.orphaned-plugin' }, {
            ...context(), actionCaller: { kind: 'host' }, actionRequestId: 'plugin-data-erase-operation-1',
        })).resolves.toMatchObject({ ok: true, result: {
            status: 'completed', settings: { status: 'completed', changed: false }, data: { status: 'completed', changed: false },
        } });
        expect(homes.requestsFor('/v1/plugins/data/account-erase')[0]?.input).toEqual({ pluginId: 'example.orphaned-plugin' });
    });
    it('routes the host-present current-Account sign-out-everywhere action', async () => {
        homes.answer(homeId, '/v1/auth/sessions/sign-out-everywhere', { body: { status: 'signed_out' } });
        await expect(executor.execute('account.sessions.signOutEverywhere', {}, { ...context(), actionCaller: { kind: 'host' } }))
            .resolves.toEqual({ ok: true, result: { status: 'signed_out' } });
        expect(homes.requestsFor('/v1/auth/sessions/sign-out-everywhere')[0]?.input).toEqual({});
    });
    it('routes current-Account API-token Actions through their scoped transport with no caller-selected Account', async () => {
        const input = { tokenId: apiTokenSummary.tokenId, label: apiTokenSummary.label, expiresAt: apiTokenSummary.expiresAt };
        homes.answer(homeId, '/v1/auth/api-tokens/create', { body: { token, apiToken: apiTokenSummary } });
        homes.answer(homeId, '/v1/auth/api-tokens/list', { body: { tokens: [apiTokenSummary] } });
        homes.answer(homeId, '/v1/auth/api-tokens/revoke', { body: { revoked: true } });
        homes.answer(homeId, '/v1/auth/api-tokens/revoke-all', { body: { revokedCount: 1 } });
        const ctx = { ...context(), actionCaller: { kind: 'host' as const }, authority: 'present_user' as const };
        await expect(executor.execute('account.apiTokens.create', input, ctx)).resolves.toEqual({ ok: true, result: { token, apiToken: apiTokenSummary } });
        await expect(executor.execute('account.apiTokens.list', {}, ctx)).resolves.toEqual({ ok: true, result: { tokens: [apiTokenSummary] } });
        await expect(executor.execute('account.apiTokens.revoke', { tokenId: apiTokenSummary.tokenId }, ctx)).resolves.toEqual({ ok: true, result: { revoked: true } });
        await expect(executor.execute('account.apiTokens.revokeAll', {}, ctx)).resolves.toEqual({ ok: true, result: { revokedCount: 1 } });
        expect(homes.requestsFor('/v1/auth/api-tokens/create')[0]?.input).toMatchObject(input);
        for (const request of homes.requests.filter(({ path }) => path.startsWith('/v1/auth/api-tokens/'))) {
            expect(request.serverId).toBe(homeId);
            expect(request.input).not.toHaveProperty('accountId');
        }
    });
    it('preserves the canonical Action preparation lifecycle for current-Account API-token Actions', async () => {
        homes.answer(homeId, '/v1/auth/api-tokens/list', { body: { tokens: [apiTokenSummary] } });
        const prepared = await executor.prepare('account.apiTokens.list', {}, { ...context(), actionCaller: { kind: 'host' } });
        expect(prepared.kind).toBe('ready');
        expect(homes.requestsFor('/v1/auth/api-tokens/list')).toEqual([]);
        if (prepared.kind !== 'ready') throw new Error('expected_ready_action');
        await expect(prepared.invocation.run()).resolves.toEqual({ ok: true, result: { tokens: [apiTokenSummary] } });
    });
    it('routes permission responses through the canonical session permission RPC method', async () => {
        rpcResult = { ok: false, errorCode: 'permission_request_not_found', requestId: 'req-1' };
        await expect(executor.execute('session.permission.respond', {
            sessionId: 's1', requestId: 'req-1', turnId: 'turn-1', decision: 'deny',
        }, context())).resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
        expect(outgoing.at(-1)).toMatchObject({ method: 's1:' + RPC_METHODS.SESSION_PERMISSION_RESPOND, params: { id: 'req-1', turnId: 'turn-1', approved: false } });
    });
    it.each(['permission', 'user-action'] as const)('refuses an unapplied %s response before local recovery or composed abort', async family => {
        const { getStorage } = await import('@/sync/domains/state/storage');
        const store = getStorage();
        store.getState().applySessions([{ ...store.getState().sessions.s1, thinking: true }]);
        store.getState().markSessionOptimisticThinking('s1');
        const original = store.getState().sessions.s1;
        rpcResult = { ok: false, errorCode: 'permission_request_not_found', requestId: 'missing-request' };
        const { sessionRespondToPermission, sessionAllowWithAnswers } = await import('../sessions');
        const pending = family === 'permission'
            ? sessionRespondToPermission('s1', { id: 'missing-request', approved: false, decision: 'abort' }, { serverId: homeId })
            : sessionAllowWithAnswers('s1', 'missing-request', { question: ['answer'] }, { serverId: homeId });
        await expect(pending).rejects.toMatchObject({ rpcErrorCode: 'permission_request_not_found' });
        expect(store.getState().sessions.s1).toBe(original);
        expect(outgoing.map(request => request.method)).toEqual(['s1:' + (family === 'permission'
            ? RPC_METHODS.SESSION_PERMISSION_RESPOND : RPC_METHODS.SESSION_USER_ACTION_ANSWER)]);
    });
    it('projects successful void permission RPC responses through the canonical Action output', async () => {
        rpcResult = undefined;
        await expect(executor.execute('session.permission.respond', { sessionId: 's1', requestId: 'req-1', decision: 'allow' }, context()))
            .resolves.toEqual({ ok: true, result: { ok: true } });
    });
    it('routes owner remote grant management through the canonical session Action transport', async () => {
        rpcResult = { grants: [], nextCursor: null };
        await expect(executor.execute('session.permission.remote.grants.list', { sessionId: 's1' }, context()))
            .resolves.toEqual({ ok: true, result: { grants: [], nextCursor: null } });
        expect(outgoing.at(-1)).toMatchObject({ method: 's1:session.permission.remote.grants.list', params: { sessionId: 's1', limit: 50 } });
    });
    it.each(['applied', 'refused'] as const)('routes user-action answers through the canonical session user-action RPC method (%s)', async outcome => {
        rpcResult = outcome === 'refused'
            ? { ok: false, errorCode: 'permission_response_invalid', requestId: 'user-action-1' } : undefined;
        const result = await executor.execute('session.user_action.answer', {
            sessionId: 's1', requestId: 'user-action-1', decision: 'approve',
            answers: [{ question: 'Where should this run?', values: ['Washington, D.C.', 'Virginia', 'A custom, exact answer'] }],
            reason: ' approved from UI ', updatedPermissions: { allowedTools: ['shell'] },
        }, context());
        expect(result).toEqual(outcome === 'refused'
            ? { ok: false, errorCode: 'permission_response_invalid', error: 'permission_response_invalid' }
            : { ok: true, result: { ok: true } });
        expect(outgoing.at(-1)).toMatchObject({ method: 's1:' + RPC_METHODS.SESSION_USER_ACTION_ANSWER, params: {
            id: 'user-action-1', approved: true, answers: { 'Where should this run?': ['Washington, D.C.', 'Virginia', 'A custom, exact answer'] },
            reason: 'approved from UI', updatedPermissions: { allowedTools: ['shell'] },
        } });
    });
    it('routes session.message.send through the active readiness barrier', async () => {
        homes.answer(homeId, 'POST /v2/sessions/s1/pending', { select: (input) => {
            if (!input || typeof input !== 'object') throw new Error('Expected Pending enqueue request');
            return { body: { didWrite: true, pendingCount: 1, pendingVersion: 1,
                requestedAction: Reflect.get(input, 'requestedAction'),
                pending: { localId: Reflect.get(input, 'localId'), content: Reflect.get(input, 'content'),
                    status: 'queued', position: 1, createdAt: 1, updatedAt: 1,
                    discardedAt: null, discardedReason: null, authorAccountId: 'account-a' } } };
        } });
        const delivery = await executor.execute('session.message.send', { sessionId: 's1', message: 'Hello from action', localId: 'ui-input-1' }, context());
        expect(homes.requestsFor('/v2/sessions/s1/pending'), JSON.stringify({ delivery, requests: homes.requests })).toHaveLength(1);
        expect(homes.requestsFor('/v2/sessions/s1/pending')[0]?.input).toMatchObject({
            localId: 'ui-input-1', requestedAction: { v: 1, kind: 'steer_if_active' },
        });
        expect(delivery).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'ui-input-1' } });
    });
    it('does not replay an MCP approval locally when its exact daemon origin is unavailable', async () => {
        await expect(executor.execute('approval.request.decide', { artifactId: 'artifact-1', decision: 'approve' }, context()))
            .resolves.toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } } });
        expectFailedApproval('artifact-1');
    });
    it('requires an exact Home scope before creating a surfaced UI approval', async () => {
        await homes.requireUiApproval(homeId, 'review.start');
        const signedOutHome = await homes.addHome({ name: 'Signed out', serverUrl: 'https://signed-out-approval.test', accountId: null, active: false });
        await expect(executor.execute('review.start', { sessionId: 's1', engineIds: ['codex'], instructions: 'Needs approval' }, {
            surface: 'ui', serverId: signedOutHome,
        })).rejects.toThrow('action_home_signed_out');
        expect(homes.artifacts(signedOutHome).list()).toEqual([]);
        expect(outgoing).toEqual([]);
    });
    it('does not use local Session cache absence to bypass exact-daemon approval replay', async () => {
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().setState({ sessions: {} });
        await expect(executor.execute('approval.request.decide', { artifactId: 'artifact-1', decision: 'approve' }, context()))
            .resolves.toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_stale' } } });
        expectFailedApproval('artifact-1');
    });
    it('does not replay an approved MCP stop locally without its exact daemon origin', async () => {
        await seedApproval('artifact-stop', approvalRequest('session.stop'));
        await expect(executor.execute('approval.request.decide', { artifactId: 'artifact-stop', decision: 'approve' }, context()))
            .resolves.toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_stale' } } });
        expectFailedApproval('artifact-stop');
    });
    it('fails a legacy directory approval safely when immutable execution origin is unavailable', async () => {
        await seedApproval('artifact-directory-spawn', ApprovalRequestSchema.parse({
            v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'mcp' }, requestedSurface: 'mcp',
            actionId: 'session.spawn_new', actionArgs: {
                creationKey: 'api:directory-approval-1', executionTarget: { serverId: homeId, machineId: 'machine-target' },
                directory: '/repo/new-directory', organizationPlacement: { folderId: null, tagIds: [] },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                initialInput: { text: 'Inspect this repository.' },
            },
            sessionCreationDirectoryApproval: { v: 1, executionTarget: { serverId: homeId, machineId: 'machine-target' }, directory: '/repo/new-directory' },
            summary: 'Create session', serverId: homeId,
        }));
        await expect(executor.execute('approval.request.decide', { artifactId: 'artifact-directory-spawn', decision: 'approve' }, context()))
            .resolves.toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_stale' } } });
        expectFailedApproval('artifact-directory-spawn');
    });
    it('does not let an approval built from a stale open read overwrite a rejection committed before its write', async () => {
        let rejected: unknown;
        homes.artifacts(homeId).beforeNextUpdate(async () => {
            rejected = await executor.execute('approval.request.decide', { artifactId: 'artifact-1', decision: 'reject' }, context());
        });
        const approved = await executor.execute('approval.request.decide', { artifactId: 'artifact-1', decision: 'approve' }, context());
        expect(rejected).toMatchObject({ ok: true, result: { status: 'rejected' } });
        expect(approved).toMatchObject({ ok: false });
        expect(persistedApproval('artifact-1')).toMatchObject({ status: 'rejected', decision: { kind: 'reject' } });
        expect(outgoing).toEqual([]);
    });
    it('routes V2 replay by the current profile while carrying stable Home and immutable origin evidence', async () => {
        homes.answer(homeId, '/v1/machines/machine-exact', { body: { machine: {
            id: 'machine-exact', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } } });
        const { replayApprovedApprovalRequestAtExactDaemon } = await import('./defaultActionExecutor');
        await replayApprovedApprovalRequestAtExactDaemon({ artifactId: 'approval-cross-device', executionTarget: {
            serverId: homeId, serverIdentityId: 'srv_approval-actions', originServerId: 'creator-local-home', machineId: 'machine-exact',
        } });
        expect(outgoing).toMatchObject([{ method: 'machine-exact:' + RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, params: { artifactId: 'approval-cross-device' } }]);
        expect(homes.requestsFor('/v1/machines/machine-exact')[0]?.serverId).toBe(homeId);
    });
});
