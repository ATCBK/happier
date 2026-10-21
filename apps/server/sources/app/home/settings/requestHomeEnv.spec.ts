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

describe('request Home configuration demand', () => {
    beforeAll(async () => {
        vi.stubEnv('HANDY_MASTER_SECRET', 'request-home-env-fixture-master-secret');
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        await initEncrypt();
    });
    afterAll(() => vi.unstubAllEnvs());
    beforeEach(() => {
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
});
