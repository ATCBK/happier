import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import Fastify from 'fastify';
import { io } from 'socket.io-client';
import { computeContentPublicKeyFingerprint, computeMachineOwnerEnvelopeFingerprintV1, encodeBase64,
    signAccountContentKeyBindingV1, signMachineInstallationProof } from '@happier-dev/protocol';
import { DaemonFilesystemListDirectoryResponseSchema } from '@happier-dev/protocol/machines/fileBrowser';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { callSocketRpc } from '@happier-dev/sync-client';
import type { Fastify as AppFastify } from '../../../../server/sources/app/api/types';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { enableSchemaValidation } from '../../../../server/sources/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '../../../../server/sources/app/api/utils/enableErrorHandlers';
import { enableAuthentication } from '../../../../server/sources/app/api/utils/enableAuthentication';
import { currentAccountStoredContentCompatibilitySocketAuth } from '../../../../server/sources/app/api/testkit/accountStoredContentCompatibility';
import { registerAccountProfileRoute } from '../../../../server/sources/app/api/routes/account/registerAccountProfileRoute';
import { registerAccountEncryptionRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAuthPingRoute } from '../../../../server/sources/app/api/routes/auth/registerAuthPingRoute';
import { machinesRoutes } from '../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { featuresRoutes } from '../../../../server/sources/app/api/routes/features/featuresRoutes';
import { startSocket } from '../../../../server/sources/app/api/socket';
import { auth } from '../../../../server/sources/app/auth/auth';
import { db } from '../../../../server/sources/storage/db';
import { RpcHandlerManager } from '../../../../cli/src/api/rpc/RpcHandlerManager';
import { registerMachineFileBrowserHandlers } from '../../../../cli/src/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '../../../../cli/src/api/machine/machineRpcAuthorization';
import { encrypt } from '../../../../cli/src/api/encryption';
import { Encryption } from '@/sync/encryption/encryption';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { machineFilesystemListDirectory } from './machineFileBrowser';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

describe('recipient directory through real Home, socket and daemon filesystem owners', () => {
    let database: LightSqliteHarness;
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-recipient-directory-', initAuth: true,
            initEncrypt: true, env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 180_000);
    afterAll(async () => {
        await serverScopedRpcSocketPool.stopAll();
        await resetServerReachabilitySupervisors();
        if (database) await database.close();
    });

    it('opens the recipient envelope and lists real files without confusing Account and Machine keys', async () => {
        const ownerSecret = new Uint8Array(randomBytes(32));
        const requesterSecret = new Uint8Array(randomBytes(32));
        const ownerEncryption = await Encryption.create(ownerSecret);
        const requesterEncryption = await Encryption.create(requesterSecret);
        async function account(encryption: Encryption) {
            const signing = tweetnacl.sign.keyPair();
            return db.account.create({ data: { encryptionMode: 'e2ee', publicKey: Buffer.from(signing.publicKey).toString('hex'),
                contentPublicKey: new Uint8Array(encryption.contentDataKey), contentPublicKeySig: signAccountContentKeyBindingV1({
                    accountSigningSecretKey: signing.secretKey, contentPublicKey: encryption.contentDataKey,
                }) } });
        }
        const owner = await account(ownerEncryption);
        const requester = await account(requesterEncryption);
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const outsiderToken = await auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user' });
        const installationKeys = tweetnacl.sign.keyPair();
        const installationId = crypto.randomUUID();
        const installationPrivateKey = encodeBase64(installationKeys.secretKey, 'base64url');
        const machineKey = new Uint8Array(randomBytes(32));
        const ownerEnvelope = await ownerEncryption.encryptEncryptionKey(machineKey);
        const requesterEnvelope = await requesterEncryption.encryptEncryptionKey(machineKey);
        const root = join(database.baseDir, 'project');
        await mkdir(join(root, 'src'), { recursive: true });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, active: true,
            installationId, installationPublicKey: new Uint8Array(installationKeys.publicKey),
            dataEncryptionKey: new Uint8Array(ownerEnvelope), metadata: encodeBase64(encrypt(machineKey, 'dataKey', {
                host: 'recipient-directory', platform: 'linux', happyCliVersion: '0.3', homeDir: database.baseDir,
                happyHomeDir: database.baseDir,
            })) } });
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: requester.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await db.machineKeyEnvelope.create({ data: { machineId: machine.id, recipientAccountId: requester.id,
            encryptedDataKey: new Uint8Array(requesterEnvelope), machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(ownerEnvelope),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(requesterEncryption.contentDataKey) } });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        enableSchemaValidation(app); enableErrorHandlers(app); enableAuthentication(app);
        registerAccountProfileRoute(app); registerAccountEncryptionRoutes(app); registerAuthPingRoute(app);
        machinesRoutes(app); featuresRoutes(app); startSocket(app);
        onTestFinished(async () => { await app.close(); });
        const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
        const manager = new RpcHandlerManager({ scopePrefix: machine.id, localMachineId: machine.id,
            encryptionKey: machineKey, encryptionVariant: 'dataKey', authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: machine.id, resolveCustodianAccountId: async () => owner.id, resolveInstallationId: () => installationId,
                verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, serverHttpBaseUrl: endpoint,
                    daemonToken: ownerToken, privateKey: installationPrivateKey }),
            }) });
        registerMachineFileBrowserHandlers({ rpcHandlerManager: manager, workingDirectory: root });
        const daemonSocket = io(endpoint, { path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
            auth: { ...currentAccountStoredContentCompatibilitySocketAuth, token: ownerToken, clientType: 'machine-scoped',
                machineId: machine.id, installationId, installationPublicKey: encodeBase64(installationKeys.publicKey, 'base64url'),
                installationProof: signMachineInstallationProof({ payload: { version: 1, installationId,
                    machineId: machine.id, accountId: owner.id }, privateKey: installationPrivateKey }) } });
        onTestFinished(() => { daemonSocket.disconnect(); });
        let daemonReceipts = 0;
        daemonSocket.on(SOCKET_RPC_EVENTS.REQUEST, (request: SocketRpcRequestPayload, acknowledge: (reply: unknown) => void) => {
            daemonReceipts += 1;
            void manager.handleRequest(request).then(acknowledge, error => acknowledge({ error: String(error) }));
        });
        await new Promise<void>((resolve, reject) => { daemonSocket.once('connect', resolve); daemonSocket.once('connect_error', reject); daemonSocket.connect(); });
        await new Promise<void>(resolve => { daemonSocket.once(SOCKET_RPC_EVENTS.REGISTERED, () => resolve());
            daemonSocket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: `${machine.id}:${RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY}` }); });
        const profile = await upsertServerProfile({ serverUrl: endpoint });
        const credentials = await TokenStorage.setCredentialsForServerUrlWithRollback(endpoint, { serverId: profile.id }, {
            token: requesterToken, secret: encodeBase64(requesterSecret, 'base64url'),
        });
        if (!credentials) throw new Error('Requester credentials unavailable');
        onTestFinished(async () => { expect(await credentials.rollback()).toBe(true); });
        const result = await machineFilesystemListDirectory(machine.id, { path: root, includeFiles: false }, {
            serverId: profile.id, accountId: requester.id,
        });
        expect(result, JSON.stringify({ result, daemonReceipts })).toMatchObject({ ok: true, path: root,
            entries: [expect.objectContaining({ name: 'src', type: 'directory' })] });
        expect(DaemonFilesystemListDirectoryResponseSchema.parse(result)).toEqual(result);
        expect(daemonReceipts).toBe(1);
        const outsiderSocket = io(endpoint, { path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
            auth: { ...currentAccountStoredContentCompatibilitySocketAuth, token: outsiderToken, clientType: 'user-scoped' } });
        onTestFinished(() => { outsiderSocket.disconnect(); });
        await new Promise<void>((resolve, reject) => { outsiderSocket.once('connect', resolve); outsiderSocket.once('connect_error', reject); outsiderSocket.connect(); });
        await expect(callSocketRpc({ socket: outsiderSocket, target: { kind: 'machine', id: machine.id },
            method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY, params: { path: root }, content: { mode: 'plain' }, timeoutMs: 10_000,
        })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(daemonReceipts).toBe(1);
    });
});
