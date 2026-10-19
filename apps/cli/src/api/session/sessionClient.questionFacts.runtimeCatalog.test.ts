import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { writeSessionRoleConfigurationV1ToMetadata } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { ApiSessionClient, type ApiSessionClientOptions } from './sessionClient';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createMockSession, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { encodeBase64, encrypt } from '@/api/encryption';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { loadSessionClientDurableMutationOutbox } from './client/transport/mutations/sessionClientDurableMutationPersistence';

// Only the authenticated HTTP and Socket.IO transport boundaries are substituted.
vi.mock('axios');
vi.mock('socket.io-client', () => ({ io: () => createApiSessionSocketStub() }));

describe('ApiSessionClient authenticated question Session facts', () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'question-owner' })).toString('base64url')}.sig`;
    const home = 'https://question-owner-home.test';
    const secret = new Uint8Array(32).fill(7);
    const clients = new Set<ApiSessionClient>();

    beforeEach(() => {
        vi.mocked(axios.get).mockReset();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    });
    afterEach(async () => {
        await Promise.allSettled([...clients].map(client => client.close()));
        clients.clear();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    function createHome(input: Readonly<{
        mode?: 'plain' | 'e2ee';
        layout?: 0 | 1;
        metadata?: Record<string, unknown>;
        authority?: ApiSessionClientOptions['metadataAuthority'];
    }> = {}) {
        const mode = input.mode ?? 'plain';
        const layout = input.layout ?? 1;
        const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null : { type: 'legacy', secret } };
        const metadata = { ...createTestMetadata(), ...input.metadata };
        const fields = layout === 1 ? buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: mode,
            metadata, agentState: null, ...(mode === 'plain' ? { storedContentMode: 'plain' }
                : { storedContentMode: 'e2ee', encryptionKey: secret, encryptionVariant: 'legacy' }) }) : null;
        let raw = createSessionNotificationContextFixture('worker');
        raw = { ...raw, encryptionMode: mode, active: true, manager: { sessionId: 'manager' },
            metadataLayoutVersion: layout, metadata: fields ? fields.sharedMetadata.ciphertext
                : mode === 'plain' ? JSON.stringify(metadata) : encodeBase64(encrypt(secret, 'legacy', metadata)),
            ...(fields ? { ownerMetadata: fields.ownerMetadata } : {}), agentState: null };
        V2SessionByIdResponseSchema.parse({ session: raw });
        const requests: Array<{ url: string; authorization: unknown }> = [];
        vi.mocked(axios.get).mockImplementation(async (url, config) => {
            requests.push({ url: String(url), authorization: config?.headers?.Authorization });
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode }) };
            if (path === '/v2/sessions/worker') return { status: 200, data: { session: raw } };
            return { status: 404, data: {} };
        });
        const socket = createApiSessionSocketStub();
        const client = new ApiSessionClient(token, createMockSession({ id: 'asking-session', encryptionMode: mode,
            // The bound Session's loaded key cannot open the other Session's metadata.
            encryptionKey: new Uint8Array(32).fill(19) }), { metadataAuthority: input.authority ?? { kind: 'owner', credentials },
            durableMutationDeliveryInitiallyActive: false,
            transport: { serverId: 'question-home', serverUrl: home,
                createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) } });
        clients.add(client);
        return { client, requests, setRaw(next: Partial<typeof raw>) { raw = { ...raw, ...next }; } };
    }

    it.each([{ mode: 'plain', layout: 0 }, { mode: 'plain', layout: 1 },
        { mode: 'e2ee', layout: 0 }, { mode: 'e2ee', layout: 1 }] as const)(
        'opens owned $mode layout-$layout facts through the bound Home', async input => {
            const { client, requests } = createHome(input);
            await expect(runWithServerHttpBaseUrl('https://unrelated-home.test', () => client.readQuestionSessionSnapshot('worker')))
                .resolves.toEqual({ sessionId: 'worker', accountId: 'question-owner', managerSessionId: 'manager',
                    available: true, answersWorkerQuestions: true });
            expect(requests.filter(request => request.url.includes('/v2/sessions/worker'))).toHaveLength(1);
            expect(requests.every(request => request.url.startsWith(`${home}/`) && request.authorization === `Bearer ${token}`)).toBe(true);
        });

    it.each(['shared_editor', 'wrong_credentials'] as const)('refuses %s without an Account read', async authority => {
        const { client, requests } = createHome({ authority: authority === 'shared_editor' ? { kind: 'shared_editor' }
            : { kind: 'owner', credentials: { token: 'unrelated-token', encryption: null } } });
        await expect(client.readQuestionSessionSnapshot('worker')).resolves.toBeNull();
        expect(requests).toEqual([]);
    });

    it('refuses unreadable owner metadata with mismatched Account encryption material', async () => {
        const { client } = createHome({ mode: 'e2ee', authority: { kind: 'owner', credentials: {
            token, encryption: { type: 'legacy', secret: new Uint8Array(32).fill(23) },
        } } });
        await expect(client.readQuestionSessionSnapshot('worker')).resolves.toBeNull();
    });

    it.each(['editor', 'missing_access', 'different_session', 'missing_metadata', 'wrong_owner_envelope', 'offline_http'] as const)(
        'fails closed for %s', async problem => {
            const { client, setRaw } = createHome();
            if (problem === 'editor') setRaw({ effectiveAccess: { v: 1, level: 'edit', sources: [{ kind: 'direct', shareId: 'shared-worker' }],
                capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: 'edit', canApprovePermissions: true }] }) } });
            if (problem === 'missing_access') setRaw({ effectiveAccess: undefined });
            if (problem === 'different_session') setRaw({ id: 'other-worker' });
            if (problem === 'missing_metadata') setRaw({ metadata: '{}' });
            if (problem === 'wrong_owner_envelope') setRaw({ ownerMetadata: { t: 'encrypted', c: 'invalid' } as never });
            if (problem === 'offline_http') vi.mocked(axios.get).mockRejectedValue(new Error('Home unavailable'));
            await expect(client.readQuestionSessionSnapshot('worker')).resolves.toBeNull();
        });

    it.each(['stopped', 'malformed_stop', 'archived', 'offline', 'toggle_off', 'malformed_roles'] as const)(
        'projects existing %s facts without choosing a handler', async state => {
            const metadata = state === 'stopped' ? writeSessionExplicitStopV1ToMetadata(createTestMetadata(),
                { v: 1, cause: 'explicit_stop', requestId: 'stop-question-manager', requestedAtMs: 1 })
                : state === 'malformed_stop' ? { sessionExplicitStopV1: {} }
                : state === 'toggle_off' ? writeSessionRoleConfigurationV1ToMetadata(createTestMetadata(),
                    { answersWorkerQuestions: false, overrides: {}, sessionRoles: {}, notes: '' })
                : state === 'malformed_roles' ? { work: { sessionRolesV1: { answersWorkerQuestions: true } } } : {};
            const { client, setRaw } = createHome({ metadata,
                layout: state === 'malformed_stop' || state === 'malformed_roles' ? 0 : 1 });
            if (state === 'archived') setRaw({ archivedAt: 1 });
            if (state === 'offline') setRaw({ active: false });
            await expect(client.readQuestionSessionSnapshot('worker')).resolves.toMatchObject({
                managerSessionId: 'manager', available: !['stopped', 'malformed_stop', 'archived', 'offline'].includes(state),
                answersWorkerQuestions: !['toggle_off', 'malformed_roles'].includes(state),
            });
        });

    it('yields only the question source turn through the existing runtime control', async () => {
        const { client } = createHome();
        const cancelledTurns: string[] = [];
        let currentTurnId = 'question-turn';
        // Cancellation is the provider boundary. The host turn projection stays real;
        // its id deliberately differs from the native active input id.
        client.setSessionRuntimeControls({ readActiveTurnInputId: () => 'source-input',
            cancelActiveTurn: async () => {
                // Native cancellation must observe the host's exact wait intent before
                // its synchronous terminal event can be projected as cancellation.
                expect(client.readQuestionWaitTurnId?.()).toBe('question-turn');
                cancelledTurns.push(currentTurnId);
            } });
        client.observeHostTurnFacts({ turnId: currentTurnId, facts: { initiator: 'user', workDepth: 0 } });
        await expect(client.yieldQuestionTurn('question-turn')).resolves.toBe(true);
        expect(cancelledTurns).toEqual(['question-turn']);
        client.observeHostTurnFacts({ turnId: currentTurnId, facts: null });
        expect(client.readQuestionWaitTurnId?.()).toBe('question-turn');

        currentTurnId = 'later-turn';
        client.observeHostTurnFacts({ turnId: currentTurnId, facts: { initiator: 'user', workDepth: 0 } });
        expect(client.readQuestionWaitTurnId?.()).toBeNull();
        await expect(client.yieldQuestionTurn('question-turn')).resolves.toBe(true);
        expect(cancelledTurns).toEqual(['question-turn']);
        client.observeHostTurnFacts({ turnId: currentTurnId, facts: null });
        await expect(client.yieldQuestionTurn('question-turn')).resolves.toBe(true);
        expect(cancelledTurns).toEqual(['question-turn']);
    });

    it('reports unavailable yielding when the source turn has no cancellation control', async () => {
        const { client } = createHome();
        client.observeHostTurnFacts({ turnId: 'question-turn', facts: { initiator: 'user', workDepth: 0 } });
        client.setSessionRuntimeControls({});
        await expect(client.yieldQuestionTurn('question-turn')).resolves.toBe(false);
        expect(client.readQuestionWaitTurnId?.()).toBeNull();
    });

    it('retires an unaccepted wait intent when native cancellation fails', async () => {
        const { client } = createHome();
        client.observeHostTurnFacts({ turnId: 'question-turn', facts: { initiator: 'user', workDepth: 0 } });
        client.setSessionRuntimeControls({ cancelActiveTurn: async () => { throw new Error('native cancellation unavailable'); } });
        await expect(client.yieldQuestionTurn('question-turn')).rejects.toThrow('native cancellation unavailable');
        expect(client.readQuestionWaitTurnId?.()).toBeNull();
    });

    it('durably cancels the exact yielded turn on explicit question withdrawal', async () => {
        const { client } = createHome();
        client.observeHostTurnFacts({ turnId: 'explicit-stop-question-turn', facts: { initiator: 'user', workDepth: 0 } });
        client.setSessionRuntimeControls({ cancelActiveTurn: async () => {
            client.observeHostTurnFacts({ turnId: 'explicit-stop-question-turn', facts: null });
        } });
        await client.yieldQuestionTurn('explicit-stop-question-turn');
        await client.clearQuestionWaitTurn(['explicit-stop-question-turn']);
        await client.clearQuestionWaitTurn();
        // A rejoined host has no local intent; its durable request supplies
        // the original turn and uses the same journal mutation owner.
        await client.clearQuestionWaitTurn(['rejoined-question-turn', 'rejoined-question-turn']);
        const journal = await loadSessionClientDurableMutationOutbox(client.sessionId);
        expect(journal.filter(entry => entry.kind === 'session_turn_mutation'
            && entry.payload.action === 'cancel' && entry.payload.turnId === 'explicit-stop-question-turn'))
            .toEqual([expect.objectContaining({ payload: expect.objectContaining({
                action: 'cancel', turnId: 'explicit-stop-question-turn', reason: 'explicit_stop',
            }) })]);
        expect(journal.filter(entry => entry.kind === 'session_turn_mutation'
            && entry.payload.action === 'cancel' && entry.payload.turnId === 'rejoined-question-turn'))
            .toEqual([expect.objectContaining({ payload: expect.objectContaining({
                action: 'cancel', turnId: 'rejoined-question-turn', reason: 'explicit_stop',
            }) })]);
        expect(client.readQuestionWaitTurnId()).toBeNull();
    });
});
