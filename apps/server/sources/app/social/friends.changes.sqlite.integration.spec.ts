import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Context } from '@/context';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { friendAdd } from './friendAdd';
import { friendRemove } from './friendRemove';

describe('Friend relationship and AccountChange publication (SQLite integration)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-acct-friends-', env: {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '1',
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: '1',
        } });
    }, 180_000);
    afterEach(async () => { await db.account.deleteMany(); });
    afterAll(async () => { if (harness) await harness.close(); });

    async function accounts() {
        const stem = randomUUID();
        return Promise.all(['a', 'z'].map(suffix => db.account.create({ data: {
            id: `${stem}-${suffix}`, publicKey: `acct-friends-${stem}-${suffix}`, username: `acct-${stem}-${suffix}`,
        } })));
    }

    async function friendChanges(accountIds: string[]) {
        const changes = await db.accountChange.findMany({ where: { kind: 'friends', entityId: 'self' },
            orderBy: { accountId: 'asc' }, select: { accountId: true, cursor: true } });
        expect(changes.map(change => change.accountId)).toEqual([...accountIds].sort());
        for (const change of changes) {
            expect(change.cursor).toBeGreaterThan(0);
            expect((await db.account.findUniqueOrThrow({ where: { id: change.accountId }, select: { seq: true } })).seq)
                .toBe(change.cursor);
        }
        return changes;
    }

    it('publishes both sides of request and acceptance through the real notification and cursor owners', async () => {
        const [first, second] = await accounts();
        await db.accountIdentity.create({ data: {
            accountId: first.id,
            provider: 'github',
            providerUserId: first.id,
            providerLogin: 'acct-friend',
            profile: { login: 'acct-friend' },
            showOnProfile: true,
        } });
        // Reverse caller order relative to the Account ids. Notifications also
        // allocate feed cursors before the bilateral friends projection.
        expect(await friendAdd(Context.create(second.id), first.id)).toMatchObject({
            id: first.id,
            status: 'requested',
            badges: [{ id: 'github', label: '@acct-friend', url: 'https://github.com/acct-friend' }],
        });
        const requested = await friendChanges([first.id, second.id]);
        expect(await db.userFeedItem.findMany({ select: { userId: true, body: true } })).toEqual([
            { userId: first.id, body: { kind: 'friend_request', uid: second.id } },
        ]);
        const requestFeedChange = await db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: first.id, kind: 'feed', entityId: 'self' },
        } });
        expect(requestFeedChange.cursor).toBeLessThan(requested[0].cursor);
        expect(await db.userRelationship.findMany({ orderBy: { fromUserId: 'asc' },
            select: { fromUserId: true, toUserId: true, status: true } })).toEqual([
            { fromUserId: first.id, toUserId: second.id, status: 'pending' },
            { fromUserId: second.id, toUserId: first.id, status: 'requested' },
        ]);
        expect(await friendAdd(Context.create(second.id), first.id)).toMatchObject({ id: first.id, status: 'requested' });
        expect(await friendChanges([first.id, second.id])).toEqual(requested);
        expect(await db.userFeedItem.count()).toBe(1);
        expect(await friendAdd(Context.create(first.id), second.id)).toMatchObject({ id: second.id, status: 'friend' });
        const accepted = await friendChanges([first.id, second.id]);
        expect(accepted.every((change, index) => change.cursor > requested[index].cursor)).toBe(true);
        // The requester receives acceptance; the receiver's request notification
        // is still inside the existing notification cooldown.
        expect(await db.userFeedItem.findMany({ orderBy: { userId: 'asc' },
            select: { userId: true, body: true } })).toEqual([
            { userId: first.id, body: { kind: 'friend_request', uid: second.id } },
            { userId: second.id, body: { kind: 'friend_accepted', uid: first.id } },
        ]);
        const acceptanceFeedChange = await db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: second.id, kind: 'feed', entityId: 'self' },
        } });
        expect(acceptanceFeedChange.cursor).toBeLessThan(accepted[1].cursor);
        expect(await db.userRelationship.findMany({ select: { status: true } })).toEqual([
            { status: 'friend' }, { status: 'friend' },
        ]);
    });

    it('publishes request rejection only to the acting Account', async () => {
        const [first, second] = await accounts();
        await db.userRelationship.createMany({ data: [
            { fromUserId: first.id, toUserId: second.id, status: 'requested' },
            { fromUserId: second.id, toUserId: first.id, status: 'pending' },
        ] });
        expect(await friendRemove(Context.create(first.id), second.id)).toMatchObject({ id: second.id, status: 'rejected' });
        await friendChanges([first.id]);
        expect(await db.userRelationship.findMany({ orderBy: { fromUserId: 'asc' }, select: { status: true } }))
            .toEqual([{ status: 'rejected' }, { status: 'pending' }]);
    });

    it('clears friendship and publishes both Accounts when the higher-id Account removes it', async () => {
        const [first, second] = await accounts();
        await db.userRelationship.createMany({ data: [
            { fromUserId: first.id, toUserId: second.id, status: 'friend' },
            { fromUserId: second.id, toUserId: first.id, status: 'friend' },
        ] });
        expect(await friendRemove(Context.create(second.id), first.id)).toMatchObject({ id: first.id, status: 'none' });
        await friendChanges([first.id, second.id]);
        expect(await db.userRelationship.findMany({ select: { status: true } })).toEqual([
            { status: 'none' }, { status: 'none' },
        ]);
    });
});
