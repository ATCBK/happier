import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { createActionExecutor } from '@happier-dev/protocol';
import { createAccountScopedCryptoMaterialSnapshotV1, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { legacyAccountKvVectors } from '../../../../../packages/protocol/src/crypto/fixtures/accountKvLegacyV0';
import { createAccountKvHttpFixture } from '../../../../ui/sources/dev/testkit/fixtures/accountKvHttpFixture';
import { Encryption } from '../../../../ui/sources/sync/encryption/encryption';
import { createAccountKvJsonTransport } from '../../../../ui/sources/sync/ops/account/accountKvJsonTransport';
import { encodeBase64 } from '@/api/encryption';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';

it('UI legacy read re-seals real HTTP rows consumed by the paired CLI tasks.internal.list Action', async () => {
    const secret = new Uint8Array(32).fill(7);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
    const scope = { serverId: 'fx51-home', accountId: 'fx51-account' };
    const token = `header.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature`;
    const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint);
    const storage = createAccountKvHttpFixture();
    const server = createServer(async (request, response) => {
        try {
            if (request.url === '/v1/account/encryption/currentness') {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-current', contentKeyFingerprint: fingerprint, updatedAt: 1 }));
            } else if (!await storage.handle(request, response)) { response.statusCode = 404; response.end(); }
        } catch { response.statusCode = 500; response.end(); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        await axios.post(`${base}/v1/kv`, { mutations: legacyAccountKvVectors.map(row => ({ key: row.key, value: row.encoded, version: -1 })) });
        const encryption = await Encryption.create(secret);
        for (const row of legacyAccountKvVectors) {
            const ui = createAccountKvJsonTransport({ key: row.key, credentials: { token, secret: encodeBase64(secret, 'base64url') },
                encryption, request: (path, init) => fetch(`${base}${path}`, init), shouldContinue: () => true });
            await expect(ui.read()).resolves.toEqual({ value: row.value, version: 1 });
            await expect(ui.read()).resolves.toEqual({ value: row.value, version: 1 });
        }
        const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: { type: 'dataKey', machineKey,
            publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey } }, sessionId: 'cli-global', mode: 'e2ee',
            ctx: { encryptionKey: machineKey, encryptionVariant: 'dataKey' }, serverId: scope.serverId, serverHttpBaseUrl: base }));
        expect(await executor.execute('tasks.internal.list', {}, { surface: 'agent', authority: 'account_automation', bypassApprovals: true }))
            .toMatchObject({ ok: true, result: { status: 'ok', scope, undoneOrder: ['fx51-legacy'], todos: [{ id: 'fx51-legacy',
                title: legacyAccountKvVectors[0].value.title, linkedSessions: legacyAccountKvVectors[0].value.linkedSessions }] } });
        for (const row of legacyAccountKvVectors) expect(storage.read(row.key)?.version).toBe(1);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
