import { randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import {
    AccountSettingsSchema, SessionPendingEnqueueByMachineRequestV1Schema, SessionPendingEnqueueByMachineResponseV1Schema,
    SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, signAccountContentKeyBindingV1,
    encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
} from '@happier-dev/protocol';
import {
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionDaemonDispatchRequestSchema,
    createExternalActionDaemonDispatchResponse, sealExternalActionRequestV2, openExternalActionResponseV2,
    ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema,
    signExternalActionMachineRpcRequestV1, type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol/actions';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1,
    encodeSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { encodeBase64, decodeBase64, encrypt, decryptResult } from '../../../../../cli/src/api/encryption';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { qualifyCurrentAccountStoredContentSocket, currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { registerExternalActionRoutes } from '../routes/actions/registerExternalActionRoutes';
import { registerAccountEncryptionRoutes } from '../routes/account/registerAccountEncryptionRoutes';
import { registerAccountSettingsRoutes } from '../routes/account/registerAccountSettingsRoutes';
import { registerSessionListingRoutes } from '../routes/session/registerSessionListingRoutes';
import { sessionPendingRoutes } from '../routes/session/pendingRoutes';
import { machinesRoutes } from '../routes/machines/machinesRoutes';
import { featuresRoutes } from '../routes/features/featuresRoutes';
import { createExternalActionDaemonDispatcher, resolveCurrentSessionMachineFromServer } from './externalActionDispatcher';
import { buildRpcMethodRoom } from './rpc/rpcMethodRoom';
import { machineUpdateHandler } from './machineUpdateHandler';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { getAccountSessionSocketRoom } from '@/app/api/socketRooms';
import { createCliActionExecutorFromCredentials } from '../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonExternalActionTargetResolver } from '../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { executeExternalAction } from '../../../../../cli/src/daemon/externalActions/executeExternalAction';
import { verifyExternalActionExecutionAuthorizationCurrent, createExternalActionAuthorizedRequestHeaders } from '../../../../../cli/src/api/externalActionExecutionAuthorization';
import { createActionSettingsProvider } from '../../../../../cli/src/settings/actionsSettingsProvider';

describe('original external Session Action currentness composition', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-currentness-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it.each([
        { kind: 'account', accountMode: 'e2ee', sessionMode: 'e2ee' },
        { kind: 'terminal', accountMode: 'e2ee', sessionMode: 'plain' },
        { kind: 'account', accountMode: 'plain', sessionMode: 'plain' },
    ] as const)('sends through real daemon execution for $kind, $accountMode Account, $sessionMode Session', async ({ kind, accountMode, sessionMode }) => {
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(17) };
        const contentKey = nacl.box.keyPair.fromSecretKey(material.machineKey).publicKey;
        const signing = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(accountMode === 'plain' ? 23 : kind === 'account' ? 18 : 22));
        const account = await db.account.create({ data: {
            encryptionMode: accountMode, publicKey: Buffer.from(signing.publicKey).toString('hex'),
            contentPublicKey: contentKey, contentPublicKeySig: signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey, contentPublicKey: contentKey,
            }),
        } });
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
        const installationId = randomUUID();
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: account.id, installationId,
            installationPublicKey: installation.publicKey,
            metadata: accountMode === 'plain' ? encodePlainMachineStoredContent({ host: 'qa8', platform: 'linux', happyCliVersion: 'test' }) : 'opaque',
            ...(accountMode === 'plain' ? { dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } : {}), active: true,
            lastActiveAt: new Date(), operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                sessionInputAdmission: { protocolVersions: [1, 2] } },
        } });
        const metadata = { machineId, path: '/workspace', host: 'qa8', homeDir: '/home/qa8', permissionMode: 'default' };
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error('Canonical owner metadata fixture refused');
        const sessionKey = new Uint8Array(32).fill(24);
        const shared = projectSessionSharedMetadataV1({ metadata });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            encryptionMode: sessionMode, metadataLayoutVersion: 1,
            metadata: sessionMode === 'plain' ? JSON.stringify(shared) : encodeBase64(encrypt(sessionKey, 'dataKey', shared)),
            ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(accountMode === 'plain'
                ? { t: 'plain', v: owner.ownerMetadata } : sealSessionOwnerMetadataEnvelopeV1({
                material, ownerMetadata: owner.ownerMetadata, randomBytes: length => new Uint8Array(length).fill(20),
            })), active: true, lastActiveAt: new Date(),
        } });
        if (sessionMode === 'e2ee') await db.sessionDataKeyEnvelope.create({ data: { sessionId: session.id,
            recipientAccountId: account.id, encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey,
                recipientPublicKey: contentKey, randomBytes: length => new Uint8Array(length).fill(25) }),
        } });
        await db.accessKey.create({ data: { accountId: account.id, machineId, sessionId: session.id, data: 'opaque' } });
        const token = await auth.createToken(account.id, undefined, { kind,
            authority: kind === 'account' ? 'present_user' : 'account_automation' });
        // The installed daemon bearer differs from the external caller. Signed
        // effect reads below must never carry this ambient credential.
        const daemonToken = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const credentials = { token: daemonToken, encryption: accountMode === 'plain' ? null : { ...material, publicKey: contentKey } };
        const homeId = await getOrCreateServerIdentityId();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const httpReads: Array<{ path: string; status: number; signed: boolean; bearer: boolean }> = [];
        app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
            if (request.url.startsWith('/v1/account/encryption/currentness') || request.url.startsWith('/v2/sessions/')) {
                httpReads.push({ path: request.url, status: reply.statusCode,
                    signed: typeof request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'string',
                    bearer: request.headers.authorization !== undefined });
            }
        });
        registerAccountEncryptionRoutes(app);
        registerAccountSettingsRoutes(app);
        registerSessionListingRoutes(app);
        sessionPendingRoutes(app);
        machinesRoutes(app);
        app.get('/v2/sessions/:sessionId/qa8-unbound', { preHandler: app.authenticate,
            config: { apiTokenSessionAction: 'session.transcript.get' } }, async () => ({ exposed: true }));
        featuresRoutes(app);
        const io = new Server(app.server, { path: '/v1/updates', transports: ['websocket'] });
        const presence = createSessionPublisherPresence();
        let receivingSocket: import('socket.io').Socket | undefined;
        let lastAuthorization: ExternalActionExecutionAuthorizationV1 | undefined;
        let received = 0;
        let admittedSockets = 0;
        const ready = new Promise<void>((resolve, reject) => io.on('connection', socket => {
            void (async () => {
                qualifyCurrentAccountStoredContentSocket(socket);
                if (socket.handshake.auth.role === 'session') {
                    socket.data.clientType = 'session-scoped'; socket.data.userId = account.id; socket.data.sessionId = session.id;
                    expect((await presence.registerPublisher({ socket, binding: { accountId: account.id, machineId, sessionId: session.id },
                        completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
                    await socket.join(getAccountSessionSocketRoom(account.id, session.id));
                } else {
                    receivingSocket = socket;
                    socket.data.clientType = 'machine-scoped'; socket.data.userId = account.id;
                    socket.data.machineId = machineId; socket.data.verifiedMachineInstallationId = installationId;
                    machineUpdateHandler(account.id, socket, { operationSocketBatchLimits: {
                        ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
                    } });
                    await socket.join(buildRpcMethodRoom({ userId: account.id, method: `${machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}` }));
                }
                admittedSockets += 1;
                if (admittedSockets === 2) resolve();
            })().catch(reject);
        }));
        app.decorate('resolveCurrentSessionMachine', (input: Readonly<{ accountId: string; sessionId: string }>) =>
            resolveCurrentSessionMachineFromServer({ io, presence, ...input }));
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io, sessionPublisherPresence: presence }) });
        const serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
        const daemon = ioClient(serverHttpBaseUrl, { path: '/v1/updates', transports: ['websocket'], autoConnect: false, reconnection: false });
        const publisher = ioClient(serverHttpBaseUrl, { path: '/v1/updates', transports: ['websocket'], autoConnect: false,
            reconnection: false, auth: { role: 'session' } });
        const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
            serverId: 'qa8-profile', serverApiUrl: serverHttpBaseUrl, serverIdentityId: homeId, machineId,
            externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: installationId,
            actionsSettingsProvider: createActionSettingsProvider({ accountSettings: AccountSettingsSchema.parse({}) }),
            // This adapter represents only the Machine socket network edge. The
            // actual signed enqueue handler and durable Pending owner stay real.
            machineAdmissionTransport: async (request, options) => {
                if (request.v !== 1 || !options?.callerInputAuthorization) throw new Error('Signed Session input required');
                const authorization = options.callerInputAuthorization;
                const parsed = SessionPendingEnqueueByMachineRequestV1Schema.parse(request);
                const { externalAction: _incomingProof, ...unsignedRequest } = parsed;
                const target = { kind: 'session' as const, sessionId: unsignedRequest.sessionId };
                const event = SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1;
                const payload = { ...unsignedRequest, externalAction: { v: 1, authorization, target,
                    effectActionId: 'session.message.send', installationId,
                    machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'session.message.send', target, installationId, event, method: event,
                        requestId: authorization.binding.requestId, params: unsignedRequest, privateKey: installation.secretKey }),
                } };
                const response: unknown = await daemon.emitWithAck(event, payload);
                return SessionPendingEnqueueByMachineResponseV1Schema.parse(response).result;
            },
        });
        const resolveTarget = createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl });
        daemon.on(SOCKET_RPC_EVENTS.REQUEST, async (raw: SocketRpcRequestPayload, acknowledge: (response: unknown) => void) => {
            received += 1;
            const request = ExternalActionDaemonDispatchRequestSchema.parse(raw.params);
            lastAuthorization = request.executionAuthorization;
            const result = await executeExternalAction({ actionId: request.actionId, envelope: request.envelope,
                principal: request.principal, executionAuthorization: request.executionAuthorization,
                currentMachineId: machineId, currentAccountId: account.id, currentServerId: 'qa8-profile',
                currentInstallationId: installationId, currentServerHttpBaseUrl: serverHttpBaseUrl,
                externalActionMachineRequestPrivateKey: installation.secretKey,
                verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
                    privateKey: installation.secretKey, installationId, serverHttpBaseUrl }),
                resolveEncryption: async () => {
                    if (accountMode === 'plain') throw new Error('Plain Action must not request encryption material');
                    return { serverIdentityId: homeId, material };
                }, resolveTarget, executor,
            });
            if (result.kind !== 'response') throw new Error(`Daemon ingress refused: ${result.errorCode}`);
            acknowledge(createExternalActionDaemonDispatchResponse(result.prepared));
        });
        const binding = { serverIdentityId: homeId, accountId: account.id,
            authentication: { kind, tokenEpoch: account.tokenEpoch }, actionId: 'session.message.send',
            requestId: 'qa8-send', target: { kind: 'machine' as const, machineId } };
        const input = { sessionId: session.id, message: 'QA8', localId: 'qa8-input', permissionModeOverride: 'read_only', wait: false };
        const envelope = accountMode === 'e2ee'
            ? sealExternalActionRequestV2({ binding, material, randomBytes: length => new Uint8Array(length).fill(21), input })
            : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId,
                target: { kind: 'session', sessionId: session.id }, input });
        const relay = () => app.inject({ method: 'POST', url: '/v1/actions/session.message.send',
            headers: { authorization: `Bearer ${token}`, 'x-happier-authority-ceiling': 'account_automation' }, payload: envelope });
        try {
            const connected = new Promise<void>((resolve, reject) => { daemon.once('connect', resolve); daemon.once('connect_error', reject); });
            daemon.connect(); publisher.connect(); await connected; await ready;
            expect(await resolveCurrentSessionMachineFromServer({ io, presence, accountId: account.id, sessionId: session.id }))
                .toBe(machineId);
            const response = await relay();
            expect(response.statusCode, response.body).toBe(200);
            const opened = envelope.v === 2
                ? openExternalActionResponseV2({ envelope: response.json(), binding, material, request: envelope })
                : ExternalActionResponseEnvelopeV1Schema.parse(response.json()).execution;
            expect(opened, JSON.stringify({ opened, httpReads, received })).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'qa8-input' } });
            expect(httpReads).toContainEqual({ path: '/v1/account/encryption/currentness', status: 200, signed: true, bearer: false });
            const pending = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } });
            expect(pending).toHaveLength(1);
            const content = pending[0]?.content;
            if (sessionMode === 'plain') expect(content).toMatchObject({ t: 'plain', v: { meta: { permissionMode: 'read-only' } } });
            else {
                if (!content || typeof content !== 'object' || Array.isArray(content) || content.t !== 'encrypted' || typeof content.c !== 'string') {
                    throw new Error('Expected encrypted Pending content');
                }
                expect(decryptResult(sessionKey, 'dataKey', decodeBase64(content.c))).toMatchObject({ status: 'authenticated',
                    value: { meta: { permissionMode: 'read-only' } } });
            }
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).ownerMetadata).toBe(session.ownerMetadata);
            const target = { kind: 'session' as const, sessionId: session.id };
            const signed = (path: string, body?: unknown) => app.inject({ method: 'GET', url: path,
                ...(body === undefined ? {} : { payload: body }), headers: { ...currentAccountStoredContentCompatibilityHeaders,
                    ...createExternalActionAuthorizedRequestHeaders({
                    authorization: lastAuthorization!, effectActionId: 'session.message.send', target,
                    method: 'GET', path, ...(body === undefined ? {} : { body }),
                    installationId, privateKey: installation.secretKey,
                }) } });
            for (const path of ['/v1/account/encryption/currentness?accountId=other', '/v1/account/encryption', '/v2/account/settings']) {
                expect((await signed(path)).statusCode, path).toBe(401);
            }
            expect((await signed(`/v1/machines/${machineId}`)).statusCode).toBe(200);
            expect((await signed('/v1/machines/another-machine')).statusCode).toBe(401);
            expect((await signed('/v2/sessions/foreign-session?accessProjectionVersion=1')).statusCode).toBe(401);
            expect((await signed(`/v2/sessions/${session.id}/qa8-unbound`)).statusCode).toBe(401);
            const foreign = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const foreignToken = await auth.createToken(foreign.id, undefined, { kind: 'account', authority: 'present_user' });
            const foreignResponse = await app.inject({ method: 'POST', url: '/v1/actions/session.message.send',
                headers: { authorization: `Bearer ${foreignToken}` }, payload: ExternalActionRequestEnvelopeV1Schema.parse({
                    v: 1, requestId: 'qa8-foreign', target: binding.target, input,
                }) });
            expect(foreignResponse.statusCode).toBe(200);
            expect(ExternalActionResponseEnvelopeV1Schema.parse(foreignResponse.json()).execution)
                .toMatchObject({ ok: false, errorCode: 'target_not_local' });
            expect(received).toBe(1);
            receivingSocket!.data.verifiedMachineInstallationId = 'misbound-installation';
            const misbound = await relay();
            if (envelope.v === 2) expect(misbound.statusCode).toBe(409);
            else {
                expect(misbound.statusCode).toBe(200);
                expect(ExternalActionResponseEnvelopeV1Schema.parse(misbound.json()).execution)
                    .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            }
            expect(received).toBe(1);
            receivingSocket!.data.verifiedMachineInstallationId = installationId;
            await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await signed('/v1/account/encryption/currentness')).statusCode).toBe(401);
            expect((await relay()).statusCode).toBe(401);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(1);
        } finally { daemon.disconnect(); publisher.disconnect(); await io.close(); await app.close(); }
    });
});
