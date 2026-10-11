import Fastify, { type FastifyInstance } from 'fastify';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { Server as SocketServer } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import {
    normalizeActionsSettingsV1,
    parseAccountApiTokenCredentialV1,
    signAccountContentKeyBindingV1,
} from '@happier-dev/protocol';

import { auth } from '@/app/auth/auth';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerAccountProfileRoute } from '../account/registerAccountProfileRoute';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { featuresRoutes } from '../features/featuresRoutes';
import { registerAccountApiTokenManagementRoutes } from './registerAccountApiTokenManagementRoutes';
import { registerApiTokenIntrospectionRoute } from './registerApiTokenIntrospectionRoute';
import { registerExternalActionRoutes } from '../actions/registerExternalActionRoutes';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';

type TestRpcHandler = (
    input: unknown,
    context?: Readonly<{ signal: AbortSignal; authorization?: unknown }>,
) => unknown | Promise<unknown>;

type TestSdkClient = Readonly<{
    actions: Readonly<{
        execute: (actionId: string, input: unknown, options?: unknown) => Promise<unknown>;
    }>;
    close: () => Promise<void>;
}>;

async function importTestModule<T>(specifier: string): Promise<T> {
    // This composed integration deliberately crosses workspace source roots at
    // runtime. Keep the server typecheck rooted locally while the real imported
    // implementations remain exercised by Vitest.
    return import(specifier) as Promise<T>;
}

describe('trusted CLI issuance and protected SDK invocation over HTTP', () => {
    let harness: LightSqliteHarness;
    const openedServers: FastifyInstance[] = [];

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-api-token-sdk-',
            initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' },
        });
    }, 120_000);

    afterAll(async () => {
        await Promise.all(openedServers.map((server) => server.close()));
        process.exitCode = 0;
        await harness.close();
    });

    it('creates locally, opens a typed daemon result, and denies a revoked credential at both bootstrap origins', async () => {
        const signing = tweetnacl.sign.keyPair();
        const content = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: {
            publicKey: Buffer.from(signing.publicKey).toString('hex'),
            encryptionMode: 'e2ee',
            contentPublicKey: new Uint8Array(content.publicKey),
            contentPublicKeySig: new Uint8Array(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey, contentPublicKey: content.publicKey,
            })),
        } });
        const interactive = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const serverIdentityId = await getOrCreateServerIdentityId();
        await initializeServerIdentityCache();
        const home = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        openedServers.push(home);
        home.setValidatorCompiler(validatorCompiler);
        home.setSerializerCompiler(serializerCompiler);
        const app = home as unknown as AppFastify;
        enableAuthentication(app);
        registerAccountProfileRoute(app);
        registerAccountEncryptionRoutes(app);
        registerAccountApiTokenManagementRoutes(app);
        registerApiTokenIntrospectionRoute(app);
        featuresRoutes(app);
        const serverUrl = await home.listen({ host: '127.0.0.1', port: 0 });
        harness.resetEnv({
            HAPPIER_HOME_DIR: join(harness.baseDir, 'cli'), HAPPIER_SERVER_URL: serverUrl,
            HAPPIER_PUBLIC_SERVER_URL: serverUrl, HAPPIER_WEBAPP_URL: serverUrl,
            HAPPIER_TOKEN: undefined, HAPPIER_ACCOUNT_SETTINGS_MODE: 'never',
        });

        // CLI configuration must initialize after the isolated Home has its actual TCP origin.
        const { writeCredentialsDataKey } = await importTestModule<{
            writeCredentialsDataKey: (credentials: Readonly<{ token: string; machineKey: Uint8Array; publicKey: Uint8Array }>) => Promise<void>;
        }>('../../../../../../cli/src/persistence');
        const { handleAuthApiTokens } = await importTestModule<{
            handleAuthApiTokens: (args: string[], signal?: AbortSignal) => Promise<void>;
        }>('../../../../../../cli/src/cli/commands/auth/apiTokens');
        const { captureStdout } = await importTestModule<{
            captureStdout: () => Readonly<{ text: () => string; restore: () => void }>;
        }>('../../../../../../cli/src/testkit/logger/captureOutput');
        const { createCliActionExecutorHarness } = await importTestModule<{
            createCliActionExecutorHarness: (options: unknown) => Readonly<{ executor: unknown }>;
        }>('../../../../../../cli/src/session/actions/createCliActionExecutorHarness');
        const { registerDaemonExternalActionRoute } = await importTestModule<{
            registerDaemonExternalActionRoute: (app: FastifyInstance, options: unknown) => void;
        }>('../../../../../../cli/src/daemon/externalActions/registerDaemonExternalActionRoute');
        const { registerExternalActionRpcHandler } = await importTestModule<{
            registerExternalActionRpcHandler: (registrar: unknown, options: unknown) => void;
        }>('../../../../../../cli/src/rpc/handlers/externalAction');
        const { createDaemonPatVerifier } = await importTestModule<{
            createDaemonPatVerifier: (options: unknown) => unknown;
        }>('../../../../../../cli/src/daemon/auth/daemonPatVerifier');
        const { createAccountServerPatIntrospector } = await importTestModule<{
            createAccountServerPatIntrospector: (options: unknown) => unknown;
        }>('../../../../../../cli/src/daemon/auth/accountServerPatIntrospector');
        const { createAccountServerPatEncryptionAccessReader } = await importTestModule<{
            createAccountServerPatEncryptionAccessReader: (options: unknown) => unknown;
        }>('../../../../../../cli/src/daemon/auth/accountServerPatEncryptionAccess');
        const { connect } = await importTestModule<{
            connect: (options: Readonly<{ endpoint: string; token: string }>) => TestSdkClient;
        }>('../../../../../../../packages/sdk/src/connect');
        await writeCredentialsDataKey({ token: interactive, machineKey: content.secretKey, publicKey: content.publicKey });
        const output = captureStdout();
        let encodedCredential = '';
        try {
            await handleAuthApiTokens(['create', '--label', 'Protected SDK', '--encryption', '--yes', '--json']);
            const created = JSON.parse(output.text());
            expect(created.ok, JSON.stringify(created)).toBe(true);
            encodedCredential = created.data.token;
        } finally { output.restore(); }
        const credential = parseAccountApiTokenCredentialV1(encodedCredential);
        expect(credential !== null).toBe(true);
        if (!credential) throw new Error('CLI did not issue an encryption-capable credential');
        expect(credential.accountId).toBe(account.id);
        expect(credential.serverIdentityId).toBe(serverIdentityId);
        const row = await db.accountApiToken.findFirstOrThrow({ where: { accountId: account.id } });
        expect(JSON.stringify(row).includes(credential.wrappingSecret)).toBe(false);
        expect(JSON.stringify(row).includes(encodedCredential)).toBe(false);

        const daemon = Fastify({ logger: false });
        openedServers.push(daemon);
        const requests: string[] = [];
        const responses: string[] = [];
        daemon.addHook('preHandler', async (request) => { requests.push(JSON.stringify(request.body)); });
        daemon.addHook('onSend', async (_request, _reply, payload) => {
            if (typeof payload === 'string') responses.push(payload);
            return payload;
        });
        const target = { kind: 'machine' as const, machineId: 'sdk-machine' };
        const installationIdentity = tweetnacl.sign.keyPair();
        let monotonicNow = 0;
        const ingress = {
            currentServerId: serverIdentityId,
            resolveTarget: async () => target,
            resolveEncryption: async () => ({ serverIdentityId, material: { type: 'dataKey' as const, machineKey: content.secretKey } }),
            executor: createCliActionExecutorHarness({ token: interactive, sessionId: '', mode: 'plain', ctx: null,
                actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {} }) },
            }).executor,
        };
        registerDaemonExternalActionRoute(daemon, {
            ...ingress, currentMachineId: target.machineId,
            verifyPat: createDaemonPatVerifier({ accountId: account.id, monotonicNow: () => monotonicNow,
                introspect: createAccountServerPatIntrospector({ daemonConnectionToken: interactive, serverBaseUrl: serverUrl }),
            }),
            readEncryptionAccess: createAccountServerPatEncryptionAccessReader({ accountId: account.id, serverBaseUrl: serverUrl }),
        });
        const daemonUrl = await daemon.listen({ host: '127.0.0.1', port: 0 });
        const handlers = new Map<string, TestRpcHandler>();
        registerExternalActionRpcHandler({
            registerHandler: (method: string, handler: TestRpcHandler) => { handlers.set(method, handler); },
        }, {
            ...ingress,
            machineId: target.machineId,
            resolveAccountId: async () => account.id,
            externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
        });
        await db.machine.create({ data: {
            id: target.machineId,
            accountId: account.id,
            metadata: 'encrypted-test-metadata',
            installationId: crypto.randomUUID(),
            installationPublicKey: new Uint8Array(installationIdentity.publicKey),
            operationProtocolCapabilities: {
                externalActionExecutionAuthorization: { protocolVersions: [1] },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const relay = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        openedServers.push(relay);
        relay.setValidatorCompiler(validatorCompiler);
        relay.setSerializerCompiler(serializerCompiler);
        enableAuthentication(relay);
        registerAccountApiTokenManagementRoutes(relay);
        const socketServer = new SocketServer();
        const relayBytes: string[] = [];
        registerExternalActionRoutes(relay, { dispatch: createExternalActionDaemonDispatcher({
            io: socketServer,
            // Socket delivery is the system boundary. Authentication, database placement,
            // dispatch framing, daemon admission, execution and result projection stay real.
            forwardRpc: async ({ method, callParams, authorization }) => {
                const handler = handlers.get(method.slice(target.machineId.length + 1));
                if (!handler) throw new Error('Missing daemon RPC handler');
                relayBytes.push(JSON.stringify(callParams));
                const result = await handler(callParams, { signal: new AbortController().signal, authorization });
                relayBytes.push(JSON.stringify(result));
                return { ok: true, result };
            },
        }) });
        const relayUrl = await relay.listen({ host: '127.0.0.1', port: 0 });
        const relayClient = connect({ endpoint: relayUrl, token: encodedCredential });
        const client = connect({ endpoint: daemonUrl, token: encodedCredential });
        try {
            const result = await client.actions.execute('action.spec.get', { id: 'session.message.send' }, { target });
            expect(result).toMatchObject({ actionSpec: { id: 'session.message.send' } });
            expect(await relayClient.actions.execute('action.spec.get', { id: 'session.message.send' }, { target }))
                .toMatchObject({ actionSpec: { id: 'session.message.send' } });
            expect(relayBytes.length).toBe(2);
            expect(relayBytes.some((body) => body.includes('session.message.send') || body.includes(encodedCredential)
                || body.includes(credential.wrappingSecret))).toBe(false);
            expect(requests.some((body) => body.includes('session.message.send'))).toBe(false);
            expect(responses.some((body) => body.includes('session.message.send'))).toBe(false);
            expect(requests.some((body) => body.includes(encodedCredential) || body.includes(credential.wrappingSecret))).toBe(false);
            const revokeOutput = captureStdout();
            try {
                await handleAuthApiTokens(['revoke', row.id, '--yes', '--json']);
                expect(JSON.parse(revokeOutput.text())).toMatchObject({ ok: true, data: { revoked: true } });
            } finally { revokeOutput.restore(); }
            for (const endpoint of [serverUrl, daemonUrl, relayUrl]) {
                const fresh = connect({ endpoint, token: encodedCredential });
                try {
                    await expect(fresh.actions.execute('action.spec.get', { id: 'session.message.send' }, { target }))
                        .rejects.toMatchObject({ status: 401 });
                } finally { await fresh.close(); }
            }
            // An already-open SDK key is not an authorization cache. The daemon's existing
            // monotonic PAT bound, rather than key disposal, decides its next admission.
            monotonicNow = 60_001;
            await expect(client.actions.execute('action.spec.get', { id: 'session.message.send' }, { target }))
                .rejects.toMatchObject({ status: 401 });
            await expect(relayClient.actions.execute('action.spec.get', { id: 'session.message.send' }, { target }))
                .rejects.toMatchObject({ status: 401 });
        } finally {
            await client.close();
            await relayClient.close();
            await relay.close();
            await daemon.close();
            await home.close();
            process.exitCode = 0;
        }
    }, 120_000);
});
