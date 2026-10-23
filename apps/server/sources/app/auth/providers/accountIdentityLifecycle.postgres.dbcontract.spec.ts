import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { acquireAccountSessionOwnerMetadataFenceInTx } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { preparePlainAccountPasswordCredentialV1 } from '@/app/auth/password/accountPasswordCredentialPreparation';
import { buildLinkedIdentityManagementProjectionInTx } from './accountLinkedIdentityManagement';
import { prepareIdentityLink, refreshIdentity, unlinkIdentity } from './accountIdentityLifecycle';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Identity refresh Account contention', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '1');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    async function withBlockedIdentityMutation(
        mutate: () => Promise<void>,
        write: (tx: Tx) => Promise<void>,
    ) {
        const held = deferred(), release = deferred();
        let peerPid = 0;
        const writing = inTx(async tx => {
            await write(tx);
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            peerPid = pid;
            held.resolve();
            await release.promise;
        });
        await held.promise;
        const refreshing = mutate();
        // Observe the real database lock wait, without replacing transaction or domain logic.
        const outcome = refreshing.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
        try {
            await expect.poll(async () => {
                const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                        AND ${peerPid} = ANY(pg_blocking_pids(pid))) AS blocked
                `;
                return blocked;
            }).toBe(true);
        } finally {
            release.resolve();
            await writing;
        }
        expect(await outcome).toEqual({ ok: true });
    }

    it('refreshes and publishes after a concurrent Account cursor advance commits', async () => {
        const account = await db.account.create({ data: { publicKey: `identity-refresh-${randomUUID()}`, encryptionMode: 'plain' } });
        try {
            await inTx((await prepareIdentityLink({ accountId: account.id, provider: 'mtls',
                providerUserId: randomUUID(), providerLogin: 'initial', profile: {} })).connectInTx);
            const identity = await db.accountIdentity.findFirstOrThrow({ where: { accountId: account.id } });
            const before = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            await withBlockedIdentityMutation(() => refreshIdentity({ accountId: account.id,
                identityId: identity.id, provider: 'mtls', data: { providerLogin: 'refreshed', eligibilityStatus: 'ineligible' } }), async tx => {
                // The genuine persistence boundary reproduces the Account row
                // version changed by cursor allocation while admission is waiting.
                await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            });
            expect(await db.accountIdentity.findUniqueOrThrow({ where: { id: identity.id } }))
                .toMatchObject({ providerLogin: 'refreshed', eligibilityStatus: 'ineligible' });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: before.seq + 2 });
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it('does not refresh or publish for an identity replaced while Account admission waits', async () => {
        const account = await db.account.create({ data: { publicKey: `identity-refresh-${randomUUID()}`, encryptionMode: 'plain' } });
        try {
            await inTx((await prepareIdentityLink({ accountId: account.id, provider: 'mtls',
                providerUserId: randomUUID(), providerLogin: 'initial', profile: {} })).connectInTx);
            const previous = await db.accountIdentity.findFirstOrThrow({ where: { accountId: account.id } });
            const replacement = await prepareIdentityLink({ accountId: account.id, provider: 'mtls',
                providerUserId: randomUUID(), providerLogin: 'replacement', profile: {},
                eligibility: { eligibilityStatus: 'eligible', eligibilityReason: null,
                    eligibilityCheckedAt: new Date(), eligibilityNextCheckAt: null } });
            const before = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            await withBlockedIdentityMutation(() => refreshIdentity({ accountId: account.id,
                identityId: previous.id, provider: 'mtls', data: { providerLogin: 'refreshed', eligibilityStatus: 'ineligible' } }), async tx => {
                await replacement.connectInTx(tx);
            });
            expect(await db.accountIdentity.findFirstOrThrow({ where: { accountId: account.id } }))
                .toMatchObject({ providerLogin: 'replacement', eligibilityStatus: 'eligible' });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: before.seq + 1 });
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it('rereads last-login viability after another credential is removed during Account admission', async () => {
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', undefined);
        vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '0');
        vi.stubEnv('HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE', 'plain');
        vi.stubEnv('HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS', 'github');
        vi.stubEnv('GITHUB_CLIENT_ID', 'identity-login-contract');
        vi.stubEnv('GITHUB_CLIENT_SECRET', 'identity-login-contract');
        vi.stubEnv('GITHUB_REDIRECT_URL', 'https://home.example.test/v1/oauth/github/callback');
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        try {
            await db.accountIdentity.createMany({ data: [
                { accountId: account.id, provider: 'github', providerUserId: randomUUID(), profile: {} },
                { accountId: account.id, provider: 'email', providerUserId: `${randomUUID()}@identity.example.test`, profile: {} },
            ] });
            const prepared = await preparePlainAccountPasswordCredentialV1('valid alternative login password');
            if (!prepared.ok) throw new Error('Password fixture preparation failed');
            await db.accountPasswordCredential.create({ data: { accountId: account.id, credential: prepared.credential } });
            expect(await inTx(tx => buildLinkedIdentityManagementProjectionInTx(tx, { accountId: account.id, env: process.env })))
                .toEqual(expect.arrayContaining([expect.objectContaining({ providerId: 'github', canDisconnect: true })]));
            await withBlockedIdentityMutation(async () => {
                await expect(unlinkIdentity({ accountId: account.id, provider: 'github' }))
                    .rejects.toMatchObject({ reason: 'last_login_method' });
            }, async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, 'exclusive');
                await tx.accountPasswordCredential.delete({ where: { accountId: account.id } });
                await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            });
            expect(await db.accountIdentity.count({ where: { accountId: account.id, provider: 'github' } })).toBe(1);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 1 });
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });
});
