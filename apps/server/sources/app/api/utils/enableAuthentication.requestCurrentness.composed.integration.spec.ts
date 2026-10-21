import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { auth } from '@/app/auth/auth';
import { enforceLoginEligibility } from '@/app/auth/enforceLoginEligibility';
import { db, withSqliteReadSnapshot } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { encryptString } from '@/modules/encrypt';

import { enableAuthentication } from './enableAuthentication';

describe('authenticated request Account currentness', () => {
    let harness: LightSqliteHarness;
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-request-currentness-',
            initAuth: true,
            initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '' },
        });
        enableAuthentication(app);
        app.get('/private', { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        await harness?.close();
    });

    async function credential() {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        return { account, token };
    }

    it('does not open unrelated Home secrets just to read the auth diagnostic flag', async () => {
        await db.homeSettings.create({ data: {
            id: 'home',
            revision: 1,
            values: { HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: true },
            encryptedSecrets: new TextEncoder().encode(JSON.stringify({
                HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: privacyKit.encodeBase64(encryptString(
                    ['storage', 'HomeSettings', 'home', 'secrets', 'HAPPIER_AUTH_EMAIL_SMTP_PASSWORD', 'v1'],
                    'fixture-home-password',
                )),
            })),
        } });
        // Observe the real external cryptography API without replacing its implementation.
        const opens = vi.spyOn(privacyKit.KeyTree.prototype, 'symmetricDecryptString');
        try {
            const response = await app.inject({ method: 'GET', url: '/private' });
            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: 'Missing authorization header' });
            expect(opens).not.toHaveBeenCalled();
        } finally {
            opens.mockRestore();
            await db.homeSettings.deleteMany({});
        }
    });

    it('uses one fresh Account read per authenticated request, including a hot cryptographic cache', async () => {
        const { token } = await credential();
        // Persistence is the measured boundary; the real verifier and eligibility logic run unchanged.
        const accountReader = await withSqliteReadSnapshot(async reader => reader.account);
        const originalFindUnique = accountReader.findUnique;
        // Prisma delegates are Proxy-backed; give the boundary spy the real callable,
        // rather than the descriptor stub Vitest otherwise discovers.
        const lookup = vi.spyOn(accountReader, 'findUnique').mockImplementation(originalFindUnique);
        try {
            for (let request = 0; request < 2; request++) {
                lookup.mockClear();
                const response = await app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${token}` } });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({ ok: true });
                expect(lookup).toHaveBeenCalledTimes(1);
            }
        } finally {
            lookup.mockRestore();
            // Prisma's model Proxy has no ordinary descriptor value for Vitest to restore.
            accountReader.findUnique = originalFindUnique;
        }
    });

    it.each(['disable', 'revoke'] as const)('rejects the next request after %s with a hot token', async (change) => {
        const { account, token } = await credential();
        const headers = { authorization: `Bearer ${token}` };
        expect((await app.inject({ method: 'GET', url: '/private', headers })).statusCode).toBe(200);
        await db.account.update({ where: { id: account.id }, data: change === 'disable'
            ? { status: 'suspended' }
            : { tokenEpoch: { increment: 1 } } });
        const response = await app.inject({ method: 'GET', url: '/private', headers });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'invalid_token' });
    });

    it('cannot reuse another Account credential as lifecycle evidence', async () => {
        const alice = await credential();
        const bob = await credential();
        const verified = await auth.verifyToken(alice.token);
        if (!verified) throw new Error('Issued credential did not verify');
        const input = { accountId: bob.account.id, env: process.env, verifiedCredential: verified };
        await expect(enforceLoginEligibility(input))
            .resolves.toEqual({ ok: false, statusCode: 401, error: 'invalid-token' });
    });
});
