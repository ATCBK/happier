import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createCliAccountKvJsonTransport } from './accountKvJsonTransport';
import { deriveAccountMachineKeyFromRecoverySecret, createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { legacyAccountKvVectors } from '../../../../../packages/protocol/src/crypto/fixtures/accountKvLegacyV0';
import { decryptResult, decodeBase64, encrypt, encodeBase64 } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import tweetnacl from 'tweetnacl';

afterEach(() => vi.restoreAllMocks());
it('authorizes the exact encoded CAS body, not an empty-body signature', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    let authorizedBody: unknown;
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
        expect(authorizedBody).toEqual(body);
        return { status: 200, data: { success: true, results: [{ key: 'todo.task-a', version: 2 }] } };
    });
    const transport = createCliAccountKvJsonTransport({ credentials: { token: 'token', encryption: null }, key: 'todo.task-a',
        serverBaseUrl: 'https://task-home.test', resolveAuthorizationHeaders: request => {
            if (request.method === 'POST') authorizedBody = 'body' in request ? request.body : undefined;
            return { Authorization: 'Bearer token' };
        } });
    await expect(transport.compareAndSet({ task: 'accepted' }, 1)).resolves.toEqual({ success: true, version: 2 });
});

const secret = new Uint8Array(32).fill(7);
const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
const legacy: StoredCredentials = { token: 'token', encryption: { type: 'legacy', secret } };
const dataKey: StoredCredentials = { token: 'token', encryption: { type: 'dataKey', machineKey,
    publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey } };
const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: legacy.encryption! }).contentPublicKeyFingerprint);

// Axios is the network boundary; cipher selection, opening, and CAS handling are real.
function accountKvHttp(initial: readonly { key: string; encoded: string }[]) {
    const rows = new Map(initial.map(row => [row.key, { value: row.encoded, version: 6 }]));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/currentness')) return { status: 200, data: { mode: 'e2ee', version: 1,
            signingKeyFingerprint: 'signing-current', contentKeyFingerprint: fingerprint, updatedAt: 1 } };
        const key = decodeURIComponent(new URL(url).pathname.slice('/v1/kv/'.length));
        const row = rows.get(key);
        return row ? { status: 200, data: { key, ...row } } : { status: 404 };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
        const mutations = (body as { mutations: { key: string; value: string; version: number }[] }).mutations;
        const errors = mutations.flatMap(row => row.version === (rows.get(row.key)?.version ?? -1) ? []
            : [{ key: row.key, error: 'version-mismatch', ...rows.get(row.key) }]);
        if (errors.length) return { status: 409, data: { success: false, errors } };
        return { status: 200, data: { success: true, results: mutations.map(row => {
            rows.set(row.key, { value: row.value, version: row.version + 1 });
            return { key: row.key, version: row.version + 1 };
        }) } };
    });
    const transport = (credentials: StoredCredentials, key: string) => createCliAccountKvJsonTransport({ credentials, key,
        serverBaseUrl: 'https://task-home.test', resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer token' }) });
    return { rows, post, transport };
}

it('opens pinned legacy item/index, re-seals once, and exposes identical JSON to a data-key-only reader', async () => {
    const http = accountKvHttp(legacyAccountKvVectors);
    for (const row of legacyAccountKvVectors) {
        await expect(http.transport(legacy, row.key).read()).resolves.toEqual({ value: row.value, version: 7 });
        await expect(http.transport(dataKey, row.key).read()).resolves.toEqual({ value: row.value, version: 7 });
        await expect(http.transport(legacy, row.key).read()).resolves.toEqual({ value: row.value, version: 7 });
    }
    expect(http.post).toHaveBeenCalledTimes(2);
});

it('writes from recovery-secret credentials using the data key', async () => {
    const http = accountKvHttp([]);
    const row = legacyAccountKvVectors[0];
    await expect(http.transport(legacy, row.key).compareAndSet(row.value, -1)).resolves.toEqual({ success: true, version: 0 });
    await expect(http.transport(dataKey, row.key).read()).resolves.toEqual({ value: row.value, version: 0 });
});

it('does not overwrite a concurrent winner while re-sealing and returns its value/version', async () => {
    const row = legacyAccountKvVectors[0];
    const http = accountKvHttp([row]);
    const winner = { ...row.value, title: 'QA FX51 concurrent edit', extraFutureField: { retained: true } };
    http.post.mockImplementationOnce(async () => {
        const value = encodeBase64(encrypt(machineKey, 'dataKey', winner));
        http.rows.set(row.key, { value, version: 7 });
        return { status: 409, data: { success: false, errors: [{ key: row.key, error: 'version-mismatch', value, version: 7 }] } };
    });
    await expect(http.transport(legacy, row.key).read()).resolves.toEqual({ value: winner, version: 7 });
    expect(decryptResult(machineKey, 'dataKey', decodeBase64(http.rows.get(row.key)!.value))).toEqual({ status: 'authenticated', value: winner });
    expect(http.post).toHaveBeenCalledTimes(1);
});

it('keeps legacy ciphertext intact when only data-key custody is available', async () => {
    const row = legacyAccountKvVectors[0];
    const http = accountKvHttp([row]);
    await expect(http.transport(dataKey, row.key).read()).rejects.toMatchObject({ code: 'account_kv_content_unreadable' });
    expect(http.rows.get(row.key)).toEqual({ value: row.encoded, version: 6 });
    expect(http.post).not.toHaveBeenCalled();
});

it('coalesces the persisted effect of concurrent secret-holding readers with version CAS', async () => {
    const row = legacyAccountKvVectors[0];
    const http = accountKvHttp([row]);
    const reads = await Promise.all([http.transport(legacy, row.key).read(), http.transport(legacy, row.key).read()]);
    expect(reads).toEqual([{ value: row.value, version: 7 }, { value: row.value, version: 7 }]);
    expect(http.rows.get(row.key)?.version).toBe(7);
    await expect(http.transport(dataKey, row.key).read()).resolves.toEqual({ value: row.value, version: 7 });
});

it('leaves plain Account rows keyless and unchanged on read', async () => {
    const value = { future: ['retained', false, null, 0] };
    const encoded = Buffer.from(JSON.stringify({ t: 'plain', v: value })).toString('base64');
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => url.endsWith('/currentness')
        ? { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }
        : { status: 200, data: { key: 'workspace:plain', value: encoded, version: 4 } });
    const post = vi.spyOn(axios, 'post');
    const transport = createCliAccountKvJsonTransport({ credentials: { token: 'token', encryption: null }, key: 'workspace:plain',
        serverBaseUrl: 'https://plain-home.test', resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer token' }) });
    await expect(transport.read()).resolves.toEqual({ value, version: 4 });
    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalled();
});
