import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { DISCUSSION_HTTP_PATHS_V1, DiscussionDetailsResponseV1Schema, type DiscussionCreateRequestV1 } from '@happier-dev/protocol/discussions/api';

import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { createDiscussion } from './mutations';

const authentication = createPresentUserSessionAccessAuthentication();

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Discussion archive admission (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { vi.unstubAllEnvs(); await shutdownDbClient(); });

    async function fixture(archived = false) {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const request = {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Archive contention' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'First' }] } },
                mentionedAccountIds: [] },
        } satisfies DiscussionCreateRequestV1;
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        if (archived) await db.discussion.update({ where: { id: discussionId }, data: { archivedAt: new Date() } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableErrorHandlers(app);
        // Credential verification is the boundary; all routing, authority,
        // projection, native locks and terminal publication remain real.
        app.decorate('authenticate', async (incoming: FastifyRequest) => {
            incoming.userId = owner.id; incoming.authAuthority = 'present_user'; incoming.authTokenKind = 'account';
        });
        registerDiscussionRoutes(app);
        await app.ready();
        const initialCursor = (await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).seq;
        return { owner, discussionId, initialCursor, app, close: async () => {
            await app.close();
            await db.account.delete({ where: { id: owner.id } });
        } };
    }

    it.each(['archive', 'restore'] as const)('commits %s across a concurrent Account cursor writer without conflict retries', async intent => {
        const current = await fixture(intent === 'restore');
        const maxRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        const requestChange = () => current.app.inject({ method: 'POST',
            url: DISCUSSION_HTTP_PATHS_V1[intent].replace(':discussionId', current.discussionId) });
        let response: ReturnType<typeof requestChange> | undefined;
        try {
            await db.$transaction(async writer => {
                const [{ pid }] = await writer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await writer.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${current.owner.id} FOR NO KEY UPDATE`;
                let finished = false;
                const requested = requestChange();
                response = requested;
                void requested.then(() => { finished = true; }, () => { finished = true; });
                let waiting = false;
                while (!finished && !waiting) {
                    const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                            AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
                    `;
                    waiting = row.waiting;
                }
                expect(waiting).toBe(true);
                await writer.account.update({ where: { id: current.owner.id }, data: { seq: { increment: 1 } } });
            });
            if (!response) throw new Error('Archive route did not start');
            const result = await response;
            expect(result.statusCode, result.body).toBe(200);
            const projected = DiscussionDetailsResponseV1Schema.parse(result.json());
            expect(projected.discussion.id).toBe(current.discussionId);
            expect(projected.discussion.archivedAt === null).toBe(intent === 'restore');
            const persisted = await db.discussion.findUniqueOrThrow({ where: { id: current.discussionId } });
            expect(persisted.archivedAt?.getTime() ?? null).toBe(projected.discussion.archivedAt);
            expect(await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                accountId: current.owner.id, kind: 'discussion', entityId: current.discussionId,
            } }, select: { cursor: true } })).toEqual({ cursor: current.initialCursor + 2 });
            const repeated = await current.app.inject({ method: 'POST', url: DISCUSSION_HTTP_PATHS_V1[intent].replace(':discussionId', current.discussionId) });
            expect(repeated.statusCode, repeated.body).toBe(200);
            expect(DiscussionDetailsResponseV1Schema.parse(repeated.json()).discussion.archivedAt).toBe(projected.discussion.archivedAt);
        } finally {
            if (maxRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = maxRetries;
            if (response) await response;
            await current.close();
        }
    });

    it('admits Accounts before mutation reads and replays a newly granted recipient through the archive route', async () => {
        const current = await fixture();
        const recipient = await db.account.create({ data: {
            id: `000-discussion-archive-${randomUUID()}`, publicKey: randomUUID(), encryptionMode: 'plain',
        } });
        const original = db.$transaction;
        const attempts: string[][] = [];
        let addedRecipient = false;
        // Observe the native transaction boundary without replacing its queries.
        db.$transaction = new Proxy(original, { apply(target, receiver, args) {
            const operation: unknown = args[0];
            if (typeof operation !== 'function') return Reflect.apply(target, receiver, args);
            const options: unknown = args[1];
            if (options && typeof options === 'object' && Reflect.get(options, 'isolationLevel') === 'RepeatableRead') {
                return Reflect.apply(target, receiver, args);
            }
            const queries: string[] = [];
            attempts.push(queries);
            return Reflect.apply(target, receiver, [async (tx: Tx) => Reflect.apply(operation, undefined, [new Proxy(tx, {
                get(owner, property, proxyReceiver) {
                    const member: unknown = Reflect.get(owner, property, proxyReceiver);
                    if (typeof property === 'string' && property.startsWith('$') && typeof member === 'function') {
                        return (...queryArgs: unknown[]) => {
                            const sql = String(queryArgs[0]);
                            if (!/^(SHOW|SET)\b/.test(sql)) queries.push(sql);
                            const query: unknown = Reflect.apply(member, owner, queryArgs);
                            if (!/FROM "Account".*FOR KEY SHARE/.test(sql) || addedRecipient) return query;
                            return observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), async () => {
                                if (addedRecipient) return;
                                addedRecipient = true;
                                // A real committed grant appears after preparation,
                                // before Account admission. It must trigger whole-
                                // attempt replay, never late lower-id acquisition.
                                await db.discussionAccountGrant.create({ data: { discussionId: current.discussionId,
                                    accountId: recipient.id, accessLevel: 'view', createdByAccountId: current.owner.id } });
                            });
                        };
                    }
                    if (member && typeof member === 'object' && typeof property === 'string' && !property.startsWith('_')) {
                        return new Proxy(member, { get(delegate, method) {
                            const execute: unknown = Reflect.get(delegate, method);
                            return typeof execute === 'function' ? (...queryArgs: unknown[]) => {
                                queries.push(`${property}.${String(method)}`);
                                return Reflect.apply(execute, delegate, queryArgs);
                            } : execute;
                        } });
                    }
                    return member;
                },
            })]), ...args.slice(1)]);
        } });
        try {
            const result = await current.app.inject({ method: 'POST', url: DISCUSSION_HTTP_PATHS_V1.archive.replace(':discussionId', current.discussionId) });
            expect(result.statusCode, result.body).toBe(200);
            expect(attempts).toHaveLength(2);
            for (const attempt of attempts) expect(attempt[0]).toMatch(/FROM "Account".*FOR KEY SHARE/);
            expect(DiscussionDetailsResponseV1Schema.parse(result.json()).discussion.archivedAt).not.toBeNull();
            expect(await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                accountId: recipient.id, kind: 'discussion', entityId: current.discussionId,
            } }, select: { cursor: true } })).toEqual({ cursor: 1 });
        } finally {
            db.$transaction = original;
            await current.close();
            await db.account.delete({ where: { id: recipient.id } });
        }
    });

    it('keeps one archived timestamp when concurrent archive requests read the same active Discussion', async () => {
        const current = await fixture();
        const archive = () => current.app.inject({ method: 'POST',
            url: DISCUSSION_HTTP_PATHS_V1.archive.replace(':discussionId', current.discussionId) });
        const responses: Array<ReturnType<typeof archive>> = [];
        try {
            await db.$transaction(async holder => {
                await holder.$queryRaw`SELECT "id" FROM "Discussion" WHERE "id" = ${current.discussionId} FOR UPDATE`;
                let finished = 0;
                const start = () => {
                    const response = archive();
                    void response.then(() => { finished += 1; }, () => { finished += 1; });
                    responses.push(response);
                };
                start();
                let waiting = 0;
                while (finished === 0 && waiting < 1) {
                    const [row] = await db.$queryRaw<Array<{ waiting: number }>>`
                        SELECT COUNT(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database()
                            AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%UPDATE%Discussion%'
                    `;
                    waiting = row.waiting;
                }
                expect(waiting).toBe(1);
                start();
                while (finished === 0 && waiting < 2) {
                    const [row] = await db.$queryRaw<Array<{ waiting: number }>>`
                        SELECT COUNT(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database()
                            AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%UPDATE%Discussion%'
                    `;
                    waiting = row.waiting;
                }
                expect(waiting).toBe(2);
            });
            const results = await Promise.all(responses);
            for (const result of results) expect(result.statusCode, result.body).toBe(200);
            const timestamps = results.map(result => DiscussionDetailsResponseV1Schema.parse(result.json()).discussion.archivedAt);
            expect(timestamps[0]).not.toBeNull();
            expect(timestamps[1]).toBe(timestamps[0]);
            expect((await db.discussion.findUniqueOrThrow({ where: { id: current.discussionId } })).archivedAt?.getTime()).toBe(timestamps[0]);
        } finally {
            await Promise.all(responses);
            await current.close();
        }
    });
});
