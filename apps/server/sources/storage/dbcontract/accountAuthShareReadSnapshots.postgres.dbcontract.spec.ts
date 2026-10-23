import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';

import { computeAccountActivityBadgeCounts } from '@/app/activity/accountActivityBadge';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { accessKeysRoutes } from '@/app/api/routes/accessKeys/accessKeysRoutes';
import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { registerSavedSecretResourceRoutes } from '@/app/api/routes/account/registerSavedSecretResourceRoutes';
import { registerAccountEncryptionMigrateRoutes } from '@/app/api/routes/account/registerAccountEncryptionMigrateRoutes';
import { homeGovernanceRoutes } from '@/app/api/routes/home/homeGovernanceRoutes';
import { homeDomainActionPathForMethod } from '@/app/api/routes/actions/homeDomainActionRoute';
import { registerTerminalAuthRequestRoutes } from '@/app/api/routes/auth/registerTerminalAuthRequestRoutes';
import { registerKeyChallengeAuthRoute } from '@/app/api/routes/auth/registerKeyChallengeAuthRoute';
import { auth } from '@/app/auth/auth';
import { HomeAccountListResultV1Schema } from '@happier-dev/protocol/home/governance';
import { bindReviewCommentEventSensitiveEnvelopeV1, buildReviewCommentEventRequestBindingV1, sealReviewCommentEventSensitiveEnvelopeV1 } from '@happier-dev/protocol';
import { createDiscussion } from '@/app/discussions/mutations';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createHomeCredentialDestinationDigestV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { createHomeApprovalGate } from '@/app/api/routes/auth/homeApprovalGate';
import { redeemHomeLoginAssertion } from '@/app/accountDirectory/accountDirectoryService';
import { accountDirectorySigningKeyMetadata, mintHomeLoginAssertion, resolveAccountDirectorySigningKeyPair } from '@/app/accountDirectory/accountDirectorySigner';
import { publicShareRoutes } from '@/app/api/routes/share/publicShareRoutes';
import { registerPublicShareReadRoutes } from '@/app/api/routes/share/registerPublicShareReadRoutes';
import { registerStoredContentPublicShareRoutes } from '@/app/api/routes/share/registerStoredContentPublicShareRoutes';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Account/auth/share coherent read owners', () => {
    const applicationName = `c5-account-readers-${randomUUID()}`;
    const accountIds: string[] = [];
    const apps: ReturnType<typeof createAuthenticatedTestApp>[] = [];
    let originalDatabaseUrl: string | undefined;
    let connected = false;

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error('Use the disposable PostgreSQL DB-contract harness');
        originalDatabaseUrl = supplied;
        const url = new URL(supplied);
        url.searchParams.set('application_name', applicationName);
        process.env.DATABASE_URL = url.toString();
        vi.stubEnv('HANDY_MASTER_SECRET', 'account-reader-fixture-only');
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', 'srv_account_reader_fixture');
        initDbPostgres();
        await db.$connect();
        connected = true;
        await auth.init();
        expect(await db.$queryRaw`SELECT current_setting('application_name') AS name`).toEqual([{ name: applicationName }]);
    });
    afterEach(async () => {
        await Promise.all(apps.splice(0).map(app => app.close()));
        if (connected) {
            const where = { accountId: { in: accountIds } };
            await db.accessKey.deleteMany({ where });
            await db.sessionMessage.deleteMany({ where: { session: where } });
            await db.session.deleteMany({ where });
            await db.machine.deleteMany({ where });
            await db.terminalAuthRequest.deleteMany({ where: { responseAccountId: { in: accountIds } } });
            await db.reviewCommentEvent.deleteMany({ where });
            await db.reviewComment.deleteMany({ where });
            await db.discussion.deleteMany({ where: { ownerAccountId: { in: accountIds } } });
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
        }
        accountIds.length = 0;
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
        vi.unstubAllEnvs();
    });

    async function account() {
        const row = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        accountIds.push(row.id);
        return row;
    }
    async function session(accountId: string) {
        return db.session.create({ data: { accountId, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
    }
    function app(register: (app: ReturnType<typeof createAuthenticatedTestApp>) => void) {
        const value = createAuthenticatedTestApp();
        register(value);
        apps.push(value);
        return value;
    }

    // Block a later real SELECT, after the owning callback has captured earlier
    // facts. A concurrent SSI writer makes predicate locking observable even
    // when PostgreSQL could otherwise optimize a safe serializable read away.
    async function acrossCommit<T>(input: {
        lock: (tx: Tx) => Promise<unknown>;
        change: (tx: Tx) => Promise<unknown>;
        read: () => Promise<T>;
        before: (value: T) => void;
        after: (value: T) => void;
    }) {
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        const writer = inTx(async tx => {
            await input.lock(tx);
            await input.change(tx);
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            ready(pid);
            await released;
        }, { isolationLevel: 'Serializable' });
        const writerOutcome = Promise.allSettled([writer]);
        let reader: Promise<T> | undefined;
        try {
            const writerPid = await Promise.race([started, writer.then(() => { throw new Error('Writer ended before rendezvous'); })]);
            let settled = false;
            reader = input.read();
            const readerOutcome = Promise.allSettled([reader]).finally(() => { settled = true; });
            let readerPid: number | undefined;
            while (!settled) {
                const rows = await db.$queryRaw<Array<{ pid: number }>>`
                    SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                    AND application_name = ${applicationName} AND ${writerPid} = ANY(pg_blocking_pids(pid))
                `;
                if (rows[0]) { readerPid = rows[0].pid; break; }
            }
            if (readerPid === undefined) {
                await reader;
                throw new Error('Reader never reached its later SELECT');
            }
            const [{ count }] = await db.$queryRaw<Array<{ count: number }>>`
                SELECT count(*)::int AS count FROM pg_locks WHERE mode = 'SIReadLock' AND pid = ${readerPid}
                AND virtualtransaction IN (SELECT virtualtransaction FROM pg_locks WHERE pid = ${readerPid}
                    AND locktype = 'virtualxid' AND mode = 'ExclusiveLock' AND granted)
            `;
            release();
            await writer;
            input.before(await reader);
            await readerOutcome;
            input.after(await input.read());
            expect(count).toBe(0);
        } finally {
            release();
            await writerOutcome;
            if (reader) await Promise.allSettled([reader]);
        }
    }

    it('captures Machine availability and the disclosed AccessKey coherently without predicate locks', async () => {
        const owner = await account();
        const target = await session(owner.id);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        const key = await db.accessKey.create({ data: { accountId: owner.id, sessionId: target.id, machineId: machine.id, data: 'before' } });
        const http = app(accessKeysRoutes);
        const read = async () => {
            const response = await http.inject({ method: 'GET', url: `/v1/access-keys/${target.id}/${machine.id}`, headers: { 'x-test-user-id': owner.id } });
            expect(response.statusCode, response.body).toBe(200);
            return response.json();
        };
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE "AccessKey" IN ACCESS EXCLUSIVE MODE`,
            change: tx => tx.accessKey.update({ where: { id: key.id }, data: { data: 'after', dataVersion: 1 } }),
            read,
            before: value => expect(value).toMatchObject({ accessKey: { data: 'before', dataVersion: 0 } }),
            after: value => expect(value).toMatchObject({ accessKey: { data: 'after', dataVersion: 1 } }),
        });
    });

    it('captures active Account admission and attention facts coherently without predicate locks', async () => {
        const owner = await account();
        const target = await session(owner.id);
        await db.accountSessionReadState.create({ data: { accountId: owner.id, sessionId: target.id, lastViewedSessionSeq: 0 } });
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE "Session" IN ACCESS EXCLUSIVE MODE`,
            change: tx => tx.session.update({ where: { id: target.id }, data: { pendingUserActionRequestCount: 1 } }),
            read: () => computeAccountActivityBadgeCounts([owner.id]),
            before: value => expect(value.get(owner.id)).toBe(0),
            after: value => expect(value.get(owner.id)).toBe(1),
        });
    });

    it('captures the Account cursor and Session access witness coherently without predicate locks', async () => {
        const owner = await account();
        const target = await session(owner.id);
        const http = app(changesRoutes);
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE "Session" IN ACCESS EXCLUSIVE MODE`,
            change: async tx => {
                await tx.account.update({ where: { id: owner.id }, data: { seq: 1 } });
                await tx.session.delete({ where: { id: target.id } });
            },
            read: async () => {
                const response = await http.inject({ method: 'GET', url: `/v2/changes?sessionAccessSessionId=${target.id}`,
                    headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' } });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            },
            before: value => expect(value).toMatchObject({ nextCursor: 0, sessionAccessProbe: { throughCursor: 0, status: 'available' } }),
            after: value => expect(value).toMatchObject({ nextCursor: 1, sessionAccessProbe: { throughCursor: 1, status: 'unavailable' } }),
        });
    });

    it('captures saved-secret revision and recipient census coherently without predicate locks', async () => {
        const owner = await account();
        const resource = await db.savedSecretResource.create({ data: { ownerAccountId: owner.id,
            displayName: 'census', kind: 'token', encryptionMode: 'e2ee', storedContent: '{}' } });
        const http = app(registerSavedSecretResourceRoutes);
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE "Account" IN ACCESS EXCLUSIVE MODE`,
            change: async tx => {
                await tx.savedSecretResource.update({ where: { id: resource.id }, data: { revision: 2 } });
                await tx.account.update({ where: { id: owner.id }, data: { status: 'suspended' } });
            },
            read: async () => {
                const response = await http.inject({ method: 'GET', url: `/v1/account/saved-secrets/resources/envelope-census?resourceId=${resource.id}&limit=20`, headers: { 'x-test-user-id': owner.id } });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            },
            before: value => expect(value).toMatchObject({ revision: 1, recipients: [{ account: { accountId: owner.id } }] }),
            after: value => expect(value).toMatchObject({ revision: 2, recipients: [] }),
        });
    });

    it('captures organization version and display rows coherently without predicate locks', async () => {
        const owner = await account();
        await db.sessionOrganizationCheckpoint.create({ data: { accountId: owner.id, version: 1 } });
        const tag = await db.sessionOrganizationTag.create({ data: { accountId: owner.id, tagKey: randomUUID(), tagHash: randomUUID(),
            displayDbValue: JSON.stringify({ t: 'plain', v: { label: 'before' } }) } });
        const http = app(registerAccountEncryptionMigrateRoutes);
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE "SessionOrganizationTag" IN ACCESS EXCLUSIVE MODE`,
            change: async tx => {
                await tx.sessionOrganizationCheckpoint.update({ where: { accountId: owner.id }, data: { version: 2 } });
                await tx.sessionOrganizationTag.update({ where: { id: tag.id }, data: { displayDbValue: JSON.stringify({ t: 'plain', v: { label: 'after' } }) } });
            },
            read: async () => {
                const response = await http.inject({ method: 'GET', url: '/v1/account/encryption/migrate/session-organization/inventory', headers: { 'x-test-user-id': owner.id } });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            },
            before: value => expect(value).toMatchObject({ version: 1, tags: [{ display: { t: 'plain', v: { label: 'before' } } }] }),
            after: value => expect(value).toMatchObject({ version: 2, tags: [{ display: { t: 'plain', v: { label: 'after' } } }] }),
        });
    });

    it('captures Discussion migration titles and messages coherently without predicate locks', async () => {
        const owner = await account();
        const title = (text: string) => ({ t: 'plain' as const, v: { v: 1 as const, title: text } });
        const content = (text: string) => ({ t: 'plain' as const, v: { v: 1 as const, parts: [{ t: 'text' as const, text }] } });
        const created = await createDiscussion({ actorAccountId: owner.id, authentication: createPresentUserSessionAccessAuthentication(), request: {
            creationLocalId: randomUUID(), titleContent: title('before'),
            firstMessage: { localId: randomUUID(), content: content('before'), mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const http = app(registerAccountEncryptionMigrateRoutes);
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE "Account" IN ACCESS EXCLUSIVE MODE`,
            change: async tx => {
                await tx.discussion.update({ where: { id: discussionId }, data: { titleContent: title('after') } });
                await tx.discussionMessage.updateMany({ where: { discussionId }, data: { content: content('after') } });
            },
            read: async () => {
                const response = await http.inject({ method: 'GET', url: '/v1/account/encryption/migrate/discussions/inventory', headers: { 'x-test-user-id': owner.id } });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            },
            before: value => expect(value).toMatchObject({ items: [{ discussionId, titleContent: title('before'), messages: [{ content: content('before') }] }] }),
            after: value => expect(value).toMatchObject({ items: [{ discussionId, titleContent: title('after'), messages: [{ content: content('after') }] }] }),
        });
    });

    it('captures review comments and migration events coherently without predicate locks', async () => {
        const owner = await account();
        const actor = { kind: 'user' as const, userId: owner.id };
        const commentId = randomUUID();
        await db.reviewComment.create({ data: { id: commentId, accountId: owner.id, projectId: 'project-reader', threadId: commentId,
            state: 'open', flagsJson: '{}', authorJson: JSON.stringify(actor), anchorJson: JSON.stringify({ kind: 'file' }),
            snapshotEnvelopeJson: JSON.stringify({ v: 1, layout: 'review_comment_sensitive_in_body_v1' }),
            bodyEnvelopeJson: JSON.stringify({ t: 'plain', v: {} }), bodyVersion: 1, serverRevision: 1,
            editsJson: '[]', dispositionsJson: '{}', transitionsJson: '[]', createdAt: 1n, updatedAt: 1n } });
        const eventId = randomUUID();
        const clientMutationId = randomUUID();
        const requestBinding = buildReviewCommentEventRequestBindingV1({ accountId: owner.id, projectId: 'project-reader', actor,
            actionId: 'reviews.comments.edit', input: { projectId: 'project-reader', commentId, expectedServerRevision: 1,
                expectedBodyVersion: 1, clientMutationId } });
        const event = { eventId, commentId, accountId: owner.id, projectId: 'project-reader', eventKind: 'edited' as const,
            actor, createdAt: 1, serverRevision: 2, event: { clientMutationId } };
        const envelope = bindReviewCommentEventSensitiveEnvelopeV1({ event, requestBinding,
            sensitive: sealReviewCommentEventSensitiveEnvelopeV1({ payload: { v: 1, requestBinding, details: event.event }, mode: 'plain' }) });
        const http = app(registerAccountEncryptionMigrateRoutes);
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE review_comment_events IN ACCESS EXCLUSIVE MODE`,
            change: async tx => {
                await tx.reviewComment.update({ where: { id: commentId }, data: { serverRevision: 2 } });
                await tx.reviewCommentEvent.create({ data: { eventId, commentId, accountId: owner.id, projectId: 'project-reader',
                    eventKind: 'edited', eventEnvelopeJson: JSON.stringify(envelope), clientMutationId, actorJson: JSON.stringify(actor), serverRevision: 2, createdAt: 1n } });
            },
            read: async () => {
                const response = await http.inject({ method: 'GET', url: '/v1/account/encryption/migrate/review-comments/inventory', headers: { 'x-test-user-id': owner.id } });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            },
            before: value => expect(value).toMatchObject({ items: [{ structural: { serverRevision: 1 }, events: [] }] }),
            after: value => expect(value).toMatchObject({ items: [{ structural: { serverRevision: 2 }, events: [{ event: { eventId } }] }] }),
        });
    });

    it('captures Home Account listing rows and authentication coherently without predicate locks', async () => {
        const owner = await account();
        await db.account.update({ where: { id: owner.id }, data: { homeRole: 'owner', name: 'before' } });
        const http = app(homeGovernanceRoutes);
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE "AccountIdentity" IN ACCESS EXCLUSIVE MODE`,
            change: async tx => {
                await tx.account.update({ where: { id: owner.id }, data: { name: 'after' } });
                await tx.accountIdentity.create({ data: { accountId: owner.id, provider: 'email', providerUserId: 'reader-after@example.test' } });
            },
            read: async () => {
                const response = await http.inject({ method: 'POST', url: homeDomainActionPathForMethod('home.accounts.list', 'POST'),
                    headers: { 'x-test-user-id': owner.id }, payload: {} });
                expect(response.statusCode, response.body).toBe(200);
                return HomeAccountListResultV1Schema.parse(response.json());
            },
            before: value => expect(value.items.find(item => item.accountId === owner.id)).toMatchObject({ profile: { name: 'before' }, authentication: { signInEmail: null } }),
            after: value => expect(value.items.find(item => item.accountId === owner.id)).toMatchObject({ profile: { name: 'after' }, authentication: { signInEmail: 'reader-after@example.test' } }),
        });
    });

    it('pages Home Accounts in role, folded display-label and bounded-prefix identity order', async () => {
        const owner = await account();
        await db.account.update({ where: { id: owner.id }, data: { homeRole: 'owner', name: 'Z owner' } });
        const seed = async (data: { id?: string; name?: string | null; username?: string | null }) => {
            const row = await db.account.create({ data: { ...data, encryptionMode: 'plain' } });
            accountIds.push(row.id);
            return row;
        };
        const fallback = await seed({ name: '\t  ', username: 'aardvark' });
        const alpha = await seed({ name: 'Alpha' });
        const beta = await seed({ name: 'beta' });
        const suffix = randomUUID();
        const firstTie = await seed({ id: `c5-sort-a-${suffix}`, name: `${'c'.repeat(32)}zzz` });
        const secondTie = await seed({ id: `c5-sort-b-${suffix}`, name: `${'c'.repeat(32)}aaa` });
        const unnamed = await seed({});
        const http = app(homeGovernanceRoutes);
        const seenCursors = new Set<string>();
        const listed: string[] = [];
        let cursor: string | null = null;
        do {
            const response = await http.inject({ method: 'POST', url: homeDomainActionPathForMethod('home.accounts.list', 'POST'),
                headers: { 'x-test-user-id': owner.id }, payload: { limit: 2, ...(cursor ? { cursor } : {}) } });
            expect(response.statusCode, response.body).toBe(200);
            const page = HomeAccountListResultV1Schema.parse(response.json());
            listed.push(...page.items.map(item => item.accountId));
            cursor = page.nextCursor;
            if (cursor) {
                expect(seenCursors.has(cursor)).toBe(false);
                seenCursors.add(cursor);
            }
        } while (cursor);
        const expected = [owner.id, fallback.id, alpha.id, beta.id, firstTie.id, secondTie.id, unnamed.id];
        expect(listed.filter(id => expected.includes(id))).toEqual(expected);
        expect(new Set(listed).size).toBe(listed.length);
    });

    it('captures approved terminal evidence and token epoch coherently without predicate locks', async () => {
        const owner = await account();
        await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
        const publicKey = new Uint8Array(tweetnacl.box.keyPair().publicKey);
        await db.terminalAuthRequest.create({ data: { publicKey: privacyKit.encodeHex(publicKey), response: 'fixture-response',
            responseAccountId: owner.id, approvalTokenEpoch: 0,
            authenticationEvidence: { v: 1, evidence: [{ kind: 'home_method', methodId: 'key_challenge' }] } } });
        const http = app(value => registerTerminalAuthRequestRoutes(value, { terminalAuthPolicy: { ttlMs: 900_000 }, isTerminalAuthExpired: () => false }));
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE "HomeGovernancePolicy" IN ACCESS EXCLUSIVE MODE`,
            change: tx => tx.account.update({ where: { id: owner.id }, data: { tokenEpoch: 1 } }),
            read: async () => {
                const response = await http.inject({ method: 'POST', url: '/v1/auth/request', payload: { publicKey: privacyKit.encodeBase64(publicKey) } });
                return { status: response.statusCode, value: response.json() };
            },
            before: value => expect({ status: value.status, state: value.value.state, response: value.value.response })
                .toEqual({ status: 200, state: 'authorized', response: 'fixture-response' }),
            after: value => expect(value).toEqual({ status: 409, value: { error: 'credential_authentication_evidence_unavailable' } }),
        });
    });

    it('captures directory trust and the issued token epoch coherently without predicate locks', async () => {
        const owner = await account();
        const env = { ...process.env, HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: '0' };
        const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_account_reader_fixture',
            canonicalServerUrl: 'https://account-reader.test', revision: 1,
            endpoints: [{ kind: 'https' as const, url: 'https://account-reader.test' }] };
        const metadata = accountDirectorySigningKeyMetadata(env);
        await db.accountDirectoryLink.create({ data: { accountId: owner.id, issuerServerIdentityId: descriptor.homeServerIdentityId,
            issuerSubjectId: owner.id, issuerSigningKeyId: metadata.keyId,
            issuerSigningPublicKey: new Uint8Array(resolveAccountDirectorySigningKeyPair(env).publicKey) } });
        const assertion = await mintHomeLoginAssertion({ issuerSubjectId: owner.id, audienceHomeServerIdentityId: descriptor.homeServerIdentityId,
            clientBoxPublicKeyBase64: privacyKit.encodeBase64(new Uint8Array(tweetnacl.box.keyPair().publicKey)), env,
            credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(descriptor) });
        let changeDuringCapture = true;
        let issuedToken: string | undefined;
        const predicateCounts: number[] = [];
        const redeem = () => redeemHomeLoginAssertion({ assertion, env, homeApprovalGate: createHomeApprovalGate(env),
            // Descriptor preparation is a deployment IO boundary. The final
            // callback supplies that prepared descriptor and introduces a real
            // concurrent commit after the directory binding was captured.
            resolveHomeConnectionDescriptor: async tx => {
                if (tx && changeDuringCapture) {
                    changeDuringCapture = false;
                    await inTx(writer => writer.account.update({ where: { id: owner.id }, data: { tokenEpoch: 1 } }), { isolationLevel: 'Serializable' });
                }
                return descriptor;
            },
            issueHomeToken: async (tx, accountId) => {
                issuedToken = await auth.createTokenInTx(tx, accountId, undefined, { kind: 'account', authority: 'present_user' });
                const [{ count }] = await tx.$queryRaw<Array<{ count: number }>>`
                    SELECT count(*)::int AS count FROM pg_locks WHERE mode = 'SIReadLock' AND pid = pg_backend_pid()
                    AND virtualtransaction IN (SELECT virtualtransaction FROM pg_locks WHERE pid = pg_backend_pid()
                        AND locktype = 'virtualxid' AND mode = 'ExclusiveLock' AND granted)
                `;
                predicateCounts.push(count);
                return issuedToken;
            } });
        expect(await redeem()).toMatchObject({ v: 1, homeServerIdentityId: descriptor.homeServerIdentityId });
        if (!issuedToken) throw new Error('Directory credential was not minted');
        expect(await auth.verifyToken(issuedToken)).toBeNull();
        expect(await redeem()).toMatchObject({ v: 1, homeServerIdentityId: descriptor.homeServerIdentityId });
        if (!issuedToken) throw new Error('Directory credential was not minted');
        expect(await auth.verifyToken(issuedToken)).toMatchObject({ userId: owner.id });
        expect(predicateCounts).toEqual([0, 0]);
    });

    it('mints Key Challenge credentials from coherent Account epochs without retaining predicate locks', async () => {
        const owner = await account();
        const signing = tweetnacl.sign.keyPair();
        const publicKey = new Uint8Array(signing.publicKey);
        await db.account.update({ where: { id: owner.id }, data: { publicKey: privacyKit.encodeHex(publicKey) } });
        const challenge = new Uint8Array(32).fill(23);
        const payload = { publicKey: privacyKit.encodeBase64(publicKey), challenge: privacyKit.encodeBase64(challenge),
            signature: privacyKit.encodeBase64(new Uint8Array(tweetnacl.sign.detached(challenge, signing.secretKey))) };
        const http = app(registerKeyChallengeAuthRoute);
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        const writer = inTx(async tx => {
            await tx.account.update({ where: { id: owner.id }, data: { tokenEpoch: 1 } });
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            ready(pid);
            await released;
        }, { isolationLevel: 'Serializable' });
        const writerOutcome = Promise.allSettled([writer]);
        const login = async () => {
            const response = await http.inject({ method: 'POST', url: '/v1/auth', payload });
            expect(response.statusCode, response.body).toBe(200);
            const token: unknown = response.json().token;
            if (typeof token !== 'string') throw new Error('Key Challenge did not mint a credential');
            return token;
        };
        try {
            const writerPid = await Promise.race([started, writer.then(() => { throw new Error('Writer ended before rendezvous'); })]);
            const before = await login();
            // SSI retains a committed reader's predicate locks while this
            // overlapping writer is still open. Observer queries use RC.
            const [{ count }] = await db.$queryRaw<Array<{ count: number }>>`
                SELECT count(*)::int AS count FROM pg_locks locks JOIN pg_stat_activity activity ON activity.pid = locks.pid
                WHERE activity.datname = current_database() AND activity.application_name = ${applicationName}
                    AND locks.mode = 'SIReadLock' AND locks.pid <> ${writerPid}
            `;
            release();
            await writer;
            expect(await auth.verifyToken(before)).toBeNull();
            expect(await auth.verifyToken(await login())).toMatchObject({ userId: owner.id });
            expect(count).toBe(0);
        } finally {
            release();
            await writerOutcome;
        }
    });

    it('captures public-share authority and access logs coherently without predicate locks', async () => {
        const owner = await account();
        const target = await session(owner.id);
        const share = await db.publicSessionShare.create({ data: { sessionId: target.id, createdByUserId: owner.id,
            tokenHash: createHash('sha256').update(randomUUID()).digest() } });
        const log = await db.publicShareAccessLog.create({ data: { publicShareId: share.id, ipAddress: 'before' } });
        const http = app(publicShareRoutes);
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE "PublicShareAccessLog" IN ACCESS EXCLUSIVE MODE`,
            change: tx => tx.publicShareAccessLog.update({ where: { id: log.id }, data: { ipAddress: 'after' } }),
            read: async () => {
                const response = await http.inject({ method: 'GET', url: `/v1/sessions/${target.id}/public-share/access-logs`, headers: { 'x-test-user-id': owner.id } });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            },
            before: value => expect(value).toMatchObject({ logs: [{ ipAddress: 'before' }] }),
            after: value => expect(value).toMatchObject({ logs: [{ ipAddress: 'after' }] }),
        });
    });

    it('captures a public-share token and transcript coherently without predicate locks', async () => {
        const owner = await account();
        const target = await session(owner.id);
        const token = randomUUID();
        await db.publicSessionShare.create({ data: { sessionId: target.id, createdByUserId: owner.id,
            tokenHash: createHash('sha256').update(token).digest() } });
        const message = await db.sessionMessage.create({ data: { sessionId: target.id, seq: 1, content: { t: 'plain', v: 'before' } } });
        const http = app(registerPublicShareReadRoutes);
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE "SessionMessage" IN ACCESS EXCLUSIVE MODE`,
            change: tx => tx.sessionMessage.update({ where: { id: message.id }, data: { content: { t: 'plain', v: 'after' } } }),
            read: async () => {
                const response = await http.inject({ method: 'GET', url: `/v1/public-share/${token}/messages` });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            },
            before: value => expect(value).toMatchObject({ messages: [{ content: { t: 'plain', v: 'before' } }] }),
            after: value => expect(value).toMatchObject({ messages: [{ content: { t: 'plain', v: 'after' } }] }),
        });
    });

    it('captures stored-share subject authority and access logs coherently without predicate locks', async () => {
        const owner = await account();
        const target = await session(owner.id);
        const share = await db.publicSessionShare.create({ data: { sessionId: target.id, createdByUserId: owner.id,
            tokenHash: createHash('sha256').update(randomUUID()).digest(), keyDerivation: 'fragment_v1' } });
        const log = await db.publicShareAccessLog.create({ data: { publicShareId: share.id, ipAddress: 'before' } });
        const http = app(registerStoredContentPublicShareRoutes);
        await acrossCommit({
            lock: tx => tx.$executeRaw`LOCK TABLE "PublicShareAccessLog" IN ACCESS EXCLUSIVE MODE`,
            change: tx => tx.publicShareAccessLog.update({ where: { id: log.id }, data: { ipAddress: 'after' } }),
            read: async () => {
                const response = await http.inject({ method: 'GET', url: `/v1/public-shares/${share.id}/access-log`, headers: { 'x-test-user-id': owner.id } });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            },
            before: value => expect(value).toMatchObject({ accessLog: [{ ipAddress: 'before' }] }),
            after: value => expect(value).toMatchObject({ accessLog: [{ ipAddress: 'after' }] }),
        });
    });
});
