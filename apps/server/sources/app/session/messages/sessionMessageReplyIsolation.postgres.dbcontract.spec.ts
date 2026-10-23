import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageReplyReturnLocalIdV1, SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1,
    SESSION_MESSAGE_REPLY_RELEASE_SOURCE_TURN_EVENT_V1, SessionMessageReplyProgressV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { auth } from '@/app/auth/auth';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { registerSessionArchiveRoutes } from '@/app/api/routes/session/registerSessionArchiveRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { createSessionInputReplyProgressInTx } from './sessionMessageReply';

const authentication = createPresentUserSessionAccessAuthentication();
const machineOptions = { operationSocketBatchLimits: { ok: true as const, limits: { maxItems: 200, maxSerializedBytes: 524288 } } };

function interceptQuery(matches: (model: string, method: string, args: readonly unknown[]) => boolean,
    before: () => Promise<void>) {
    const original = db.$transaction;
    db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
        const operation = args[0];
        if (typeof operation !== 'function') return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => operation(new Proxy(tx, {
            get(inner, property, innerReceiver) {
                const delegate: unknown = Reflect.get(inner, property, innerReceiver);
                if (property === '$queryRawUnsafe' && typeof delegate === 'function') return (...values: unknown[]) => {
                    const query: unknown = Reflect.apply(delegate, inner, values);
                    return matches(property, '', values) ? observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), before) : query;
                };
                if (!delegate || typeof delegate !== 'object' || typeof property !== 'string') return delegate;
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const member: unknown = Reflect.get(model, method, modelReceiver);
                    if (typeof member !== 'function' || typeof method !== 'string') return member;
                    return (...values: unknown[]) => {
                        const query: unknown = Reflect.apply(member, model, values);
                        return matches(property, method, values) ? observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), before) : query;
                    };
                } });
            },
        })), ...args.slice(1)]);
    } });
    return () => { db.$transaction = original; };
}

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Session reply isolation (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HANDY_MASTER_SECRET', 'serialaudit-reply-disposable-secret');
        vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres(); await db.$connect(); await auth.init();
    });
    afterAll(async () => { await shutdownDbClient(); vi.unstubAllEnvs(); });

    async function fixture(kind: 'account' | 'machine' | 'publisher' | 'source-release', human = false) {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'reply-host' }), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const [source, target] = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } })));
        for (const session of [source, target]) await db.accessKey.create({ data: { accountId: account.id,
            machineId: machine.id, sessionId: session.id, data: 'opaque-fixture-key' } });
        const sourceTurnId = randomUUID(); const sourceInputId = randomUUID(); const targetTurnId = randomUUID();
        if (kind === 'source-release') await db.sessionMessage.create({ data: { sessionId: source.id, seq: 1, localId: sourceInputId,
            targetExecutionRunId: randomUUID(), acceptedTurnId: sourceTurnId, messageRole: 'user', content: { t: 'plain', v: {} } } });
        else await db.sessionTurn.create({ data: { sessionId: source.id, turnId: sourceTurnId, status: 'completed',
            startedAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
        const reply = human ? { mode: 'return' as const, humanOrigin: { sessionId: source.id } }
            : kind === 'account' || kind === 'publisher' ? { mode: 'wait' as const }
                : { mode: 'return' as const, sourceSession: { sourceSessionId: source.id, sourceTurnId,
                    ...(kind === 'source-release' ? { sourceInputId } : {}), via: 'action' as const } };
        const admitted = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: account.id, authentication,
            requestSessionId: target.id, reply }));
        if (!admitted) throw new Error('Canonical reply fixture admission failed');
        const progress = SessionMessageReplyProgressV1Schema.parse({ ...admitted, acceptedTurnId: targetTurnId,
            ...(kind === 'machine' ? { outcome: { kind: 'pass' } } : {}) });
        const localId = randomUUID();
        const receipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: kind === 'account' ? 'authenticatedAccount' : 'authenticatedMachine',
            ...(kind === 'account' ? { actorAccountId: account.id, sessionRelationship: 'owner' } : {}),
            admittedTarget: { homeId: 'serialaudit-reply-home', accountId: account.id, sessionId: target.id,
                machineId: machine.id, installationId: machine.installationId } });
        const original = await db.sessionMessage.create({ data: { sessionId: target.id, localId, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: {} }, inputAdmissionReceipt: receipt, replyTargetMachineId: machine.id,
            replySourceSessionId: progress.sourceSession?.sourceSessionId ?? progress.humanOrigin?.sessionId,
            replySourceTurnId: progress.sourceSession?.sourceTurnId, replyDisposition: progress.disposition, replyProgress: progress } });
        const returnedInputLocalId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: target.id, localId, acceptedTurnId: targetTurnId });
        if (kind === 'machine') await db.sessionPendingMessage.create({ data: { sessionId: source.id, localId: returnedInputLocalId,
            position: 0, content: { t: 'plain', v: {} }, requestedAction: { v: 1, kind: 'enqueue' },
            inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedMachine' }) } });
        const app = createAuthenticatedTestApp(); registerSessionMessageRoutes(app); registerSessionArchiveRoutes(app); machinesRoutes(app); await app.ready();
        const headers = { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        const publisher = async (session: typeof source) => {
            const socket = createAuthenticatedFakeSocket({ id: randomUUID() });
            sessionUpdateHandler(account.id, socket as never, { connectionType: 'session-scoped', socket,
                userId: account.id, sessionId: session.id } as never,
            { presence: createSessionPublisherPresence(), binding: { accountId: account.id, machineId: machine.id, sessionId: session.id } });
            await getSocketHandler(socket, 'session-runtime-activity-snapshot')({ sessionId: session.id,
                mutationId: randomUUID(), snapshot: { state: 'idle', activeCount: 0 } }, () => {});
            return async (event: string, request: unknown) => {
                let result: unknown;
                await getSocketHandler(socket, event)(request, (value: unknown) => { result = value; });
                return result;
            };
        };
        const targetPublisher = kind === 'publisher' || kind === 'source-release' ? await publisher(target) : null;
        const sourcePublisher = kind === 'source-release' ? await publisher(source) : null;
        const machineSocket = Object.assign(createAuthenticatedFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            verifiedMachineInstallationId: machine.installationId } }), { handshake: { auth: { token: await auth.createToken(account.id,
            undefined, { kind: 'account', authority: 'present_user' }) } } });
        machineUpdateHandler(account.id, machineSocket as never, machineOptions);
        const fulfill = () => targetPublisher!(SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, { v: 1, sessionId: target.id,
            requestSessionId: target.id, requestLocalId: localId,
            operation: { kind: 'fulfill', turnId: targetTurnId, outcome: { kind: 'pass' } } });
        const release = () => sourcePublisher!(SESSION_MESSAGE_REPLY_RELEASE_SOURCE_TURN_EVENT_V1, { v: 1, sessionId: source.id,
            sourceTurnId, sourceInputId });
        return { account, machine, source, target, original, progress, app, headers, fulfill, release,
            mutate: async () => {
                if (kind === 'account') return (await app.inject({ method: 'POST',
                    url: `/v2/sessions/${target.id}/messages/by-local-id/${localId}/reply`, headers, payload: { kind: 'release' } })).json();
                if (kind === 'publisher') return fulfill();
                if (kind === 'source-release') return release();
                let result: unknown;
                await getSocketHandler(machineSocket, SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1)({ v: 1, machineId: machine.id,
                    requestSessionId: target.id, requestLocalId: localId, operation: { kind: 'returned', returnedInputLocalId } },
                (value: unknown) => { result = value; });
                return result;
            }, close: async () => {
                await app.close();
                await db.sessionPendingMessage.deleteMany({ where: { sessionId: { in: [source.id, target.id] } } });
                await db.sessionMessage.deleteMany({ where: { sessionId: { in: [source.id, target.id] } } });
                await db.accessKey.deleteMany({ where: { sessionId: { in: [source.id, target.id] } } });
                await db.session.deleteMany({ where: { id: { in: [source.id, target.id] } } });
                await db.machine.delete({ where: { id: machine.id } }); await db.account.delete({ where: { id: account.id } });
            } };
    }

    it.each(['account', 'machine', 'publisher', 'source-release'] as const)('%s mutation is private progress without Account cursor publication', async kind => {
        const current = await fixture(kind);
        try {
            const initial = (await db.account.findUniqueOrThrow({ where: { id: current.account.id } })).seq;
            const changes = await db.accountChange.count({ where: { accountId: current.account.id } });
            expect(await current.mutate()).toMatchObject({ ok: true });
            const progress = (await db.sessionMessage.findUniqueOrThrow({ where: { id: current.original.id } })).replyProgress;
            expect(progress).toMatchObject(kind === 'publisher' ? { outcome: { kind: 'pass' } }
                : { disposition: kind === 'account' ? 'released' : kind === 'machine' ? 'returned' : 'return_pending' });
            expect(progress).not.toEqual(current.progress);
            expect(await db.account.findUniqueOrThrow({ where: { id: current.account.id } })).toMatchObject({ seq: initial });
            expect(await db.accountChange.count({ where: { accountId: current.account.id } })).toBe(changes);
        } finally { await current.close(); }
    });

    it.each(['machine', 'publisher', 'source-release'] as const)('%s refuses its execution Machine revoked before Session admission', async kind => {
        const current = await fixture(kind);
        let revoked = false;
        const restore = interceptQuery((model, _method, args) => model === '$queryRawUnsafe'
            && String(args[0]).includes('FROM "Session"') && String(args[0]).includes('FOR NO KEY UPDATE'), async () => {
            if (revoked) return;
            revoked = true;
            const response = await current.app.inject({ method: 'POST', url: `/v1/machines/${current.machine.id}/revoke`, headers: current.headers });
            expect(response.statusCode, response.body).toBe(200);
        });
        try {
            expect(await current.mutate()).toMatchObject({ ok: false, error: 'forbidden' });
            expect(revoked).toBe(true);
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: current.original.id } })).replyProgress).toEqual(current.progress);
        } finally { restore(); await current.close(); }
    });

    it.each(['account', 'machine'] as const)('%s refuses a return destination archived before request admission', async kind => {
        const current = await fixture(kind, kind === 'account');
        let archived = false;
        const restore = interceptQuery((model, _method, args) => model === '$queryRawUnsafe'
            && String(args[0]).includes('FROM "Session"') && String(args[0]).includes('FOR NO KEY UPDATE'), async () => {
            if (archived) return;
            archived = true;
            const response = await current.app.inject({ method: 'POST', url: `/v2/sessions/${current.source.id}/archive`, headers: current.headers });
            expect(response.statusCode, response.body).toBe(200);
        });
        try {
            expect(await current.mutate()).toMatchObject({ ok: false, error: 'unavailable' });
            expect(archived).toBe(true);
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: current.original.id } })).replyProgress).toEqual(current.progress);
        } finally { restore(); await current.close(); }
    });

    it('source release and target fulfillment preserve both progress facts under a real original-row race', async () => {
        const current = await fixture('source-release');
        let release!: () => void;
        const both = new Promise<void>(resolve => { release = resolve; });
        let writers = 0;
        const restore = interceptQuery((model, method) => model === 'sessionMessage' && method === 'updateMany', async () => {
            if (++writers === 2) release();
            await both;
        });
        try {
            const initial = (await db.account.findUniqueOrThrow({ where: { id: current.account.id } })).seq;
            const results = await Promise.all([current.fulfill(), current.release()]);
            expect(writers).toBeGreaterThanOrEqual(2);
            for (const result of results) expect(result).toMatchObject({ ok: true });
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: current.original.id } })).replyProgress)
                .toMatchObject({ outcome: { kind: 'pass' }, disposition: 'return_pending' });
            expect(await db.account.findUniqueOrThrow({ where: { id: current.account.id } })).toMatchObject({ seq: initial });
        } finally { release(); restore(); await current.close(); }
    });
});
