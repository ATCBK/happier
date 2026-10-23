import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { acquireAccountSessionOwnerMetadataFenceInTx } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { deleteAccountHomeDirectoryEntry, listAccountHomeDirectory, setPreferredAccountHome,
    upsertAccountHomeDirectoryEntry, ensureSameServiceHomeEntryInTx, prepareSameServiceHomeEntry,
    upsertAccountDirectoryLink, deleteAccountDirectoryLink } from './accountDirectoryService';

function latch() {
    let release!: () => void;
    return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

/** Pause before the first Account admission statement, so the peer commits before the reader owns its fence. */
function pauseFirstDirectoryAdmission() {
    const captured = latch(), release = latch();
    const transaction = db.$transaction;
    let paused = false;
    db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
            if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
            return async (query: string, ...values: unknown[]) => {
                if (!paused && query.includes('FROM "Account"') && query.includes('FOR ')) {
                    paused = true;
                    captured.release();
                    await release.promise;
                }
                return inner.$queryRawUnsafe(query, ...values);
            };
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
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    async function behindAccountWriter<T>(accountId: string, write: (tx: Tx) => Promise<void>, mutate: () => Promise<T>): Promise<T> {
        const held = latch(), release = latch();
        let peerPid = 0;
        const writer = inTx(async tx => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId, 'exclusive');
            await tx.account.update({ where: { id: accountId }, data: { seq: { increment: 1 } } });
            await write(tx);
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            peerPid = pid;
            held.release();
            await release.promise;
        });
        await held.promise;
        const operation = mutate();
        const settled = Promise.allSettled([operation]);
        try {
            await expect.poll(async () => {
                const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                        AND ${peerPid} = ANY(pg_blocking_pids(pid))) AS blocked
                `;
                return blocked;
            }).toBe(true);
        } finally { release.release(); await writer; }
        await settled;
        return operation;
    }

    it.each(['upsert', 'delete', 'preferred'] as const)('preserves Home state behind a concurrent Account advance (%s)', async operation => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const homeServerIdentityId = `srv_${randomUUID()}`;
        const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId,
            canonicalServerUrl: 'https://directory-contention.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://directory-contention.test' }] });
        await db.accountHomeDirectoryEntry.create({ data: { accountId: account.id, homeServerIdentityId,
            label: 'Revision 1', canonicalServerUrl: descriptor.canonicalServerUrl, connectionDescriptor: descriptor } });
        try {
            const mutate = async () => {
                if (operation === 'upsert') await upsertAccountHomeDirectoryEntry({ accountId: account.id, homeServerIdentityId,
                    label: 'Revision 2', connectionDescriptor: { ...descriptor, revision: 2 } });
                else if (operation === 'delete') await deleteAccountHomeDirectoryEntry({ accountId: account.id, homeServerIdentityId });
                else await setPreferredAccountHome({ accountId: account.id, homeServerIdentityId });
            };
            await behindAccountWriter(account.id, async () => {}, mutate);
            const current = await listAccountHomeDirectory(account.id);
            if (operation === 'delete') expect(current).toMatchObject({ preferredHomeServerIdentityId: null, homes: [] });
            else if (operation === 'preferred') expect(current.preferredHomeServerIdentityId).toBe(homeServerIdentityId);
            else expect(current.homes).toMatchObject([{ label: 'Revision 2', connectionDescriptor: { revision: 2 } }]);
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it('keeps a newer descriptor when same-service bootstrap waits for current Account admission', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const homeServerIdentityId = `srv_${randomUUID()}`;
        const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId,
            canonicalServerUrl: 'https://same-service-contention.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://same-service-contention.test' }] });
        const env = { HAPPIER_SERVER_IDENTITY_ID: homeServerIdentityId, HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'self',
            HAPPIER_CANONICAL_SERVER_URL: descriptor.canonicalServerUrl, HANDY_MASTER_SECRET: 'directory-contract' };
        const preparation = await prepareSameServiceHomeEntry({ env,
            resolveHomeConnectionDescriptor: async () => ({ ...descriptor, revision: 2 }) });
        try {
            if (preparation.status !== 'ready') throw new Error('Same-service fixture unavailable: ' + preparation.status);
            await db.accountHomeDirectoryEntry.create({ data: { accountId: account.id, homeServerIdentityId,
                label: 'Revision 1', canonicalServerUrl: descriptor.canonicalServerUrl, connectionDescriptor: descriptor } });
            await db.accountDirectoryLink.create({ data: { accountId: account.id, issuerServerIdentityId: homeServerIdentityId,
                issuerSubjectId: account.id, issuerSigningKeyId: preparation.signingKeyId,
                issuerSigningPublicKey: preparation.signingPublicKey } });
            await behindAccountWriter(account.id, async tx => {
                await tx.accountHomeDirectoryEntry.update({
                    where: { accountId_homeServerIdentityId: { accountId: account.id, homeServerIdentityId } },
                    data: { label: 'Revision 3', connectionDescriptor: { ...descriptor, revision: 3 } },
                });
            }, () => inTx(tx => ensureSameServiceHomeEntryInTx(tx, { accountId: account.id, preparation, env })));
            expect((await listAccountHomeDirectory(account.id)).homes).toMatchObject([
                { label: 'Revision 3', connectionDescriptor: { revision: 3 } },
            ]);
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it.each(['relink', 'delete'] as const)('uses the issuer binding committed while Account admission waits (%s)', async operation => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const issuerServerIdentityId = `srv_${randomUUID()}`;
        const initial = tweetnacl.sign.keyPair();
        const replacement = tweetnacl.sign.keyPair();
        const digest = (key: Uint8Array) => createHash('sha256').update(key).digest('hex');
        const initialId = digest(initial.publicKey), replacementId = digest(replacement.publicKey);
        await db.accountDirectoryLink.create({ data: { accountId: account.id, issuerServerIdentityId,
            issuerSubjectId: 'initial', issuerSigningKeyId: initialId, issuerSigningPublicKey: new Uint8Array(initial.publicKey) } });
        try {
            await behindAccountWriter(account.id, async tx => {
                await tx.accountDirectoryLink.update({ where: { accountId_issuerServerIdentityId: { accountId: account.id, issuerServerIdentityId } },
                    data: { issuerSubjectId: 'intervening', issuerSigningKeyId: replacementId, issuerSigningPublicKey: new Uint8Array(replacement.publicKey) } });
            }, () => operation === 'delete'
                ? deleteAccountDirectoryLink({ accountId: account.id, issuerServerIdentityId })
                : upsertAccountDirectoryLink({ accountId: account.id, issuerServerIdentityId, issuerSubjectId: 'final',
                    issuerSigningKeyId: initialId, issuerSigningPublicKeyBase64Url: Buffer.from(initial.publicKey).toString('base64url'), relink: true }));
            const current = await db.accountDirectoryLink.findUnique({ where: { accountId_issuerServerIdentityId: { accountId: account.id, issuerServerIdentityId } } });
            if (operation === 'delete') expect(current).toBeNull();
            else expect(current).toMatchObject({ issuerSubjectId: 'final', issuerSigningKeyId: initialId });
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it('replays a revision-2 write after revision 3 commits instead of regressing the descriptor', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const homeServerIdentityId = `srv_${randomUUID()}`;
        const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId,
            canonicalServerUrl: 'https://directory-race.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://directory-race.test' }] });
        await db.accountHomeDirectoryEntry.create({ data: { accountId: account.id, homeServerIdentityId,
            label: 'Revision 1', canonicalServerUrl: descriptor.canonicalServerUrl, connectionDescriptor: descriptor } });
        const boundary = pauseFirstDirectoryAdmission();
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
        const boundary = pauseFirstDirectoryAdmission();
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
