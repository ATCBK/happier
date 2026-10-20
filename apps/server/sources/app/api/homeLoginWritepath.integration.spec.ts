import Fastify from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHomeCredentialDestinationDigestV1, encodeBase64, type HomeLoginAssertionV1 } from '@happier-dev/protocol';
import { ACCOUNT_DIRECTORY_ERROR_CODES_V1 } from '@happier-dev/protocol/auth/accountDirectory';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { initializeServerIdentityCache } from '@/app/serverIdentity/serverIdentity';
import { resetHomeConnectionDescriptorRevisionOwnerForTests } from '@/app/features/homeConnectionDescriptorPublication';
import { createHomeConnectionDescriptorContinuityStoreForServer } from '@/app/features/homeConnectionDescriptorContinuity';
import { canonicalHomeLoginAssertionBytes } from '@/app/accountDirectory/accountDirectorySigner';
import { registerApiRoutes } from './api';
import type { Fastify as TypedFastify } from './types';
import { enableAuthentication } from './utils/enableAuthentication';
import { resolveApiRateLimitPluginOptions } from './utils/apiRateLimitPolicy';

let harness: LightSqliteHarness;

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: 'home-login-writepath-',
        sqliteConnectionLimit: 1,
        initAuth: true,
        initEncrypt: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' },
    });
    await initializeServerIdentityCache(process.env);
}, 120_000);

afterAll(async () => {
    resetHomeConnectionDescriptorRevisionOwnerForTests();
    if (harness) await harness.close();
});

it.each([false, true])('prepares file continuity outside token issuance and rejects a changed destination (%s)', async (changeDestination) => {
    const origin = 'https://home-login-writepath.example.test';
    harness.resetEnv({
        HAPPIER_CANONICAL_SERVER_URL: origin,
        HAPPIER_PUBLIC_SERVER_URL: origin,
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: '0',
    });
    resetHomeConnectionDescriptorRevisionOwnerForTests();
    const homeServerIdentityId = await initializeServerIdentityCache(process.env);
    if (!homeServerIdentityId) throw new Error('Fixture identity unavailable');
    const descriptor = {
        v: 1 as const, homeServerIdentityId, canonicalServerUrl: origin, revision: 1,
        endpoints: [{ kind: 'https' as const, url: origin }],
    };
    const issuer = tweetnacl.sign.keyPair();
    const client = tweetnacl.box.keyPair();
    const account = await db.account.create({ data: { publicKey: randomUUID() }, select: { id: true } });
    const issuerId = `srv_${randomUUID()}`;
    const keyId = createHash('sha256').update(issuer.publicKey).digest('hex');
    await db.accountDirectoryLink.create({ data: {
        accountId: account.id, issuerServerIdentityId: issuerId, issuerSubjectId: account.id,
        issuerSigningKeyId: keyId, issuerSigningPublicKey: new Uint8Array(issuer.publicKey),
    } });
    const issuedAtMs = Date.now();
    const unsigned: Omit<HomeLoginAssertionV1, 'signatureBase64Url'> = {
        v: 1, purpose: 'happier.home-login', issuerServerIdentityId: issuerId,
        issuerSubjectId: account.id, audienceHomeServerIdentityId: homeServerIdentityId,
        credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(descriptor),
        clientBoxPublicKeyBase64: encodeBase64(client.publicKey, 'base64'),
        issuedAtMs, expiresAtMs: issuedAtMs + 120_000, keyId,
    };
    const assertion: HomeLoginAssertionV1 = {
        ...unsigned,
        signatureBase64Url: encodeBase64(tweetnacl.sign.detached(canonicalHomeLoginAssertionBytes(unsigned), issuer.secretKey), 'base64url'),
    };
    const actualStore = createHomeConnectionDescriptorContinuityStoreForServer(process.env);
    if (!actualStore) throw new Error('Fixture file store unavailable');
    const transactionsAtFileBoundary: boolean[] = [];
    const activeTransactionsAtFileBoundary: number[] = [];
    let activeTransactions = 0;
    let observedInteractiveTransaction = false;
    const actualTransaction = db.$transaction;
    // Observe the genuine interactive database boundary without replacing its callback or SQL.
    const observedTransaction = new Proxy(actualTransaction, {
        apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (...callbackArgs: unknown[]) => {
                observedInteractiveTransaction = true;
                activeTransactions += 1;
                try {
                    return await Reflect.apply(callback, undefined, callbackArgs);
                } finally {
                    activeTransactions -= 1;
                }
            }, ...args.slice(1)]);
        },
    });
    let releaseFile!: () => void;
    const fileReleased = new Promise<void>((resolve) => { releaseFile = resolve; });
    let fileEntered!: () => void;
    const fileStarted = new Promise<void>((resolve) => { fileEntered = resolve; });
    const app = Fastify({ logger: false });
    app.register(import('@fastify/rate-limit'), resolveApiRateLimitPluginOptions(process.env));
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
    enableAuthentication(typed);
    // Decorate the genuine file persistence boundary; publication and storage remain real.
    registerApiRoutes(typed, { homeConnectionDescriptorContinuityStore: {
        read: async (tx) => {
            transactionsAtFileBoundary.push(tx !== undefined);
            activeTransactionsAtFileBoundary.push(activeTransactions);
            return actualStore.read(tx);
        },
        write: async (value, tx) => {
            transactionsAtFileBoundary.push(tx !== undefined);
            activeTransactionsAtFileBoundary.push(activeTransactions);
            fileEntered();
            await fileReleased;
            const result = await actualStore.write(value, tx);
            if (changeDestination) process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://replacement.example.test';
            return result;
        },
    } });
    let request: ReturnType<typeof app.inject> | undefined;
    db.$transaction = observedTransaction;
    try {
        await app.ready();
        request = app.inject({ method: 'POST', url: '/v1/auth/home-login', payload: { v: 1, assertion } });
        const reachedFileBoundary = await Promise.race([
            fileStarted.then(() => true),
            request.then(() => false),
        ]);
        expect(reachedFileBoundary).toBe(true);
        expect(transactionsAtFileBoundary).not.toContain(true);
        expect(Math.max(...activeTransactionsAtFileBoundary)).toBe(0);
        releaseFile();
        const response = await request;
        // Successful response bodies contain sealed credentials; only inspect the refusal body.
        expect(response.statusCode).toBe(changeDestination ? 401 : 200);
        if (changeDestination) expect(response.json()).toMatchObject({ error: ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidAudience });
        expect(transactionsAtFileBoundary).not.toContain(true);
        expect(Math.max(...activeTransactionsAtFileBoundary)).toBe(0);
        expect(observedInteractiveTransaction).toBe(true);
    } finally {
        releaseFile();
        try {
            if (request) await request;
            await app.close();
            await db.account.delete({ where: { id: account.id } });
        } finally {
            db.$transaction = actualTransaction;
        }
    }
});
