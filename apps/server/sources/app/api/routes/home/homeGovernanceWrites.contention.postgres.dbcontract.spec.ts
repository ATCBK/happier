import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HomeAccountRowV1Schema } from '@happier-dev/protocol/home/governance';

import { auth } from '@/app/auth/auth';
import { homeDomainActionPathForMethod } from '@/app/api/routes/actions/homeDomainActionRoute';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { initEncrypt } from '@/modules/encrypt';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { acrossAccountCursorCommit } from '@/testkit/postgresAccountCursorContention';

import { homeGovernanceRoutes } from './homeGovernanceRoutes';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Home governance writes across Account cursor commits', () => {
    const accountIds: string[] = [];
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    let connected = false;

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error('Use the disposable PostgreSQL DB-contract harness');
        vi.stubEnv('HANDY_MASTER_SECRET', 'home-governance-contention-test-secret');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        initDbPostgres();
        await db.$connect();
        connected = true;
        await auth.init();
        await initEncrypt();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        homeGovernanceRoutes(app);
        await app.ready();
    });

    afterEach(async () => {
        if (connected) await db.account.deleteMany({ where: { id: { in: accountIds } } });
        accountIds.length = 0;
    });
    afterAll(async () => {
        await app.close();
        if (connected) await db.$disconnect();
        vi.unstubAllEnvs();
    });

    async function account(homeRole: 'owner' | 'member') {
        const row = await db.account.create({ data: { publicKey: `home-contention-${randomUUID()}`, encryptionMode: 'plain', homeRole } });
        accountIds.push(row.id);
        const token = await auth.createToken(row.id, undefined, { kind: 'account', authority: 'present_user',
            authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
        return { ...row, token };
    }

    function post(action: 'home.accounts.role.set' | 'home.accounts.disable' | 'home.accounts.enable', token: string, payload: Record<string, unknown>) {
        return app.inject({ method: 'POST', url: homeDomainActionPathForMethod(action, 'POST'),
            headers: { authorization: `Bearer ${token}` }, payload });
    }

    it.each(['role', 'disable', 'enable'] as const)('commits %s with its current authority and lifecycle effects', async operation => {
        const actor = await account('owner');
        const target = await account('member');
        if (operation === 'enable') await db.account.update({ where: { id: target.id }, data: { status: 'suspended' } });
        const response = await acrossAccountCursorCommit(actor.id, async () => await post(
            operation === 'role' ? 'home.accounts.role.set' : operation === 'disable' ? 'home.accounts.disable' : 'home.accounts.enable',
            actor.token, { accountId: target.id, ...(operation === 'role' ? { homeRole: 'admin' } : {}) },
        ));
        expect(response.statusCode, response.body).toBe(200);
        expect(HomeAccountRowV1Schema.safeParse(response.json()).success).toBe(true);
        expect(await db.account.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
            homeRole: operation === 'role' ? 'admin' : 'member',
            status: operation === 'disable' ? 'suspended' : 'active',
            seq: target.seq + 1,
            tokenEpoch: operation === 'disable' ? target.tokenEpoch + 1 : target.tokenEpoch,
        });
        if (operation === 'disable') expect(await auth.verifyToken(target.token)).toBeNull();
    });

    it.each(['role', 'disable'] as const)('preserves an active owner when two owners concurrently remove themselves via %s', async operation => {
        const first = await account('owner');
        const second = await account('owner');
        const action = operation === 'role' ? 'home.accounts.role.set' : 'home.accounts.disable';
        const responses = await Promise.all([first, second].map(owner => post(action, owner.token,
            { accountId: owner.id, ...(operation === 'role' ? { homeRole: 'member' } : {}) })));
        expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
        expect(responses.find(response => response.statusCode === 409)?.json()).toEqual({ error: 'home_owner_transfer_required' });
        expect(await db.account.count({ where: { id: { in: [first.id, second.id] }, status: 'active', homeRole: 'owner' } })).toBe(1);
    });
});
