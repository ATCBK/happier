import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerAccountProfileRoute } from './registerAccountProfileRoute';
import { registerAccountUsernameRoute } from './registerAccountUsernameRoute';
import { inTx } from '@/storage/inTx';
import { linkIdentityInTx } from '@/app/auth/providers/accountIdentityLifecycle';
import { eventRouter } from '@/app/events/eventRouter';

const boundary = vi.hoisted(() => {
    const account = { id: 'self', name: null as string | null, firstName: null as string | null, lastName: null as string | null,
        username: 'leeroybrun', avatar: null, seq: 0 };
    const tx = {
        account: {
            findUnique: vi.fn(async () => ({ ...account })),
            findUniqueOrThrow: vi.fn(async () => ({ ...account })),
            findMany: vi.fn(async () => [{ ...account }]),
            findFirst: vi.fn(async () => null),
            update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                if (where.id !== account.id) throw new Error('wrong-account');
                Object.assign(account, data);
                return { ...account };
            }),
        },
        accountIdentity: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({})) },
        teamMembership: { findMany: vi.fn(async () => []) },
        homeIdentityConnection: { findMany: vi.fn(async () => []) },
        teamIdentityConnection: { findMany: vi.fn(async () => []) },
        homeSettings: { findUnique: vi.fn(async () => null) },
        homeGovernancePolicy: { findUnique: vi.fn(async () => null) },
        $queryRawUnsafe: vi.fn(async () => [{ cursor: ++account.seq }]),
    };
    return { account, tx, committed: false };
});

// Prisma is the persistence boundary; transaction lifecycle and profile/identity logic remain real.
vi.mock('@/storage/db', () => ({ db: { ...boundary.tx, $transaction: async (run: (tx: typeof boundary.tx) => Promise<unknown>) => {
    const result = await run(boundary.tx);
    boundary.committed = true;
    return result;
} } }));

describe('self Account name', () => {
    afterEach(() => vi.unstubAllEnvs());
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.stubEnv('HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED', '0');
        Object.assign(boundary.account, { name: null, firstName: null, lastName: null, seq: 0 });
        boundary.committed = false;
    });

    it('sets, trims and clears the caller name without Friends and publishes after commit', async () => {
        const emitted: unknown[] = [];
        vi.spyOn(eventRouter, 'emitUpdate').mockImplementation((update) => {
            expect(boundary.committed).toBe(true);
            emitted.push(update);
        });
        const app = createAuthenticatedTestApp();
        registerAccountProfileRoute(app);
        registerAccountUsernameRoute(app);
        try {
            const post = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/account/profile', headers: { 'x-test-user-id': 'self' }, payload });
            const response = await post({ name: '  Leeroy Brun  ' });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ name: 'Leeroy Brun', firstName: 'Leeroy Brun', lastName: null });
            expect(boundary.account.name).toBe('Leeroy Brun');
            expect(emitted).toContainEqual(expect.objectContaining({ userId: 'self', payload: expect.objectContaining({
                body: expect.objectContaining({ t: 'update-account', name: 'Leeroy Brun', firstName: 'Leeroy Brun', lastName: null }),
            }) }));
            expect((await post({ name: 'Other', accountId: 'other' })).statusCode).toBe(400);
            expect(boundary.account.name).toBe('Leeroy Brun');
            const cleared = await post({ name: '  ' });
            expect(cleared.json()).toMatchObject({ name: null, firstName: null, lastName: null });
            expect(boundary.account.name).toBeNull();
            const username = await app.inject({ method: 'POST', url: '/v1/account/username', headers: { 'x-test-user-id': 'self' }, payload: { username: 'othername' } });
            expect(username.statusCode).toBe(400);
            expect(username.json()).toEqual({ error: 'friends-disabled' });
        } finally { await app.close(); }
    });

    it('fills an empty name from identity presentation but never overwrites a self-set name', async () => {
        vi.spyOn(eventRouter, 'emitUpdate').mockImplementation(() => {});
        const intent = { accountId: 'self', provider: 'mtls', providerUserId: 'subject', providerLogin: null, profile: {},
            presentation: { name: '  Provider Full Name  ', username: null } };
        await inTx(tx => linkIdentityInTx(tx, intent));
        expect(boundary.account.name).toBe('Provider Full Name');
        boundary.account.name = 'Captain';
        await inTx(tx => linkIdentityInTx(tx, intent));
        expect(boundary.account.name).toBe('Captain');
    });
});
