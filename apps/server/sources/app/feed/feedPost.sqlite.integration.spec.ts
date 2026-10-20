import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Context } from '@/context';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

import { feedPost } from './feedPost';

describe('Feed terminal publication (SQLite integration)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-feed-publication-', initAuth: false });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('allocates the feed counter and item with terminal Account publication', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await inTx(async tx => {
            await feedPost(tx, Context.create(account.id), { kind: 'friend_request', uid: 'sender' }, 'request');
            // The remaining domain work must not run beneath an Account counter lock.
            expect((await tx.account.findUniqueOrThrow({ where: { id: account.id } })).feedSeq).toBe(0n);
            expect(await tx.userFeedItem.count({ where: { userId: account.id } })).toBe(0);
        });
        const item = await db.userFeedItem.findFirstOrThrow({ where: { userId: account.id } });
        const change = await db.accountChange.findFirstOrThrow({ where: { accountId: account.id, kind: 'feed', entityId: 'self' } });
        expect(item.counter).toBe(1n);
        expect(change.hint).toEqual({ cursor: '0-1' });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(change.cursor);
    });

    it('rolls back a queued replacement together with the enclosing domain mutation', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await inTx(tx => feedPost(tx, Context.create(account.id), { kind: 'friend_request', uid: 'sender' }, 'request'));
        const before = await db.userFeedItem.findFirstOrThrow({ where: { userId: account.id } });
        await expect(inTx(async tx => {
            await feedPost(tx, Context.create(account.id), { kind: 'friend_accepted', uid: 'sender' }, 'request');
            throw new Error('abort-domain');
        })).rejects.toThrow('abort-domain');
        expect(await db.userFeedItem.findMany({ where: { userId: account.id } })).toEqual([before]);
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).feedSeq).toBe(1n);
    });
});
