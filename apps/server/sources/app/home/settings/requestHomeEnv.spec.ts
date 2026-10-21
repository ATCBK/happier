import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as privacyKit from 'privacy-kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbTransactionMock, inTxPostgresControlStatementMock } from '@/app/api/testkit/dbMocks';

const boundary = vi.hoisted(() => ({ settings: vi.fn(), policy: vi.fn() }));

// Only persistence is substituted: transaction orchestration, Home precedence,
// authentication and cryptography all execute their production implementations.
vi.mock('@/storage/db', () => {
    const tables = {
        ...inTxPostgresControlStatementMock,
        homeSettings: { findUnique: boundary.settings },
        homeGovernancePolicy: { findUnique: boundary.policy },
    };
    return { db: createDbTransactionMock(() => tables).wrapDb(tables) };
});

import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { encryptString, initEncrypt } from '@/modules/encrypt';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { readRequestHomeEnv, readRequestHomeFlag } from './requestHomeEnv';

const flag = SERVER_CONFIG.HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS;

describe('request Home configuration demand', () => {
    beforeAll(async () => {
        vi.stubEnv('HANDY_MASTER_SECRET', 'request-home-env-fixture-master-secret');
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        await initEncrypt();
    });
    afterAll(() => vi.unstubAllEnvs());
    beforeEach(() => {
        vi.stubEnv('HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS', undefined);
        vi.stubEnv('HAPPY_AUTH_DECORATOR_DIAGNOSTIC_LOGS', undefined);
        boundary.settings.mockReset();
        boundary.policy.mockReset().mockResolvedValue(null);
        boundary.settings.mockResolvedValue({
            revision: 1,
            values: { HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: true },
            encryptedSecrets: new TextEncoder().encode(JSON.stringify({
                HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: privacyKit.encodeBase64(encryptString(
                    ['storage', 'HomeSettings', 'home', 'secrets', 'HAPPIER_AUTH_EMAIL_SMTP_PASSWORD', 'v1'],
                    'fixture-home-password',
                )),
            })),
        });
    });

    it('authenticates the missing-credential path without opening unrelated Home secrets', async () => {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        enableAuthentication(app);
        app.get('/private', { preHandler: app.authenticate }, async () => ({ ok: true }));
        const opens = vi.spyOn(privacyKit.KeyTree.prototype, 'symmetricDecryptString');
        try {
            const response = await app.inject({ method: 'GET', url: '/private' });
            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: 'Missing authorization header' });
            expect(opens).not.toHaveBeenCalled();
        } finally {
            opens.mockRestore();
            await app.close();
        }
    });

    it('shares the captured rows with concurrent flag readers and later full consumers, then refreshes on the next request', async () => {
        const request = {};
        const opens = vi.spyOn(privacyKit.KeyTree.prototype, 'symmetricDecryptString');
        try {
            expect(await Promise.all([readRequestHomeFlag(request, flag), readRequestHomeFlag(request, flag)]))
                .toEqual([true, true]);
            expect(opens).not.toHaveBeenCalled();
            boundary.settings.mockResolvedValue({ revision: 2, values: { [flag.key]: false }, encryptedSecrets: null });
            const env = await readRequestHomeEnv(request);
            expect(env[flag.key]).toBe('true');
            expect(env.HAPPIER_AUTH_EMAIL_SMTP_PASSWORD).toBe('fixture-home-password');
            expect(await readRequestHomeEnv(request)).toBe(env);
            expect(await readRequestHomeFlag(request, flag)).toBe(true);
            expect(boundary.settings).toHaveBeenCalledTimes(1);
            expect(boundary.policy).toHaveBeenCalledTimes(1);
            expect(opens).toHaveBeenCalledTimes(1);

            expect(await readRequestHomeFlag({}, flag)).toBe(false);
            expect(boundary.settings).toHaveBeenCalledTimes(2);
            expect(boundary.policy).toHaveBeenCalledTimes(2);
            expect(opens).toHaveBeenCalledTimes(1);
        } finally {
            opens.mockRestore();
        }
    });

    it.each([
        { key: '0', alias: '1', expected: false },
        { key: undefined, alias: '0', expected: false },
        { key: '  ', alias: '1', expected: true },
        { key: 'malformed', alias: '1', expected: false },
    ])('retains canonical deployment/alias precedence for $key / $alias', async ({ key, alias, expected }) => {
        vi.stubEnv('HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS', key);
        vi.stubEnv('HAPPY_AUTH_DECORATOR_DIAGNOSTIC_LOGS', alias);
        expect(await readRequestHomeFlag({}, flag)).toBe(expected);
    });

    it.each(['settings', 'policy'] as const)('refuses a failed %s capture even for a deployment-set flag, then retries the same request', async table => {
        vi.stubEnv('HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS', '0');
        const failure = new Error('fixture database unavailable');
        boundary[table].mockRejectedValueOnce(failure);
        const request = {};
        await expect(readRequestHomeFlag(request, flag)).rejects.toBe(failure);
        await expect(readRequestHomeFlag(request, flag)).resolves.toBe(false);
        expect(boundary.settings).toHaveBeenCalledTimes(2);
        expect(boundary.policy).toHaveBeenCalledTimes(2);
    });

    it('preserves later inferred full-env composition and its request identity', async () => {
        const request = {};
        await readRequestHomeFlag(request, flag);
        const env = await readRequestHomeEnv(request, { inferred: { HAPPIER_PUBLIC_SERVER_URL: 'https://inferred.example.test' } });
        expect(env.HAPPIER_PUBLIC_SERVER_URL).toBe('https://inferred.example.test');
        expect(env.HAPPIER_AUTH_EMAIL_SMTP_PASSWORD).toBe('fixture-home-password');
        expect(await readRequestHomeEnv(request)).toBe(env);
        expect(boundary.settings).toHaveBeenCalledTimes(1);
        expect(boundary.policy).toHaveBeenCalledTimes(1);
    });
});
