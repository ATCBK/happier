import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { SignedDirectRouteGrantV2Schema } from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import fastify from 'fastify';

import { registerPeerMediationGrantRoutes } from '@/app/api/routes/machines/peer/mediation/registerPeerMediationGrantRoutes';
import { FEATURE_ENV_KEYS } from '@/app/features/catalog/featureEnvSchema';

import { createRouteTestBuilder } from './routeTestBuilder';
import { registerLocalServiceRoutes } from '@/app/api/routes/local/services/registerRoutes';
import { resolvePeerMediationGrantSigningConfig } from '@/app/machines/peer/mediation/mintDirectRouteGrantV1';
import type { Fastify } from '@/app/api/types';

export async function startNativePreviewHomeIntegrationFixture(input: Readonly<{
    accountId: string;
}>): Promise<Readonly<{
    serverUrl: string;
    token: string;
    trustRoots: readonly Readonly<{ keyId: string; publicKey: string }>[];
    close(): Promise<void>;
}>> {
    const token = 'test-account-token';
    const env = {
        NODE_ENV: 'test', HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home', HANDY_MASTER_SECRET: 'w14-composed-test-secret',
        HAPPIER_PUBLIC_SERVER_URL: 'http://127.0.0.1',
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
        [FEATURE_ENV_KEYS.machinesTunnelDirectPeerEnabled]: 'true',
    };
    const signing = resolvePeerMediationGrantSigningConfig(env);
    if (!signing.ok) throw new Error(signing.reasonCode);
    const home = fastify();
    home.decorate('authenticate', async (request: Readonly<{ headers: Record<string, unknown> }>, reply: { code: (status: number) => { send: () => void } }) => {
        if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send();
        Object.assign(request, { userId: input.accountId });
    });
    registerLocalServiceRoutes(home as unknown as Fastify, { env });
    try {
        const serverUrl = await home.listen({ host: '127.0.0.1', port: 0 });
        return {
            serverUrl, token,
            trustRoots: [{ keyId: signing.keyId, publicKey: signing.capability.publicKey }],
            close: async () => { await home.close(); },
        };
    } catch (error) {
        await home.close();
        throw error;
    }
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('loopback address unavailable');
    return (address as AddressInfo).port;
}

export async function startMachineCarrierGrantIntegrationFixture(input: Readonly<{
    accountId: string;
    machineId: string;
    targetEndpointId: string;
    invalidateGrant: boolean;
}>): Promise<Readonly<{
    serverUrl: string;
    signingKeyId: string;
    signingPublicKeyBase64Url: string;
    grantRequests: readonly unknown[];
    grantAuthorizationHeaders: readonly (string | undefined)[];
    close(): Promise<void>;
}>> {
    const signingKeyPair = tweetnacl.sign.keyPair();
    const signingKeyId = 'composed-grant-key';
    const route = createRouteTestBuilder({
        method: 'POST',
        path: '/v1/machines/peer/mediation/route-grants',
        registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
            env: {
                NODE_ENV: 'test',
                [FEATURE_ENV_KEYS.machinesTransferDirectPeerEnabled]: 'true',
                HAPPIER_FEATURE_MACHINES_RPC_DIRECT_PEER__ENABLED: 'true',
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: signingKeyId,
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: Buffer.from(signingKeyPair.secretKey).toString('base64url'),
            },
            nowMs: () => Date.now(),
            readMachineIrohEndpointAuthority: async ({ machineId }) => (
                machineId === input.machineId
                    ? { endpointId: input.targetEndpointId, revision: 1 }
                    : null
            ),
        }),
    });
    const grantRequests: unknown[] = [];
    const grantAuthorizationHeaders: Array<string | undefined> = [];
    const server = createServer(async (request, response) => {
        try {
            if (request.method === 'GET' && request.url === '/v1/auth/ping') {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ ok: true }));
                return;
            }
            if (request.method !== 'POST' || request.url !== '/v1/machines/peer/mediation/route-grants') {
                response.writeHead(404).end();
                return;
            }
            const body = await readRequestBody(request);
            grantRequests.push(body);
            grantAuthorizationHeaders.push(request.headers.authorization);
            const invoked = await route.invoke({ userId: input.accountId, body });
            const routeResponse = invoked.response as Record<string, unknown>;
            const routeGrantParse = SignedDirectRouteGrantV2Schema.safeParse(routeResponse.grant);
            if (!routeGrantParse.success) {
                throw new Error(`Production grant route returned an invalid V2 grant: ${JSON.stringify(routeGrantParse.error.issues)}`);
            }
            const outbound = input.invalidateGrant && routeResponse.grant && typeof routeResponse.grant === 'object'
                ? {
                    ...routeResponse,
                    grant: {
                        ...(routeResponse.grant as Record<string, unknown>),
                        signature: {
                            ...((routeResponse.grant as Record<string, unknown>).signature as Record<string, unknown>),
                            valueBase64Url: Buffer.alloc(tweetnacl.sign.signatureLength, 4).toString('base64url'),
                        },
                    },
                }
                : routeResponse;
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(outbound));
        } catch (error) {
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
    });
    const port = await listen(server);
    return {
        serverUrl: `http://127.0.0.1:${port}`,
        signingKeyId,
        signingPublicKeyBase64Url: Buffer.from(signingKeyPair.publicKey).toString('base64url'),
        grantRequests,
        grantAuthorizationHeaders,
        close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}
