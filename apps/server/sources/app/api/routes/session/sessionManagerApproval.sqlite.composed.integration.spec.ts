import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import nacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActionExecutor, getActionSpec, normalizeActionsSettingsV1, SessionManagerSetResultV1Schema,
    encodeBase64, encodeSessionOwnerMetadataEnvelopeV1, sealSessionOwnerMetadataEnvelopeV1, SessionSharedMetadataV1Schema,
    buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    type ActionExecuteResult, type ActionExecutorDeps } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerSessionListingRoutes } from './registerSessionListingRoutes';
import { registerSessionManagerRoutes } from './registerSessionManagerRoutes';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';

async function importCliModule<T>(specifier: string): Promise<T> {
    // The server's composed harness consumes the real CLI source without widening its compiler root.
    const loaded = await import(specifier) as T;
    return loaded;
}

// Load the cross-package production graph during collection, outside the scenario's runtime budget.
const { runWithServerHttpBaseUrl } = await importCliModule<{
    runWithServerHttpBaseUrl: <T>(url: string, run: () => Promise<T>) => Promise<T>;
}>('../../../../../../cli/src/api/client/serverHttpBaseUrl');
const { createCliActionDeps } = await importCliModule<{ createCliActionDeps: (options: unknown) => ActionExecutorDeps }>(
    '../../../../../../cli/src/session/actions/createCliActionDeps');
const { createCliApprovalsArtifactStore } = await importCliModule<{ createCliApprovalsArtifactStore: (options: unknown) =>
    Pick<ActionExecutorDeps, 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate'> }>(
    '../../../../../../cli/src/session/actions/approvals/artifactStore');
const { RpcHandlerManager } = await importCliModule<{ RpcHandlerManager: new (options: unknown) => {
    registerHandler: (method: string, handler: (input: unknown) => Promise<unknown>) => void;
    invokeLocal: (method: string, input: unknown,
        options?: { verifiedPeerAuthority: 'present_user' | 'account_automation' }) => Promise<unknown>;
} }>('../../../../../../cli/src/api/rpc/RpcHandlerManager');
const { registerApprovalRpcHandlers } = await importCliModule<{ registerApprovalRpcHandlers: (options: unknown) => void }>(
    '../../../../../../cli/src/rpc/handlers/approvals');
const { createUnavailableActionTransportDeps } = await importCliModule<{ createUnavailableActionTransportDeps: () => ActionExecutorDeps }>(
    '../../../../../../cli/src/testkit/actionTransportDeps');

describe('manager approval replay through registered routes and SQLite', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({
        tempDirPrefix: 'happier-relation-approval-', initEncrypt: true, initFiles: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' },
    }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('settles the committed edge successfully with retryable key readiness; missing wiring cannot commit it', async () => {
        const machineKey = new Uint8Array(32).fill(7);
        const encryption = { type: 'dataKey' as const, machineKey,
            publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey };
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(encryption.publicKey), encryptionMode: 'e2ee' } });
        // An owner Session without a standalone envelope is a real source-key-unavailable input.
        const create = () => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'e2ee', metadataLayoutVersion: 1,
            metadata: JSON.stringify(SessionSharedMetadataV1Schema.parse({ v: 1 })),
            ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(sealSessionOwnerMetadataEnvelopeV1({
                material: encryption, ownerMetadata: { v: 1 }, randomBytes: length => new Uint8Array(length).fill(11),
            })),
        } });
        const [child, lead] = await Promise.all([create(), create()]);
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async (request: FastifyRequest) => { request.headers['x-test-user-id'] = account.id; });
        registerSessionListingRoutes(app);
        registerSessionManagerRoutes(app);
        registerAccountEncryptionRoutes(app);
        artifactsRoutes(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            await runWithServerHttpBaseUrl(origin, async () => {
                const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: account.id,
                    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption };
                const store = createCliApprovalsArtifactStore({ credentials, serverId: 'relation-home' });
                const relation = createCliActionDeps({ token: credentials.token, credentials, sessionId: child.id,
                    serverId: 'relation-home', serverHttpBaseUrl: origin });
                const input = getActionSpec('session.manager.set').inputSchema.parse({
                    sessionId: child.id, managerSessionId: lead.id, expectedManagerSessionId: null,
                });
                const createExecutor = (wired: boolean) => {
                    const rpc = new RpcHandlerManager({ scopePrefix: 'relation-machine', encryptionMode: 'plain', logger: () => {} });
                    const executor = createActionExecutor({
                        ...createUnavailableActionTransportDeps(), ...store,
                        ...(wired ? { sessionManagerSet: relation.sessionManagerSet } : {}),
                        // This authenticated daemon-lifetime witness is an external runtime boundary.
                        isApprovalExecutionOriginCurrent: async ({ origin: executionOrigin }) =>
                            executionOrigin.serverId === 'relation-home' && executionOrigin.accountId === account.id,
                        approvalRequestApprovedReplay: async ({ artifactId }) =>
                            await rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId }) as ActionExecuteResult,
                    });
                    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor });
                    return { executor, rpc };
                };
                const { executor, rpc } = createExecutor(true);
                const pending = await executor.execute('session.manager.set', input, {
                    surface: 'cli', authority: 'account_automation', serverId: 'relation-home', runtimeAccountId: account.id,
                    actionRequestId: 'relation-request', actionCaller: { kind: 'host' },
                    actionsSettings: normalizeActionsSettingsV1({ v: 1,
                        actions: { 'session.manager.set': { approvalRequiredSurfaces: ['cli'] } } }),
                });
                expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                if (!pending.ok || !pending.result || typeof pending.result !== 'object' || !('artifactId' in pending.result)
                    || typeof pending.result.artifactId !== 'string') throw new Error('Expected durable relation approval');
                const artifactId = pending.result.artifactId;
                expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toBeNull();
                const decision = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
                    { surface: 'ui', authority: 'present_user', serverId: 'relation-home', runtimeAccountId: account.id });
                expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
                if (!decision.ok) throw new Error('Relation approval decision failed');
                getActionSpec('approval.request.decide').outputSchema!.parse(decision.result);
                const approved = await store.approvalsGet!({ artifactId, serverId: 'relation-home' });
                expect(approved).toMatchObject({ status: 'executed', execution: { ok: true } });
                if (!approved?.execution?.ok) throw new Error('Committed relation reported a failed approval');
                const output = SessionManagerSetResultV1Schema.parse(approved.execution.result);
                expect(output).toMatchObject({ ok: true, sessionId: child.id, managerSessionId: lead.id,
                    sourceKeyPreparation: { kind: 'waiting' } });
                getActionSpec('session.manager.set').outputSchema!.parse(output);
                const edge = await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: child.id } });
                expect(edge).toMatchObject({ destinationSessionId: lead.id, relation: 'manager' });
                expect(output.ok && output.attachedAt).toBe(edge.attachedAt.getTime());
                const readback = await app.inject({ method: 'GET', url: `/v2/sessions/${child.id}`,
                    headers: buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) });
                expect(readback.statusCode).toBe(200);
                expect(readback.json().session.manager).toEqual({ sessionId: lead.id });
                await expect(rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId }))
                    .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
                expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toEqual(edge);

                // Wiring sensitivity: the real executor cannot reach the writer when its binding is removed.
                const missing = createExecutor(false).executor;
                expect(await missing.execute('session.manager.set', { ...input, managerSessionId: null, expectedManagerSessionId: lead.id },
                    { surface: 'ui', authority: 'present_user', serverId: 'relation-home', bypassApprovals: true }))
                    .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
                expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toEqual(edge);
                // Retrying preparation uses the current parent CAS and never replaces the attachment/frontier.
                expect(await executor.execute('session.manager.set', { ...input, expectedManagerSessionId: lead.id },
                    { surface: 'ui', authority: 'present_user', serverId: 'relation-home', bypassApprovals: true }))
                    .toMatchObject({ ok: true, result: { sourceKeyPreparation: { kind: 'waiting' } } });
                expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toEqual(edge);
            });
        } finally { await app.close(); }
    });
});
