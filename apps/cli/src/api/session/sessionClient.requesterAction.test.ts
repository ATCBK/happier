import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createSessionScopedSocketConnection } from './sockets';
import { ApiSessionClient } from './sessionClient';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import nacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1, FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import * as installationStore from '@/daemon/identity/store';

// Socket.IO and HTTP are the genuine system boundaries; installed admission and Session input stay real.
vi.mock('socket.io-client', () => ({ io: vi.fn(() => createApiSessionSocketStub()) }));
vi.mock('axios');

describe('installed Session requester Action ingress', () => {
    let client: ApiSessionClient | undefined;
    afterEach(async () => {
        await client?.close();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('admits the original private transition caller at the real Session input receiver without elevating its limits', async () => {
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation', createdAt: 1, publicKey: Buffer.from(installation.publicKey).toString('base64url'),
            privateKey: Buffer.from(installation.secretKey).toString('base64url') });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
            features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_transition' } },
        })), { status: 200 })));
        vi.mocked(axios.get).mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'requester' } };
            if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            } };
            return { status: 404, data: {} };
        });
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } });
        client = new ApiSessionClient('owner-token', createMockSession({ id: 'transition-session', encryptionMode: 'plain' }), {
            metadataAuthority: { kind: 'owner', credentials: { token: 'owner-token', encryption: null } },
            localMachineId: 'machine',
            transport: { serverId: 'profile', serverUrl: 'https://transition-home.test',
                createSessionSocketTransport: ({ sessionId }) => createSessionScopedSocketConnection({
                    token: 'owner-token', sessionId, serverUrl: 'https://transition-home.test' }),
            },
        });
        // Provider input is the native/process boundary; host admission and the installed Account ingress remain real.
        const handleUserMessage = vi.fn(async () => ({ handled: true as const, result: { ok: true } }));
        client.setSessionRuntimeControls({ handleUserMessage, readEffectiveInputConfiguration: () => ({ modelSelection: null, permissionMode: 'yolo' }) });
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
            accountId: 'requester', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
            authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'srv_transition', machineId: 'machine',
            installationId: 'installation', actionId: 'session.agent.transition', requestId: 'original',
            requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
        } });
        const request = { text: 'protected input', localId: 'private-default', meta: {} };
        const seal = (payload = request) => sealExternalActionRequesterAccountContextV1({ authorization,
            credentials: { token: 'requester-token', encryption: null },
            invocation: { caller: { kind: 'plugin', pluginId: 'happier.agent.codex', contributionLocalId: 'automation' },
                surface: 'plugin', authority: 'account_automation', callerInputConstraints: { models: null, permissionModes: ['default'] } },
            purpose: { kind: 'machine_rpc', method: SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, params: payload },
            installationPublicKey: installation.publicKey, randomBytes: nacl.randomBytes });
        const packet = { method: `transition-session:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`, requestId: 'relay',
            params: request, callerAuthority: 'present_user' as const, callerInputAuthorization: seal() };
        expect(await client.rpcHandlerManager.handleRequest(packet)).toMatchObject({ ok: false, errorCode: 'permission_mode_not_granted' });
        expect(handleUserMessage).not.toHaveBeenCalled();
        client.setSessionRuntimeControls({ handleUserMessage, readEffectiveInputConfiguration: () => ({ modelSelection: null, permissionMode: 'default' }) });
        expect(await client.rpcHandlerManager.handleRequest({ ...packet, params: { ...request, localId: 'private-allowed' },
            callerInputAuthorization: seal({ ...request, localId: 'private-allowed' }) })).toMatchObject({ ok: true });
        expect(handleUserMessage).toHaveBeenCalledOnce();
        expect(await client.rpcHandlerManager.handleRequest({ ...packet, params: { ...request, text: 'swapped' } }))
            .toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
        expect(await client.rpcHandlerManager.handleRequest({ ...packet, callerInputAuthorization: authorization }))
            .toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
        expect(handleUserMessage).toHaveBeenCalledOnce();
    });

    it('admits a current installed API transition without Account custody and enforces its captured grant', async () => {
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation', createdAt: 1, publicKey: Buffer.from(installation.publicKey).toString('base64url'),
            privateKey: Buffer.from(installation.secretKey).toString('base64url') });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
            features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_transition' } },
        })), { status: 200 })));
        // A PAT proof is not an Account credential lease. Any Account lookup would borrow the wrong authority.
        vi.mocked(axios.get).mockImplementation(async () => { throw new Error('Account custody must not be requested'); });
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } });
        client = new ApiSessionClient('owner-token', createMockSession({ id: 'transition-session', encryptionMode: 'plain' }), {
            metadataAuthority: { kind: 'owner', credentials: { token: 'owner-token', encryption: null } },
            localMachineId: 'machine',
            transport: { serverId: 'profile', serverUrl: 'https://transition-home.test',
                createSessionSocketTransport: ({ sessionId }) => createSessionScopedSocketConnection({
                    token: 'owner-token', sessionId, serverUrl: 'https://transition-home.test' }),
            },
        });
        const handleUserMessage = vi.fn(async () => ({ handled: true as const, result: { ok: true } }));
        client.setSessionRuntimeControls({ handleUserMessage, readEffectiveInputConfiguration: () => ({ modelSelection: null, permissionMode: 'yolo' }) });
        // This is the authenticated Home relay boundary; the real installed admission revalidates its exact root at Home.
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-api-root', binding: {
            accountId: 'requester', custodianAccountId: 'owner', principalId: 'requester', credentialId: 'api-credential',
            accountEncryptionMode: 'plain', serverIdentityId: 'srv_transition', machineId: 'machine',
            installationId: 'installation', actionId: 'session.agent.transition', requestId: 'original',
            grant: { ...API_TOKEN_FULL_GRANT_V1, permissionModes: ['read-only'] },
            requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
        } });
        const request = { text: 'API protected input', localId: 'api-restricted', meta: {} };
        const packet = { method: `transition-session:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`, requestId: 'relay-api',
            params: request, callerAuthority: 'account_automation' as const, callerInputAuthorization: authorization };
        expect(await client.rpcHandlerManager.handleRequest(packet)).toMatchObject({ ok: false, errorCode: 'permission_mode_not_granted' });
        expect(handleUserMessage).not.toHaveBeenCalled();
        client.setSessionRuntimeControls({ handleUserMessage, readEffectiveInputConfiguration: () => ({ modelSelection: null, permissionMode: 'read-only' }) });
        expect(await client.rpcHandlerManager.handleRequest({ ...packet, params: { ...request, localId: 'api-allowed' } }))
            .toMatchObject({ ok: true });
        expect(handleUserMessage).toHaveBeenCalledOnce();
        const unconfiguredReceiver = new RpcHandlerManager({ scopePrefix: 'transition-session', localMachineId: 'machine', encryptionMode: 'plain' });
        unconfiguredReceiver.registerHandler(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, handleUserMessage);
        expect(await unconfiguredReceiver.handleRequest(packet)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
        vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue({ version: 1,
            installationId: 'replacement-installation', createdAt: 1, publicKey: Buffer.from(installation.publicKey).toString('base64url'),
            privateKey: Buffer.from(installation.secretKey).toString('base64url') });
        expect(await client.rpcHandlerManager.handleRequest({ ...packet, params: { ...request, localId: 'api-stale-installation' } }))
            .toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
        vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue({ version: 1,
            installationId: 'installation', createdAt: 1, publicKey: Buffer.from(installation.publicKey).toString('base64url'),
            privateKey: Buffer.from(installation.secretKey).toString('base64url') });
        vi.mocked(axios.post).mockResolvedValue({ status: 403, data: { ok: false } });
        expect(await client.rpcHandlerManager.handleRequest({ ...packet, params: { ...request, localId: 'api-revoked' } }))
            .toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
        expect(handleUserMessage).toHaveBeenCalledOnce();
    });

});
