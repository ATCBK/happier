import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { deleteAccountHomeDirectoryEntry, listAccountHomeDirectory, setPreferredAccountHome,
    upsertAccountHomeDirectoryEntry } from './accountDirectoryService';

function latch() {
    let release!: () => void;
    return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

/** Pause only the first real directory read; all later attempts and peer writes run normally. */
function pauseFirstDirectoryRead() {
    const captured = latch(), release = latch();
    const transaction = db.$transaction;
    let paused = false;
    db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
            if (property !== 'accountHomeDirectoryEntry') return Reflect.get(inner, property, innerReceiver);
            return new Proxy(inner.accountHomeDirectoryEntry, { get(model, method, modelReceiver) {
                if (method !== 'findUnique') return Reflect.get(model, method, modelReceiver);
                return async (...queryArgs: unknown[]) => {
                    const row: unknown = await Reflect.apply(model.findUnique, model, queryArgs);
                    if (!paused) {
                        paused = true;
                        captured.release();
                        await release.promise;
                    }
                    return row;
                };
            } });
        } })), ...args.slice(1)]);
    } });
    return { captured: captured.promise, release: release.release,
        restore: () => { db.$transaction = transaction; } };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Home directory concurrent predicates', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable native PostgreSQL harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('replays a revision-2 write after revision 3 commits instead of regressing the descriptor', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const homeServerIdentityId = `srv_${randomUUID()}`;
        const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId,
            canonicalServerUrl: 'https://directory-race.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://directory-race.test' }] });
        await db.accountHomeDirectoryEntry.create({ data: { accountId: account.id, homeServerIdentityId,
            label: 'Revision 1', canonicalServerUrl: descriptor.canonicalServerUrl, connectionDescriptor: descriptor } });
        const boundary = pauseFirstDirectoryRead();
        const first = upsertAccountHomeDirectoryEntry({ accountId: account.id, homeServerIdentityId,
            label: 'Revision 2', connectionDescriptor: { ...descriptor, revision: 2 } });
        const outcome = Promise.allSettled([first]);
        try {
            await Promise.race([boundary.captured, first.then(() => { throw new Error('No directory read'); })]);
            const peer = await upsertAccountHomeDirectoryEntry({ accountId: account.id, homeServerIdentityId,
                label: 'Revision 3', connectionDescriptor: { ...descriptor, revision: 3 } });
            expect(peer.connectionDescriptor.revision).toBe(3);
            boundary.release();
            expect(await first).toMatchObject({ label: 'Revision 3', connectionDescriptor: { revision: 3 } });
            expect((await listAccountHomeDirectory(account.id)).homes).toMatchObject([
                { label: 'Revision 3', connectionDescriptor: { revision: 3 } },
            ]);
        } finally {
            boundary.release();
            await outcome;
            boundary.restore();
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('rechecks preferred-Home existence when deletion commits after the setter read', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const homeServerIdentityId = `srv_${randomUUID()}`;
        const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId,
            canonicalServerUrl: 'https://preferred-race.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://preferred-race.test' }] });
        await db.accountHomeDirectoryEntry.create({ data: { accountId: account.id, homeServerIdentityId,
            label: 'Removed Home', canonicalServerUrl: descriptor.canonicalServerUrl, connectionDescriptor: descriptor } });
        const boundary = pauseFirstDirectoryRead();
        const first = setPreferredAccountHome({ accountId: account.id, homeServerIdentityId });
        const outcome = Promise.allSettled([first]);
        try {
            await Promise.race([boundary.captured, first.then(() => { throw new Error('No preferred-Home read'); })]);
            await deleteAccountHomeDirectoryEntry({ accountId: account.id, homeServerIdentityId });
            boundary.release();
            await expect(first).rejects.toMatchObject({ code: 'preferred_home_not_found' });
            expect(await listAccountHomeDirectory(account.id)).toMatchObject({ preferredHomeServerIdentityId: null, homes: [] });
        } finally {
            boundary.release();
            await outcome;
            boundary.restore();
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
