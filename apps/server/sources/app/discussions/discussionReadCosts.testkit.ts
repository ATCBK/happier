import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { db } from '@/storage/db';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import * as storage from '@/storage/prisma';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createDiscussion } from './mutations';
import { listDiscussions, readDiscussionMessages } from './queries';
import { readDiscussionAttention } from './attentionFacts';
import { resolveDiscussionDocSourcesInTx } from './docPassages';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { executeDocReadV1 } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import { DiscussionListInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DiscussionTitleV1Schema } from '@happier-dev/protocol/discussions/content';

const authentication = createPresentUserSessionAccessAuthentication();
const body = { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: 'Message' }] } };
const evidence = { kind: 'plainDigest', digest: 'A'.repeat(43) };
const fixtureAccountIds: string[] = [];

/** Observe only the real DB transport. All queries, admission and projection execute unchanged. */
async function measure<T>(run: () => Promise<T>) {
    const reads: Array<{ model: string; rows: number }> = [];
    const observeQuery = (query: unknown, record: (result: unknown) => void) => observeLazyPrismaQuery(query,
        () => ({ started() {}, settled() {} }), undefined, async consume => {
            const result = await consume();
            record(result);
            return result;
        });
    const observe = (tx: Tx): Tx => new Proxy(tx, {
        get(target, property, receiver) {
            const delegate: unknown = Reflect.get(target, property, receiver);
            if ((property === '$queryRaw' || property === '$queryRawUnsafe') && typeof delegate === 'function') {
                return (...args: unknown[]) => observeQuery(Reflect.apply(delegate, target, args), result => {
                    // Transaction deadline probes are not resource reads.
                    const text = typeof args[0] === 'string' ? args[0] : String(Reflect.get(args[0] as object, 'sql'));
                    if (/Discussion/.test(text)) reads.push({ model: /WITH RECURSIVE/.test(text) ? 'ancestors' : 'raw', rows: Array.isArray(result) ? result.length : 0 });
                });
            }
            if (typeof delegate === 'function') return delegate.bind(target);
            if (!String(property).startsWith('discussion') || delegate === null || typeof delegate !== 'object') return delegate;
            return new Proxy(delegate, { get(owner, operation, delegateReceiver) {
                const method: unknown = Reflect.get(owner, operation, delegateReceiver);
                if (typeof method !== 'function' || !String(operation).startsWith('find')) return method;
                return (...args: unknown[]) => observeQuery(Reflect.apply(method, owner, args), result => {
                    const select: unknown = args[0] && typeof args[0] === 'object' ? Reflect.get(args[0], 'select') : null;
                    const ancestry = property === 'discussionMessage' && select && typeof select === 'object'
                        && Object.keys(select).length === 2 && Reflect.get(select, 'replyTargetV1') === true;
                    reads.push({ model: ancestry ? 'ancestors' : String(property), rows: Array.isArray(result) ? result.length : result ? 1 : 0 });
                });
            } });
        },
    });
    const original = db.$transaction;
    const sqliteRead = storage.withSqliteReadSnapshot;
    const sqlite = storage.getDbProviderFromEnv(process.env, 'postgres') === 'sqlite';
    const spy = sqlite ? vi.spyOn(storage, 'withSqliteReadSnapshot').mockImplementation((read, options) =>
        sqliteRead(tx => read(observe(tx)), options)) : null;
    if (!sqlite) db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        return typeof callback !== 'function' ? Reflect.apply(target, receiver, args)
            : Reflect.apply(target, receiver, [(tx: Tx) => callback(observe(tx)), ...args.slice(1)]);
    } });
    try { return { result: await run(), reads }; }
    finally { spy?.mockRestore(); if (!sqlite) db.$transaction = original; }
}

async function account() {
    const row = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    fixtureAccountIds.push(row.id);
    return row;
}

async function seedDiscussions(ownerAccountId: string, count: number, extra: Readonly<{ lastMessageAt?: Date }> = {}) {
    const ids = Array.from({ length: count }, () => randomUUID());
    await db.discussion.createMany({ data: ids.map(id => ({ id, ownerAccountId, createdByAccountId: ownerAccountId,
        encryptionMode: 'plain', dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
        creationLocalId: id, creationEqualityEvidenceV1: evidence,
        titleContent: { t: 'plain', v: { v: 1, title: 'Costs' } }, messageSeq: 1,
        lastMessageAt: extra.lastMessageAt ?? new Date(1_000),
    })) });
    return ids;
}

/** Same deciding owner contracts run against disposable PostgreSQL and SQLite. */
export function discussionReadCostContracts() {
    afterEach(async () => {
        const ids = fixtureAccountIds.splice(0);
        await db.artifact.deleteMany({ where: { accountId: { in: ids } } });
        await db.account.deleteMany({ where: { id: { in: ids } } });
    });
    it('selects one exact committed message without acquiring unrelated history and keeps local IDs private', async () => {
        const owner = await account(), another = await account();
        const [discussionId] = await seedDiscussions(owner.id, 1);
        const rows = Array.from({ length: 210 }, (_, index) => ({ discussionId, seq: index + 1,
            localId: `private-${index + 1}`, authorAccountId: index === 1 ? another.id : owner.id,
            requestEqualityEvidenceV1: evidence, content: body }));
        await db.discussionMessage.createMany({ data: rows });
        await db.discussion.update({ where: { id: discussionId }, data: { messageSeq: rows.length } });
        const selected = await db.discussionMessage.findFirstOrThrow({ where: { discussionId, seq: 3 } });
        const foreign = await db.discussionMessage.findFirstOrThrow({ where: { discussionId, seq: 2 } });
        const read = { actorAccountId: owner.id, authentication, discussionId };
        const measured = await measure(() => readDiscussionMessages({ ...read, messageId: selected.id, throughSeq: 3 }));
        expect(measured.result).toMatchObject({ ok: true, value: { messages: [{ id: selected.id, seq: 3 }],
            hasMoreOlder: false, messageSeq: 3 } });
        if (!measured.result.ok) throw new Error(measured.result.error);
        expect(measured.result.value.messages).toHaveLength(1);
        expect(measured.reads.filter(read => read.model === 'discussionMessage').reduce((sum, read) => sum + read.rows, 0)).toBe(1);
        expect(await readDiscussionMessages({ ...read, messageId: selected.id, throughSeq: 2 }))
            .toEqual({ ok: true, value: { messages: [], hasMoreOlder: false, messageSeq: 2 } });
        expect(await readDiscussionMessages({ ...read, messageId: foreign.id }))
            .toMatchObject({ ok: true, value: { messages: [{ id: foreign.id, localId: null }] } });
        expect(await readDiscussionMessages({ ...read, localId: foreign.localId! }))
            .toEqual({ ok: true, value: { messages: [], hasMoreOlder: false, messageSeq: 210 } });
        expect(await readDiscussionMessages({ ...read, localId: selected.localId!, throughSeq: 3 }))
            .toMatchObject({ ok: true, value: { messages: [{ id: selected.id, localId: selected.localId }] } });
        expect(await readDiscussionMessages({ ...read, messageId: randomUUID() }))
            .toEqual({ ok: true, value: { messages: [], hasMoreOlder: false, messageSeq: 210 } });
        const [otherDiscussionId] = await seedDiscussions(owner.id, 1);
        expect(await readDiscussionMessages({ ...read, discussionId: otherDiscussionId, messageId: selected.id }))
            .toEqual({ ok: true, value: { messages: [], hasMoreOlder: false, messageSeq: 1 } });
        expect(await readDiscussionMessages({ ...read, actorAccountId: another.id, messageId: selected.id }))
            .toEqual({ ok: false, error: 'discussion_not_found' });
    });
    it.each([1, 1_000, 20_000])('B-S1 reads no inventory rows for empty limit:1 attention with N=%i', async count => {
        const owner = await account();
        const ids = await seedDiscussions(owner.id, count);
        await db.discussionMessage.createMany({ data: ids.map(discussionId => ({ discussionId, localId: randomUUID(), seq: 1,
            authorAccountId: owner.id, requestEqualityEvidenceV1: evidence, content: body })) });
        await db.discussionReadState.createMany({ data: ids.map(discussionId => ({ discussionId, accountId: owner.id, lastReadSeq: 1 })) });
        const measured = await measure(() => readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }));
        expect(measured.result).toEqual({ ok: true, value: { discussions: [], nextCursor: null, incomplete: false } });
        const materialized = measured.reads.filter(read => read.model === 'discussion' || read.model === 'discussionReadState')
            .reduce((sum, read) => sum + read.rows, 0);
        expect(materialized).toBe(0);
        // The empty page and Account-wide key-unavailability fact are the only
        // two Discussion resource questions; inventory size adds no reads.
        expect(measured.reads.length).toBeLessThanOrEqual(2);
        const keys = tweetnacl.box.keyPair();
        await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        const envelope = sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes });
        await db.discussion.updateMany({ where: { ownerAccountId: owner.id }, data: { encryptionMode: 'e2ee', dataEncryptionKey: envelope,
            titleContent: { t: 'encrypted', c: 'AA==' } } });
        await db.discussionMessage.updateMany({ where: { discussion: { ownerAccountId: owner.id } }, data: { content: { t: 'encrypted', c: 'AA==' } } });
        const encrypted = await measure(() => readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }));
        expect(encrypted.result).toEqual(measured.result);
        const encryptedRows = encrypted.reads.filter(read => read.model === 'discussion' || read.model === 'discussionReadState')
            .reduce((sum, read) => sum + read.rows, 0);
        expect(encryptedRows).toBe(0);
        expect(encrypted.reads.length).toBeLessThanOrEqual(2);
    });

    it('B-S1 preserves global incomplete across the page cursor and rechecks repaired encrypted keys', async () => {
        const owner = await account();
        const keys = tweetnacl.box.keyPair();
        await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        const [discussionId] = await seedDiscussions(owner.id, 1);
        await db.discussion.update({ where: { id: discussionId }, data: { encryptionMode: 'e2ee', dataEncryptionKey: new Uint8Array([1]) } });
        expect(await readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }))
            .toEqual({ ok: true, value: { incomplete: true, discussions: [], nextCursor: null } });
        const envelope = sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes });
        await db.discussion.update({ where: { id: discussionId }, data: { dataEncryptionKey: envelope } });
        expect(await readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }))
            .toEqual({ ok: true, value: { incomplete: false, discussions: [], nextCursor: null } });
    });

    it('B-S1 keeps erased/Agent/JSON-null authors unread, excludes own humans, and pages exact current cursors', async () => {
        const owner = await account(), author = await account();
        const [discussionId, untracked] = await seedDiscussions(owner.id, 2);
        const ids = Array.from({ length: 6 }, () => randomUUID());
        await db.discussionMessage.createMany({ data: ids.map((id, index) => ({ id, discussionId, localId: id, seq: index + 1,
            authorAccountId: index === 1 ? author.id : index === 2 ? null : owner.id,
            requestEqualityEvidenceV1: evidence, content: body, createdAt: new Date(Date.UTC(2026, 9, 23, 11) + Math.floor(index / 2)),
            ...(index === 3 ? { producerV1: { v: 1, kind: 'agent', sessionId: randomUUID() } }
                : index === 4 ? { producerV1: storage.prismaRuntime.JsonNull } : {}),
        })) });
        await db.discussionMessageMention.create({ data: { messageId: ids[1], accountId: owner.id } });
        await db.discussionMessage.create({ data: { discussionId: untracked, localId: randomUUID(), seq: 1,
            authorAccountId: author.id, requestEqualityEvidenceV1: evidence, content: body, createdAt: new Date(2_000) } });
        await db.discussion.update({ where: { id: discussionId }, data: { messageSeq: 6 } });
        await db.discussionReadState.create({ data: { discussionId, accountId: owner.id, lastReadSeq: 0 } });
        const occurrences: Array<{ id: string; type: string }> = [];
        const expected = [1, 2, 3, 4].sort((a, b) => Math.floor(b / 2) - Math.floor(a / 2) || ids[b].localeCompare(ids[a]));
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        do {
            const result = await readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1, ...(cursor ? { cursor } : {}) });
            if (!result.ok) throw new Error(result.error);
            const page = result.value.discussions.flatMap(entry => entry.occurrences.map(occurrence => ({ id: occurrence.message.id, type: occurrence.type })));
            expect(page.map(row => row.id)).toEqual([ids[expected[occurrences.length]]]);
            occurrences.push(...page);
            cursor = result.value.nextCursor ?? undefined;
            if (cursor) {
                expect(seenCursors.has(cursor)).toBe(false);
                seenCursors.add(cursor);
            }
        } while (cursor);
        expect(occurrences).toEqual(expected.map(index => ({ id: ids[index], type: index === 1 ? 'mention' : 'update' })));
        expect(new Set(occurrences.map(row => row.id)).size).toBe(expected.length);
        const whole = await readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 100 });
        expect(whole).toMatchObject({ ok: true, value: { nextCursor: null } });
        if (!whole.ok) throw new Error(whole.error);
        expect(whole.value.discussions.flatMap(entry => entry.occurrences.map(row => row.message.id))).toEqual(expected.map(index => ids[index]));
        await db.discussionReadState.update({ where: { discussionId_accountId: { discussionId, accountId: owner.id } }, data: { lastReadSeq: 4 } });
        const after = await readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 });
        expect(after).toMatchObject({ ok: true, value: { nextCursor: null, discussions: [{ occurrences: [{ message: { id: ids[4] } }] }] } });
    });

    it('B-S1 rechecks a shared encrypted recipient binding, repaired envelope and revoked grant', async () => {
        const owner = await account(), viewer = await account();
        const ownerKeys = tweetnacl.box.keyPair(), viewerKeys = tweetnacl.box.keyPair();
        await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
        await db.account.update({ where: { id: viewer.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(viewerKeys.publicKey) } });
        const seal = (publicKey: Uint8Array) => sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes });
        const [discussionId] = await seedDiscussions(owner.id, 1);
        await db.discussion.update({ where: { id: discussionId }, data: { encryptionMode: 'e2ee', dataEncryptionKey: seal(ownerKeys.publicKey) } });
        await db.discussionAccountGrant.create({ data: { discussionId, accountId: viewer.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.discussionKeyEnvelope.create({ data: { discussionId, recipientAccountId: viewer.id,
            encryptedDataKey: seal(viewerKeys.publicKey), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(viewerKeys.publicKey) } });
        const read = () => readDiscussionAttention({ actorAccountId: viewer.id, authentication, limit: 1 });
        expect(await read()).toEqual({ ok: true, value: { incomplete: false, discussions: [], nextCursor: null } });
        const rotated = tweetnacl.box.keyPair();
        await db.account.update({ where: { id: viewer.id }, data: createSignedAccountContentBinding(rotated.publicKey) });
        expect(await read()).toEqual({ ok: true, value: { incomplete: true, discussions: [], nextCursor: null } });
        await db.discussionKeyEnvelope.update({ where: { discussionId_recipientAccountId: { discussionId, recipientAccountId: viewer.id } }, data: {
            encryptedDataKey: seal(rotated.publicKey), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(rotated.publicKey) } });
        expect(await read()).toEqual({ ok: true, value: { incomplete: false, discussions: [], nextCursor: null } });
        await db.discussionAccountGrant.delete({ where: { discussionId_accountId: { discussionId, accountId: viewer.id } } });
        await db.account.update({ where: { id: viewer.id }, data: createSignedAccountContentBinding(viewerKeys.publicKey) });
        expect(await read()).toEqual({ ok: true, value: { incomplete: false, discussions: [], nextCursor: null } });
    });

    it.each([1, 1_000, 20_000])('B-S2 selects one real Doc thread before N=%i unrelated rows leave storage', async count => {
        const owner = await account();
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Source', kind: 'markdown' })),
            body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Text' })),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const doc = { ref: { kind: 'doc' as const, serverId: 'test-home', artifactId: artifact.artifact.id },
            revision: { headerVersion: artifact.artifact.headerVersion, bodyVersion: artifact.artifact.bodyVersion } };
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: randomUUID(), anchor: { kind: 'doc', doc },
            titleContent: { t: 'plain', v: { v: 1, title: 'Scoped' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { kind: 'doc_passage_comment',
                passage: { ...doc, range: { start: 0, end: 4 }, quote: 'Text' }, content: body.v } },
                replyTarget: { kind: 'doc_passage', doc }, mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        await seedDiscussions(owner.id, count, { lastMessageAt: new Date(Date.now() + 1_000) });
        const measured = await measure(() => listDiscussions({ authentication, actorAccountId: owner.id,
            anchorDocArtifactId: doc.ref.artifactId, limit: 1 }));
        expect(measured.result).toMatchObject({ ok: true, value: { discussions: [{ id: created.value.discussion.id }], nextCursor: null } });
        const materialized = measured.reads.filter(read => read.model === 'discussion').reduce((sum, read) => sum + read.rows, 0);
        expect(materialized).toBe(2);
    });

    it('B-S2a keeps page-2 candidates reachable while a thousand foreign rows lie between reachable items', async () => {
        const owner = await account();
        const stranger = await account();
        const create = async (at: number) => {
            const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
                creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Reachable' } },
                firstMessage: { localId: randomUUID(), content: body, mentionedAccountIds: [] },
            } });
            if (!created.ok) throw new Error(created.error);
            await db.discussion.update({ where: { id: created.value.discussion.id }, data: { lastMessageAt: new Date(at) } });
            return created.value.discussion.id;
        };
        const first = await create(4_000);
        await seedDiscussions(stranger.id, 1_000, { lastMessageAt: new Date(3_000) });
        const second = await create(2_000);
        const third = await create(1_000);
        const page1 = await listDiscussions({ actorAccountId: owner.id, authentication, limit: 1 });
        if (!page1.ok || !page1.value.nextCursor) throw new Error('Missing first page');
        expect(page1.value.discussions.map(row => row.id)).toEqual([first]);
        const measured = await measure(() => listDiscussions({ actorAccountId: owner.id, authentication, limit: 1, cursor: page1.value.nextCursor! }));
        expect(measured.result).toMatchObject({ ok: true, value: { discussions: [{ id: second }], nextCursor: expect.any(String) } });
        const materialized = measured.reads.filter(read => read.model === 'discussion').reduce((sum, read) => sum + read.rows, 0);
        expect(materialized).toBe(4);
        if (!measured.result.ok || !measured.result.value.nextCursor) throw new Error('Missing second page');
        expect(await listDiscussions({ actorAccountId: owner.id, authentication, limit: 1, cursor: measured.result.value.nextCursor }))
            .toMatchObject({ ok: true, value: { discussions: [{ id: third }], nextCursor: null } });
    });

    it('pages every reachable Doc root and agrees with doc.read across timestamp ties', async () => {
        const owner = await account();
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Source', kind: 'markdown' })),
            body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Text' })),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const serverId = await getOrCreateServerIdentityId();
        const doc = { ref: { kind: 'doc' as const, serverId, artifactId: artifact.artifact.id },
            revision: { headerVersion: artifact.artifact.headerVersion, bodyVersion: artifact.artifact.bodyVersion } };
        const roots: Array<{ id: string; at: number }> = [];
        for (let index = 0; index < 8; index++) {
            const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
                creationLocalId: randomUUID(), anchor: { kind: 'doc', doc },
                titleContent: { t: 'plain', v: { v: 1, title: 'Scoped' } },
                firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { kind: 'doc_passage_comment',
                    passage: { ...doc, range: { start: 0, end: 4 }, quote: 'Text' }, content: body.v } },
                    replyTarget: { kind: 'doc_passage', doc }, mentionedAccountIds: [] },
            } });
            if (!created.ok) throw new Error(created.error);
            const at = Date.UTC(2026, 9, 23, 11) + Math.floor(index / 2);
            await db.discussion.update({ where: { id: created.value.discussion.id }, data: { lastMessageAt: new Date(at) } });
            roots.push({ id: created.value.discussion.id, at });
        }
        const expected = roots.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).map(row => row.id);
        const whole = await listDiscussions({ authentication, actorAccountId: owner.id, anchorDocArtifactId: doc.ref.artifactId, limit: 100 });
        if (!whole.ok) throw new Error(whole.error);
        expect(whole.value.discussions.map(row => row.id)).toEqual(expected);
        const walk: string[] = [], seenCursors = new Set<string>();
        let cursor: string | undefined;
        do {
            const page = await listDiscussions({ authentication, actorAccountId: owner.id, anchorDocArtifactId: doc.ref.artifactId,
                limit: 1, ...(cursor ? { cursor } : {}) });
            if (!page.ok) throw new Error(page.error);
            expect(page.value.discussions.map(row => row.id)).toEqual([expected[walk.length]]);
            walk.push(...page.value.discussions.map(row => row.id));
            cursor = page.value.nextCursor ?? undefined;
            if (cursor) { expect(seenCursors.has(cursor)).toBe(false); seenCursors.add(cursor); }
        } while (cursor);
        expect(walk).toEqual(expected);
        // Opened transport boundaries only; the real doc.read count owner calls
        // the real SQL/admission/projection path on every one-item page.
        const read = await executeDocReadV1({ ref: doc.ref },
            { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: owner.id }, {
                artifactAction: async () => ({ artifact: { artifactId: doc.ref.artifactId, ownerAccountId: owner.id,
                    access: 'admin', header: { title: 'Source', kind: 'markdown' }, body: 'Text', revision: doc.revision,
                    publicAudience: 'none', seq: 1, createdAt: 1, updatedAt: 1 } }),
                discussionAction: async ({ actionId, input }) => {
                    expect(actionId).toBe('discussion.list');
                    const query = DiscussionListInputV1Schema.parse(input);
                    const page = await listDiscussions({ authentication, actorAccountId: owner.id, ...query, limit: 1 });
                    if (!page.ok) throw new Error(page.error);
                    return { v: 1, serverId, ...page.value, incomplete: false,
                        discussions: page.value.discussions.map(({ titleContent, firstMessage, ...row }) => ({ ...row,
                            title: titleContent.t === 'plain' ? DiscussionTitleV1Schema.parse(titleContent.v).title : null,
                            firstMessage: firstMessage ? { ...firstMessage,
                                messageRef: createDiscussionMessageRefV1({ serverId, discussionId: row.id }, firstMessage),
                                content: firstMessage.content.t === 'plain' ? firstMessage.content.v : null } : null,
                        })) };
                },
            });
        expect(read).toMatchObject({ ok: true, result: { openCommentCount: expected.length } });
        expect(walk).toHaveLength(new Set(walk).size);
    });

    it.each([1, 100, 1_000])('B-S3 resolves depth=%i in one set read without fetching unrelated history', async depth => {
        const owner = await account();
        const [discussionId] = await seedDiscussions(owner.id, 1);
        const ids = Array.from({ length: depth + 1 }, () => randomUUID());
        await db.discussionMessage.createMany({ data: ids.map((id, index) => ({ id, discussionId, localId: id, seq: index + 1,
            requestEqualityEvidenceV1: evidence, content: body,
            ...(index ? { replyTargetV1: { kind: 'message', messageId: ids[index - 1] } } : {}),
        })) });
        await db.discussionMessage.createMany({ data: Array.from({ length: 1_000 }, (_, index) => ({ discussionId,
            localId: randomUUID(), seq: depth + index + 2, requestEqualityEvidenceV1: evidence, content: body })) });
        const measured = await measure(() => inReadSnapshot(tx => resolveDiscussionDocSourcesInTx(tx, { discussionId,
            messages: [{ id: ids[depth], replyTargetV1: { kind: 'message', messageId: ids[depth - 1] } }] })));
        expect(measured.result).toEqual({ ok: true, value: new Map([[ids[depth], null]]) });
        const reads = measured.reads.filter(read => read.model === 'ancestors');
        expect(reads).toHaveLength(1);
        expect(reads[0].rows).toBe(depth);
    });

    it('B-S3 rejects cycles, missing ancestors and ancestors from another Discussion', async () => {
        const owner = await account();
        const [discussionId, otherId] = await seedDiscussions(owner.id, 2);
        const root = randomUUID(), leaf = randomUUID();
        await db.discussionMessage.createMany({ data: [
            { id: root, discussionId, localId: root, seq: 1, requestEqualityEvidenceV1: evidence, content: body,
                replyTargetV1: { kind: 'message', messageId: leaf } },
            { id: leaf, discussionId, localId: leaf, seq: 2, requestEqualityEvidenceV1: evidence, content: body,
                replyTargetV1: { kind: 'message', messageId: root } },
        ] });
        const read = () => inReadSnapshot(tx => resolveDiscussionDocSourcesInTx(tx, { discussionId,
            messages: [{ id: leaf, replyTargetV1: { kind: 'message', messageId: root } }] }));
        expect(await read()).toEqual({ ok: false, error: 'discussion_invalid_reply_target' });
        await db.discussionMessage.update({ where: { id: root }, data: { discussionId: otherId } });
        expect(await read()).toEqual({ ok: false, error: 'discussion_invalid_reply_target' });
        await db.discussionMessage.delete({ where: { id: root } });
        expect(await read()).toEqual({ ok: false, error: 'discussion_invalid_reply_target' });
    });

    it('B-S1 preserves unread/self-send/cursor semantics and B-S3 attention consumes its admitted source map', async () => {
        const owner = await account();
        const [discussionId] = await seedDiscussions(owner.id, 1);
        const ids = Array.from({ length: 101 }, () => randomUUID());
        await db.discussionMessage.createMany({ data: ids.map((id, index) => ({ id, discussionId, localId: id, seq: index + 1,
            authorAccountId: index === 100 ? null : owner.id, createdAt: new Date(1_000 + index),
            requestEqualityEvidenceV1: evidence, content: body,
            ...(index ? { replyTargetV1: { kind: 'message', messageId: ids[index - 1] } } : {}),
        })) });
        await db.discussion.update({ where: { id: discussionId }, data: { messageSeq: 101, lastMessageAt: new Date(1_100) } });
        await db.discussionReadState.create({ data: { discussionId, accountId: owner.id, lastReadSeq: 0 } });
        const measured = await measure(() => readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }));
        expect(measured.result).toMatchObject({ ok: true, value: { incomplete: false, nextCursor: null,
            discussions: [{ discussion: { id: discussionId }, occurrences: [{ message: { id: ids[100] }, type: 'update' }] }] } });
        // The summary's latest row and the selected occurrence each resolve once;
        // attention must reuse the occurrence projection's source map for decisions.
        const ancestors = measured.reads.filter(read => read.model === 'ancestors');
        expect(ancestors).toHaveLength(2);
        await db.discussionReadState.delete({ where: { discussionId_accountId: { discussionId, accountId: owner.id } } });
        expect(await readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }))
            .toEqual({ ok: true, value: { incomplete: false, nextCursor: null, discussions: [] } });
    });
}
