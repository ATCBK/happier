import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { DISCUSSION_AGENT_POST_EVENT_V1, DISCUSSION_HTTP_PATHS_V1, DiscussionAgentPostResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { homeDomainActionPathForMethod } from '@/app/api/routes/actions/homeDomainActionRoute';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { registerTeamMemberRoutes } from '@/app/teams/memberships/registerTeamMemberRoutes';
import { registerTeamGroupRoutes } from '@/app/teams/groups/registerTeamGroupRoutes';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { createDiscussion } from './mutations';
import { inviteDiscussionParticipant, setDiscussionGrant } from './accessService';

const authentication = createPresentUserSessionAccessAuthentication();
const request = () => ({ localId: randomUUID(), content: { t: 'plain' as const,
    v: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Current authority only' }] } }, mentionedAccountIds: [] });
const headers = (accountId: string) => ({ 'x-test-user-id': accountId, 'x-happier-account-stored-content-protocol': '4' });
function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

/** Only the native Prisma scheduling boundary is observed; domain owners stay real. */
function beforeMutationQuery(matches: (delegate: string, method: string, args: readonly unknown[]) => boolean,
    before: () => Promise<void>, phase: 'before' | 'after' = 'before') {
    const original = db.$transaction;
    let observed = false;
    db.$transaction = new Proxy(original, { apply(target, receiver, args) {
        const operation: unknown = args[0];
        const options: unknown = args[1];
        if (typeof operation !== 'function'
            || options && typeof options === 'object' && Reflect.get(options, 'isolationLevel') === 'RepeatableRead') {
            return Reflect.apply(target, receiver, args);
        }
        return Reflect.apply(target, receiver, [async (tx: Tx) => Reflect.apply(operation, undefined, [new Proxy(tx, {
            get(owner, property, proxyReceiver) {
                const delegate: unknown = Reflect.get(owner, property, proxyReceiver);
                if (property === '$queryRawUnsafe' && typeof delegate === 'function') return (...queryArgs: unknown[]) => {
                    const query: unknown = Reflect.apply(delegate, owner, queryArgs);
                    if (observed || !matches(property, '', queryArgs)) return query;
                    if (phase === 'after') {
                        observed = true;
                        return Promise.resolve(query).then(async value => { await before(); return value; });
                    }
                    return observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), async () => {
                        if (observed) return;
                        observed = true;
                        await before();
                    });
                };
                if (!delegate || typeof delegate !== 'object' || typeof property !== 'string' || property.startsWith('_')) return delegate;
                return new Proxy(delegate, { get(model, method) {
                    const execute: unknown = Reflect.get(model, method);
                    if (typeof execute !== 'function' || typeof method !== 'string') return execute;
                    return (...queryArgs: unknown[]) => {
                        const query: unknown = Reflect.apply(execute, model, queryArgs);
                        if (observed || !matches(property, method, queryArgs)) return query;
                        if (phase === 'after') {
                            observed = true;
                            return Promise.resolve(query).then(async value => { await before(); return value; });
                        }
                        return observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), async () => {
                            if (observed) return;
                            observed = true;
                            await before();
                        });
                    };
                } });
            },
        })]), ...args.slice(1)]);
    } });
    return () => { db.$transaction = original; };
}
const allocation = (delegate: string, method: string) => delegate === 'discussion' && method === 'update';
const discussionAccess = (delegate: string, method: string, args: readonly unknown[]) => delegate === 'discussion' && method === 'findMany'
    && args[0] !== null && typeof args[0] === 'object' && Reflect.get(args[0], 'select') !== null
    && typeof Reflect.get(args[0], 'select') === 'object' && Reflect.has(Reflect.get(args[0], 'select'), 'keyEnvelopes');

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Discussion append authority (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_TEAMS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { vi.unstubAllEnvs(); await shutdownDbClient(); });

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const app: Fastify = createAuthenticatedTestApp();
        registerDiscussionRoutes(app);
        registerTeamMemberRoutes(app);
        registerTeamGroupRoutes(app);
        machinesRoutes(app);
        await app.ready();
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Authority contention' } }, firstMessage: request(),
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        return { owner, app, discussionId, append: (actor: string, payload = request()) => app.inject({ method: 'POST',
            url: DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', discussionId), headers: headers(actor), payload }),
        publicationState: async () => ({
            account: await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } }),
            discussion: await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
                accountId: owner.id, kind: 'discussion', entityId: discussionId,
            } } }),
        }),
        assertMessages: async (localId: string, accepted: boolean) => {
            expect(await db.discussion.findUniqueOrThrow({ where: { id: discussionId } })).toMatchObject({ messageSeq: accepted ? 2 : 1 });
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(accepted ? 2 : 1);
            expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(accepted ? 1 : 0);
            expect(await db.discussionMessage.findUniqueOrThrow({ where: { id: created.value.firstMessage.id } }))
                .toMatchObject({ seq: 1, addressingV1: { throughSeq: 1, participantSessionIds: [] } });
            if (accepted) expect(await db.discussionMessage.findUniqueOrThrow({ where: { discussionId_localId: { discussionId, localId } } }))
                .toMatchObject({ seq: 2, addressingV1: { participantSessionIds: [], throughSeq: 2 } });
        }, close: async () => {
            await app.close();
            await db.accessKey.deleteMany({ where: { accountId: owner.id } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.machine.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        } };
    }

    // If the fixed reader already owns authority, the competing writer must
    // wait. Release append rather than awaiting that writer inside the pause.
    async function writerCommittedOrBlocked(writer: Promise<unknown>) {
        let finished = false;
        void writer.then(() => { finished = true; }, () => { finished = true; });
        while (!finished) {
            const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                    AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting
            `;
            if (row.waiting) return false;
        }
        return true;
    }

    for (const { kind, direct } of [{ kind: 'team', direct: false }, { kind: 'group', direct: false }, { kind: 'team', direct: true }] as const) {
        async function collectiveFixture() {
            const current = await fixture();
            const actor = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
            const team = await db.team.create({ data: { name: 'Append authority' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: current.owner.id, role: 'owner' } });
            const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
            const group = kind === 'group' ? await db.teamGroup.create({ data: { teamId: team.id, name: 'Append readers', nameKey: 'append-readers' } }) : null;
            if (group) await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: member.id, nativeContribution: true } });
            expect(await setDiscussionGrant({ authentication, actorAccountId: current.owner.id, discussionId: current.discussionId,
                request: { principal: group ? { kind: 'group', teamId: team.id, groupId: group.id } : { kind: 'team', teamId: team.id }, accessLevel: 'edit' } }))
                .toMatchObject({ ok: true });
            if (direct) expect(await setDiscussionGrant({ authentication, actorAccountId: current.owner.id, discussionId: current.discussionId,
                request: { principal: { kind: 'account', accountId: actor.id }, accessLevel: 'edit' } })).toMatchObject({ ok: true });
            return { ...current, actor, add: () => current.app.inject({ method: 'POST', headers: headers(current.owner.id),
                url: homeDomainActionPathForMethod('teams.members.add', 'POST'),
                payload: { v: 1, teamId: team.id, accountId: actor.id, role: 'member', historyAccess: 'from_membership' },
            }).then(response => { expect(response.statusCode, response.body).toBe(200); return response; }), revoke: async () => {
                const target = await db.teamMembership.findUniqueOrThrow({ where: { teamId_accountId: { teamId: team.id, accountId: actor.id } } });
                return current.app.inject({ method: 'POST', headers: headers(current.owner.id),
                url: homeDomainActionPathForMethod(group ? 'teams.groups.members.remove' : 'teams.members.remove', 'POST'),
                payload: group ? { v: 1, teamId: team.id, groupId: group.id, accountId: actor.id } : { v: 1, teamId: team.id, membershipId: target.id },
            }).then(response => { expect(response.statusCode, response.body).toBe(200); return response; }); }, close: async () => {
                await db.team.delete({ where: { id: team.id } });
                await current.close();
                await db.account.delete({ where: { id: actor.id } });
            } };
        }

        it(`orders ${kind} withdrawal against an admitted HTTP append (surviving direct grant: ${direct})`, async () => {
            const current = await collectiveFixture();
            const paused = signal(); const resume = signal();
            const restore = beforeMutationQuery(allocation, async () => { paused.resolve(); await resume.promise; });
            const payload = request();
            const posting = current.append(current.actor.id, payload).then(result => result);
            let revoking: ReturnType<typeof current.revoke> | undefined;
            try {
                await Promise.race([paused.promise, posting.then(() => { throw new Error('Append ended before authority pause'); })]);
                revoking = current.revoke();
                const revokedFirst = await writerCommittedOrBlocked(revoking);
                const withdrawn = revokedFirst ? await current.publicationState() : null;
                resume.resolve();
                const [posted] = await Promise.all([posting, revoking]);
                const accepted = direct || !revokedFirst;
                expect(posted.statusCode, posted.body).toBe(accepted ? 200 : 403);
                await current.assertMessages(payload.localId, accepted);
                if (!accepted) expect(await current.publicationState()).toEqual(withdrawn);
            } finally { resume.resolve(); await Promise.allSettled([posting, revoking]); restore(); await current.close(); }
        });

        it(`rechecks ${kind} withdrawal committed before the locking access read (surviving direct grant: ${direct})`, async () => {
            const current = await collectiveFixture();
            let withdrawn: Awaited<ReturnType<typeof current.publicationState>> | undefined;
            const restore = beforeMutationQuery(discussionAccess, async () => { await current.revoke(); withdrawn = await current.publicationState(); }, 'after');
            const payload = request();
            try {
                const posted = await current.append(current.actor.id, payload);
                expect(posted.statusCode, posted.body).toBe(direct ? 200 : 403);
                await current.assertMessages(payload.localId, direct);
                if (!direct) expect(await current.publicationState()).toEqual(withdrawn);
            } finally { restore(); await current.close(); }
        });

        if (kind === 'team' && !direct) it('does not borrow an unlocked re-created membership lifetime after the authority lookup missed', async () => {
            const current = await collectiveFixture();
            const paused = signal(); const resume = signal();
            const afterCapture = beforeMutationQuery(discussionAccess, async () => { await current.revoke(); }, 'after');
            const afterMissingLock = beforeMutationQuery((delegate, _method, args) => delegate === '$queryRawUnsafe'
                && /FROM "TeamMembership".*FOR SHARE/.test(String(args[0])), async () => { await current.add(); }, 'after');
            const beforeAllocation = beforeMutationQuery(allocation, async () => { paused.resolve(); await resume.promise; });
            const payload = request(); const posting = current.append(current.actor.id, payload).then(result => result);
            let revoking: ReturnType<typeof current.revoke> | undefined;
            try {
                await Promise.race([paused.promise, posting.then(() => { throw new Error('Append ended before re-created membership pause'); })]);
                revoking = current.revoke();
                const revokedFirst = await writerCommittedOrBlocked(revoking);
                resume.resolve();
                const [posted] = await Promise.all([posting, revoking]);
                expect(posted.statusCode, posted.body).toBe(revokedFirst ? 403 : 200);
                await current.assertMessages(payload.localId, !revokedFirst);
            } finally {
                resume.resolve(); await Promise.allSettled([posting, revoking]);
                beforeAllocation(); afterMissingLock(); afterCapture(); await current.close();
            }
        });
    }

    async function publisherFixture() {
        const current = await fixture();
        const session = await db.session.create({ data: { accountId: current.owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: current.owner.id, discussionId: current.discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: current.owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'test', platform: 'linux', happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.accessKey.create({ data: { accountId: current.owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(current.owner.id, socket as never, { connectionType: 'session-scoped', socket, userId: current.owner.id, sessionId: session.id } as never,
            { presence: createSessionPublisherPresence(), binding: { accountId: current.owner.id, machineId: machine.id, sessionId: session.id } });
        let snapshot: unknown;
        await getSocketHandler(socket, 'session-runtime-activity-snapshot')({ sessionId: session.id, mutationId: randomUUID(),
            snapshot: { state: 'idle', activeCount: 0 } }, (value: unknown) => { snapshot = value; });
        expect(snapshot).toMatchObject({ status: expect.stringMatching(/^(applied|unchanged)$/) });
        const binding = { accountId: current.owner.id, machineId: machine.id, sessionId: session.id };
        return { ...current, binding, publish: async (payload = request()) => {
            let response: unknown;
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({ v: 1, sessionId: session.id, discussionId: current.discussionId, request: payload },
                (value: unknown) => { response = value; });
            return DiscussionAgentPostResponseV1Schema.parse(response);
        }, revoke: () => current.app.inject({ method: 'POST', url: `/v1/machines/${machine.id}/revoke`, headers: headers(current.owner.id) })
            .then(response => { expect(response.statusCode, response.body).toBe(200); return response; }) };
    }

    it('orders real Machine revoke against an admitted trusted socket append', async () => {
        const current = await publisherFixture();
        const paused = signal(); const resume = signal();
        const restore = beforeMutationQuery(allocation, async () => { paused.resolve(); await resume.promise; });
        const payload = request(); const posting = current.publish(payload);
        let revoking: ReturnType<typeof current.revoke> | undefined;
        try {
            await Promise.race([paused.promise, posting.then(() => { throw new Error('Publisher ended before authority pause'); })]);
            revoking = current.revoke();
            const revokedFirst = await writerCommittedOrBlocked(revoking);
            const withdrawn = revokedFirst ? await current.publicationState() : null;
            resume.resolve();
            const [posted] = await Promise.all([posting, revoking]);
            expect(posted.ok).toBe(!revokedFirst);
            if (revokedFirst) expect(posted).toMatchObject({ ok: false, error: 'discussion_post_denied' });
            await current.assertMessages(payload.localId, !revokedFirst);
            if (revokedFirst) expect(await current.publicationState()).toEqual(withdrawn);
        } finally { resume.resolve(); await Promise.allSettled([posting, revoking]); restore(); await current.close(); }
    });

    it('refuses trusted socket append when Machine revoke commits before the locking publisher read', async () => {
        const current = await publisherFixture();
        let withdrawn: Awaited<ReturnType<typeof current.publicationState>> | undefined;
        const restore = beforeMutationQuery((delegate, _method, args) => delegate === '$queryRawUnsafe'
            && /FROM "Machine".*FOR SHARE/.test(String(args[0])), async () => { await current.revoke(); withdrawn = await current.publicationState(); });
        const payload = request();
        try {
            expect(await current.publish(payload)).toMatchObject({ ok: false, error: 'discussion_post_denied' });
            await current.assertMessages(payload.localId, false);
            expect(await current.publicationState()).toEqual(withdrawn);
        } finally { restore(); await current.close(); }
    });

    it('does not borrow an AccessKey created after the exact locking lookup missed', async () => {
        const current = await publisherFixture();
        // Initial fixture state: the registered publisher has lost its tuple.
        await db.accessKey.deleteMany({ where: current.binding });
        const restore = beforeMutationQuery((delegate, _method, args) => delegate === '$queryRawUnsafe'
            && /FROM "AccessKey".*FOR SHARE/.test(String(args[0])), async () => {
                expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { ...current.binding, data: 'replacement' })))
                    .toMatchObject({ ok: true, created: true });
            }, 'after');
        const payload = request();
        try {
            expect(await current.publish(payload)).toMatchObject({ ok: false, error: 'discussion_post_denied' });
            await current.assertMessages(payload.localId, false);
        } finally { restore(); await current.close(); }
    });
});
