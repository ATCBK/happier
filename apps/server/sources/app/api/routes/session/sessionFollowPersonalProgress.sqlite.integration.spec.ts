import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol';
import type { SessionFollowPersonalProgressRequestV1, SessionFollowPersonalProgressResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { VerifiedEphemeralSessionRunnerPrincipalSchema } from '@happier-dev/protocol/ephemeralRunner/principal';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { auth } from '@/app/auth/auth';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLegacyLayout0SessionInTx } from '@/app/session/create/createLegacyLayout0Session';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { setAccountFollowRule, getAccountFollowRule } from '@/app/session/follow/accountFollowRuleService';
import { applyViewerReadCursorOperation } from '@/app/session/personal/readState';
import { writeSessionTranscriptMessageInTx } from '@/app/session/sessionTranscriptWrite';
import { createSessionMessage, updateSessionAgentState } from '@/app/session/sessionWriteService';
import { changeDeliveryMute } from '@/app/session/follow/sessionDeliveryMuteService';
import { removeAccountSessionFollow } from '@/app/session/follow/accountFollowService';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerSessionFollowRoutes } from './registerSessionFollowRoutes';

const url = '/v2/account/session-follow-rules/personal-progress';
const authentication = createPresentUserSessionAccessAuthentication();
type SessionContentEncryptionContext = Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
type SessionContentCryptoContext = Readonly<{ mode: 'plain'; ctx: null }>
    | Readonly<{ mode: 'e2ee'; ctx: SessionContentEncryptionContext }>;

describe('Account personal Follow accepted progress (SQLite + HTTP)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-personal-follow-progress-', initAuth: true,
            env: { HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_SERVER_IDENTITY_ID: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function setup(mode: 'plain' | 'e2ee') {
        const keys = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        const source = await inTx(tx => createLegacyLayout0SessionInTx(tx, { accountId: account.id, tag: randomUUID(),
            metadata: '{}', agentState: null, encryptionMode: mode, requestedStorageState: undefined, dataEncryptionKey: null }));
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: mode === 'plain' ? encodePlainMachineStoredContent({}) : 'opaque',
            dataEncryptionKey: mode === 'plain' ? decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) : null } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: source.id, data: 'opaque' } });
        await db.session.update({ where: { id: source.id }, data: { publisherGeneration: 1n, runtimeMachineTarget: {
            homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: account.id, sessionId: source.id,
            machineId: machine.id, installationId: machine.installationId!,
        } } });
        const app = createAuthenticatedTestApp();
        registerSessionFollowRoutes(app);
        await app.ready();
        const headers = { 'x-test-user-id': account.id };
        // Load the real CLI platform adapter at runtime without compiling the
        // CLI source graph into the server package's rootDir.
        const codec = await vi.importActual<{
            sealSessionStoredContent(input: SessionContentCryptoContext & Readonly<{
                payload: Extract<StrictSessionStoredMessageContentEnvelope, { t: 'plain' }>['v']; idempotencyKey?: string;
            }>): StrictSessionStoredMessageContentEnvelope;
            encryptSessionPayload(input: Readonly<{ ctx: SessionContentEncryptionContext; payload: unknown; idempotencyKey?: string }>): string;
        }>(
            '../../../../../../cli/src/session/transport/encryption/sessionStoredContentCodec');
        const context = mode === 'plain' ? { mode, ctx: null } as const
            : { mode, ctx: { encryptionKey: randomBytes(32), encryptionVariant: 'dataKey' as const } };
        const content = sealSessionFollowRuleContentV1({ ruleId: 'first', receiver: { kind: 'account' },
            mode, material: mode === 'e2ee' ? { type: 'dataKey', machineKey: keys.secretKey } : null,
            definition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } });
        const rule = async (ruleId: string) => {
            const sealed = mode === 'plain' ? content : sealSessionFollowRuleContentV1({ ruleId, receiver: { kind: 'account' }, mode,
                material: { type: 'dataKey', machineKey: keys.secretKey },
                definition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } });
            expect(await setAccountFollowRule({ accountId: account.id, ruleId, authentication,
                mutation: { receiver: { kind: 'account' }, content: sealed, expectedVersion: -1 } })).toMatchObject({ ok: true });
            return { ruleId, ruleVersion: 0 };
        };
        const original = async () => {
            const localId = randomUUID();
            const result = await inTx(tx => writeSessionTranscriptMessageInTx(tx, { sessionId: source.id, writeAuthority: 'hosted',
                sessionEncryptionMode: mode, storagePolicy: 'optional', localId, sidechainId: null, messageRole: 'event',
                content: codec.sealSessionStoredContent({ ...context, payload: { role: 'agent', content: {
                    type: 'acp', agentId: 'codex', data: { type: 'task_complete', id: localId },
                } } }), createdAt: new Date() }));
            expect(result).toMatchObject({ ok: true });
            const message = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: source.id, localId } } });
            return { localId, seq: message.seq };
        };
        const base = { sourceSessionId: source.id, expectedSourcePublisherGeneration: '1', machineId: machine.id,
            installationId: machine.installationId! };
        return { account, source, machine, app, headers, rule, original, base, context, codec };
    }

    it.each(['plain', 'e2ee'] as const)('settles %s original Inbox effects once across retries and changed matching routes, without enrollment', async mode => {
        const s = await setup(mode);
        try {
            const beforeCreation = await s.original();
            await db.sessionMessage.update({ where: { sessionId_localId: { sessionId: s.source.id, localId: beforeCreation.localId } },
                data: { createdAt: new Date(0) } });
            const first = await s.rule('first');
            const second = await s.rule('second');
            const third = await s.rule('third');
            const sourceMessage = await s.original();
            const send = (rules = [first]) => s.app.inject({ method: 'POST', url, headers: s.headers, payload: { ...s.base, rules, sourceMessage } });
            expect((await s.app.inject({ method: 'POST', url, headers: s.headers,
                payload: { ...s.base, rules: [first], sourceMessage: beforeCreation } })).json()).toEqual({ accepted: false, alreadyRepresented: false });
            const concurrent = await Promise.all([send(), send()]);
            expect(concurrent.map(response => response.statusCode)).toEqual([200, 200]);
            expect(concurrent.map(response => response.json().alreadyRepresented).sort()).toEqual([false, true]);
            expect(concurrent.every(response => response.json().accepted === true)).toBe(true);
            expect((await send()).json()).toEqual({ accepted: true, alreadyRepresented: true });
            expect((await send([first, second])).json()).toEqual({ accepted: true, alreadyRepresented: true });
            for (const witness of [first, second]) expect(await getAccountFollowRule({ accountId: s.account.id,
                authentication, ruleId: witness.ruleId })).toMatchObject({ ok: true, value: { rule: { version: 0,
                    sources: [{ sourceSessionId: s.source.id, delivered: { transcriptSeq: sourceMessage.seq } }] } } });
            expect(await db.accountSessionFollow.count({ where: { accountId: s.account.id } })).toBe(0);
            expect(await db.sessionFollowEdge.count({ where: { sourceSessionId: s.source.id } })).toBe(0);
            const read = await applyViewerReadCursorOperation({ accountId: s.account.id, sessionId: s.source.id,
                authentication, operation: { kind: 'mark-read' } });
            expect(read).toMatchObject({ ok: true });
            expect((await send([third])).json()).toEqual({ accepted: false, alreadyRepresented: false });
            const untouched = await getAccountFollowRule({ accountId: s.account.id, authentication, ruleId: third.ruleId });
            expect(untouched.ok && untouched.value.rule).not.toHaveProperty('sources');
        } finally { await s.app.close(); }
    });

    it.each(['plain', 'e2ee'] as const)('does not consume partial or replaced %s request maps and rejects stale source, rule, mute and Account witnesses', async mode => {
        const s = await setup(mode);
        try {
            const witness = await s.rule('first');
            const createdAt = Date.now();
            const requests = ['one', 'two'].map(requestId => ({ requestId, createdAt }));
            const update = (expectedVersion: number, ids: readonly string[]) => {
                const payload = { requests: Object.fromEntries(ids.map(id => [id,
                    { kind: 'user_action', tool: 'AskUserQuestion', arguments: {}, createdAt }])) };
                return updateSessionAgentState({ actorUserId: s.account.id, sessionId: s.source.id, expectedVersion,
                    agentStateCiphertext: s.context.mode === 'plain' ? JSON.stringify(payload)
                        : s.codec.encryptSessionPayload({ ctx: s.context.ctx, payload }), pendingUserActionRequestCount: ids.length });
            };
            expect(await update(0, ['one', 'two'])).toMatchObject({ ok: true });
            const full = { ...s.base, rules: [{ ...witness, requestIds: requests.map(request => request.requestId) }],
                sourceRequests: { agentStateVersion: 1, requests } };
            const send = (payload: unknown) => s.app.inject({ method: 'POST', url, headers: s.headers, payload });
            expect((await send({ ...full, sourceRequests: { ...full.sourceRequests, requests: [requests[0]] } })).json())
                .toEqual({ accepted: false, alreadyRepresented: false });
            expect((await send(full)).json()).toEqual({ accepted: true, alreadyRepresented: false });
            expect(await update(1, ['replacement'])).toMatchObject({ ok: true });
            expect((await send(full)).json()).toEqual({ accepted: false, alreadyRepresented: false });
            const sourceMessage = await s.original();
            const fresh = { ...s.base, rules: [witness], sourceMessage };
            expect((await send({ ...fresh, expectedSourcePublisherGeneration: '0' })).json()).toEqual({ accepted: false, alreadyRepresented: false });
            expect((await send({ ...fresh, installationId: randomUUID() })).json()).toEqual({ accepted: false, alreadyRepresented: false });
            expect((await send({ ...fresh, rules: [{ ...witness, ruleVersion: 1 }] })).json()).toEqual({ accepted: false, alreadyRepresented: false });
            expect((await send({ ...fresh, sourceMessage: { ...sourceMessage, seq: 999 } })).json()).toEqual({ accepted: false, alreadyRepresented: false });
            await db.session.update({ where: { id: s.source.id }, data: { archivedAt: new Date() } });
            expect((await send(fresh)).json()).toEqual({ accepted: false, alreadyRepresented: false });
            await db.session.update({ where: { id: s.source.id }, data: { archivedAt: null } });
            expect(await changeDeliveryMute({ accountId: s.account.id, receiver: { kind: 'account' }, authentication,
                operation: 'set', scope: { kind: 'source', source: { kind: 'session', sessionId: s.source.id } } })).toMatchObject({ ok: true });
            expect((await send(fresh)).json()).toEqual({ accepted: false, alreadyRepresented: false });
            const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
            expect((await s.app.inject({ method: 'POST', url, headers: { 'x-test-user-id': foreign.id }, payload: fresh })).json())
                .toEqual({ accepted: false, alreadyRepresented: false });
            // Unknown nested routing fields cannot become trusted source facts.
            expect((await send({ ...fresh, sourceMessage: { ...sourceMessage, event: { kind: 'finished' } } })).statusCode).toBe(400);
            await db.account.update({ where: { id: s.account.id }, data: { status: 'suspended' } });
            expect((await send(fresh)).statusCode).toBe(403);
        } finally { await s.app.close(); }
    });

    it('composes the actual CLI transport and denies finite Action tokens at the real authentication front door', async () => {
        const s = await setup('plain');
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const restricted = createAuthenticatedTestApp();
        restricted.addHook('onRequest', async (request: FastifyRequest) => {
            request.sessionRuntimePrincipal = VerifiedEphemeralSessionRunnerPrincipalSchema.parse({ kind: 'ephemeral_session_runner', authority: 'session_runtime',
                accountId: s.account.id, activationId: randomUUID(), sessionId: s.source.id, machineId: s.machine.id,
                installationId: s.machine.installationId!, installationPublicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey, 'base64url'), creatorTokenEpoch: 0 });
        });
        registerSessionFollowRoutes(restricted);
        await restricted.ready();
        registerSessionFollowRoutes(app);
        const serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
        try {
            const { submitAccountFollowPersonalProgress } = await vi.importActual<{
                submitAccountFollowPersonalProgress(input: Readonly<{ token: string; serverHttpBaseUrl: string;
                    signal: AbortSignal; occurrence: SessionFollowPersonalProgressRequestV1 }>): Promise<SessionFollowPersonalProgressResponseV1 | null>;
            }>(
                '../../../../../../cli/src/api/sessionFollowPersonalProgressTransport');
            const full = await auth.createApiToken({ accountId: s.account.id, tokenId: randomUUID(), label: 'Full Account' });
            const occurrence = { ...s.base, rules: [], sourceMessage: await s.original() };
            expect(await submitAccountFollowPersonalProgress({ token: full.token, serverHttpBaseUrl,
                signal: new AbortController().signal, occurrence })).toEqual({ accepted: true, alreadyRepresented: false });
            // Implicit owner tracking supplies the Inbox effect, not an invented
            // default-rule cursor or enrollment row.
            expect(await db.userKVStore.count({ where: { accountId: s.account.id } })).toBe(0);
            expect(await db.accountSessionFollow.count({ where: { accountId: s.account.id } })).toBe(0);
            const limited = await auth.createApiToken({ accountId: s.account.id, tokenId: randomUUID(), label: 'Limited Follow',
                grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['follow.get', 'follow.list', 'follow.set'] } } });
            const response = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${limited.token}` },
                payload: occurrence });
            expect([response.statusCode, response.json()]).toEqual([403, { error: 'present_user_required' }]);
            const deniedRuntime = await restricted.inject({ method: 'POST', url, headers: s.headers, payload: occurrence });
            expect([deniedRuntime.statusCode, deniedRuntime.json()]).toEqual([403, { error: 'credential_scope_denied' }]);
        } finally { await restricted.close(); await app.close(); await s.app.close(); }
    });

    it('settles mixed-age current request maps only for each rule\'s post-inception selected originals', async () => {
        const s = await setup('plain');
        try {
            const rule = await s.rule('first');
            const requests = [{ requestId: 'before-rule', createdAt: 0 }, { requestId: 'after-rule', createdAt: Date.now() }];
            expect(await updateSessionAgentState({ actorUserId: s.account.id, sessionId: s.source.id, expectedVersion: 0,
                agentStateCiphertext: JSON.stringify({ requests: Object.fromEntries(requests.map(request => [request.requestId,
                    { kind: 'user_action', tool: 'AskUserQuestion', arguments: {}, createdAt: request.createdAt }])) }),
                pendingUserActionRequestCount: requests.length })).toMatchObject({ ok: true });
            const payload = { ...s.base, sourceRequests: { agentStateVersion: 1, requests },
                rules: [{ ...rule, requestIds: ['after-rule'] }] };
            const response = await s.app.inject({ method: 'POST', url, headers: s.headers, payload });
            expect([response.statusCode, response.json()]).toEqual([200, { accepted: true, alreadyRepresented: false }]);
            expect((await s.app.inject({ method: 'POST', url, headers: s.headers,
                payload: { ...payload, rules: [{ ...rule, requestIds: ['before-rule'] }] } })).json())
                .toEqual({ accepted: false, alreadyRepresented: false });
        } finally { await s.app.close(); }
    });

    it('rechecks current explicit Unfollow before consuming an already-unread owner original', async () => {
        const s = await setup('plain');
        try {
            const rule = await s.rule('first');
            const sourceMessage = await s.original();
            expect(await removeAccountSessionFollow({ accountId: s.account.id, sessionId: s.source.id, authentication }))
                .toMatchObject({ ok: true });
            const response = await s.app.inject({ method: 'POST', url, headers: s.headers,
                payload: { ...s.base, rules: [rule], sourceMessage } });
            expect([response.statusCode, response.json()]).toEqual([200, { accepted: false, alreadyRepresented: false }]);
            const unchanged = await getAccountFollowRule({ accountId: s.account.id, ruleId: rule.ruleId, authentication });
            expect(unchanged.ok && unchanged.value.rule).not.toHaveProperty('sources');
        } finally { await s.app.close(); }
    });

    it('excludes a protected self-authored user original while preserving another Account actor and unknown Machine authorship', async () => {
        const s = await setup('plain');
        try {
            const rule = await s.rule('first');
            const collaborator = await db.account.create({ data: { encryptionMode: 'plain' } });
            await db.sessionShare.create({ data: { sessionId: s.source.id, sharedByUserId: s.account.id,
                sharedWithUserId: collaborator.id, accessLevel: 'edit' } });
            for (const actorUserId of [s.account.id, collaborator.id]) {
                const localId = randomUUID();
                expect(await createSessionMessage({ actorUserId, sessionId: s.source.id, localId,
                    inputAdmission: 'authenticatedAccount', authentication, messageRole: 'user',
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'A protected original' } } } }))
                    .toMatchObject({ ok: true });
                const original = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: s.source.id, localId } } });
                expect(original.inputAdmissionReceipt).toMatchObject({ issuer: 'authenticatedAccount', actorAccountId: actorUserId });
                const response = await s.app.inject({ method: 'POST', url, headers: s.headers, payload: { ...s.base,
                    rules: [rule], sourceMessage: { localId, seq: original.seq } } });
                expect([response.statusCode, response.json()]).toEqual([200, { accepted: actorUserId !== s.account.id, alreadyRepresented: false }]);
            }
            const localId = randomUUID();
            expect(await inTx(tx => writeSessionTranscriptMessageInTx(tx, { sessionId: s.source.id, writeAuthority: 'hosted',
                sessionEncryptionMode: 'plain', storagePolicy: 'optional', localId, sidechainId: null, messageRole: 'user',
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Unknown Account authorship' } } } })))
                .toMatchObject({ ok: true });
            const original = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: s.source.id, localId } } });
            expect((await s.app.inject({ method: 'POST', url, headers: s.headers,
                payload: { ...s.base, rules: [rule], sourceMessage: { localId, seq: original.seq } } })).json())
                .toEqual({ accepted: true, alreadyRepresented: false });
        } finally { await s.app.close(); }
    });
});
