import { describe, expect, it, vi } from 'vitest';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { decodeBase64StoredJsonContentEnvelope, encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { createAccountKvJsonTransport } from './accountKvJsonTransport';

const key = 'workspace:tabs:v1';
const credentials = { token: createAccountTokenForTests('receipt-account') };

describe('Account KV mutation settlement', () => {
    it('preserves a committed receipt when retirement occurs while the real HTTP response body settles', async () => {
        const kv = createAccountKvHttpFixture();
        const { createServer } = getVitestNodeBuiltin<typeof import('node:http')>('node:http');
        const server = createServer((request, response) => {
            if (request.url === '/v1/account/encryption/currentness') {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify(createPlainAccountEncryptionCurrentnessFixture()));
                return;
            }
            void kv.handle(request, response).then(handled => {
                if (!handled) { response.statusCode = 404; response.end(); }
            }).catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
        });
        let current = true;
        try {
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('KV HTTP fixture did not bind');
            const endpointUrl = `http://127.0.0.1:${address.port}`;
            // Keep HTTP, codecs, CAS and persistence real. Only the response-body
            // delivery boundary controls the Account-retirement interleaving.
            setRuntimeFetch(async (input, init) => {
                const response = await fetch(input, init);
                if (new URL(String(input)).pathname === '/v1/kv' && init?.method === 'POST') {
                    const readBody = response.json.bind(response);
                    vi.spyOn(response, 'json').mockImplementation(async () => {
                        const body: unknown = await readBody();
                        current = false;
                        return body;
                    });
                }
                return response;
            });
            const request = createServerFetchAtEndpoint({ endpointUrl, credentials, isCurrent: () => current });
            const transport = createAccountKvJsonTransport({
                key, credentials, request, encryption: null, shouldContinue: () => current,
            });
            await expect(transport.compareAndSet({ tabs: ['captured'] }, -1))
                .resolves.toEqual({ success: true, version: 0 });
            const stored = kv.read(key);
            expect(stored?.version).toBe(0);
            expect(stored && decodeBase64StoredJsonContentEnvelope(stored.value))
                .toEqual({ t: 'plain', v: { tabs: ['captured'] } });
        } finally {
            resetRuntimeFetch();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    it('preserves a successful CAS receipt after the captured Account retires', async () => {
        let current = true;
        const request = vi.fn<ServerFetch>()
            .mockResolvedValueOnce(Response.json(createPlainAccountEncryptionCurrentnessFixture()))
            .mockImplementationOnce(async () => {
                current = false;
                return Response.json({ success: true, results: [{ key, version: 5 }] });
            });
        const transport = createAccountKvJsonTransport({
            key, credentials, request, encryption: null, shouldContinue: () => current,
        });

        await expect(transport.compareAndSet({ tabs: ['captured'] }, 4))
            .resolves.toEqual({ success: true, version: 5 });
    });

    it.each([
        encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { private: 'captured' } }),
        null,
    ])('does not disclose a conflict record or tombstone after the captured Account retires (%#)', async (value) => {
        let current = true;
        const request = vi.fn<ServerFetch>()
            .mockResolvedValueOnce(Response.json(createPlainAccountEncryptionCurrentnessFixture()))
            .mockImplementationOnce(async () => {
                current = false;
                return Response.json({ success: false, errors: [{
                    key, error: 'version-mismatch', version: 6,
                    value,
                }] }, { status: 409 });
            });
        const transport = createAccountKvJsonTransport({
            key, credentials, request, encryption: null, shouldContinue: () => current,
        });

        await expect(transport.compareAndSet({ tabs: ['captured'] }, 5))
            .rejects.toMatchObject({ code: 'account_kv_scope_retired' });
    });

    it('does not issue a mutation after currentness retires the captured Account', async () => {
        let current = true;
        const request = vi.fn<ServerFetch>().mockImplementationOnce(async () => {
            current = false;
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        });
        const transport = createAccountKvJsonTransport({
            key, credentials, request, encryption: null, shouldContinue: () => current,
        });

        await expect(transport.compareAndSet({}, -1))
            .rejects.toMatchObject({ code: 'account_kv_scope_retired' });
        expect(request.mock.calls.map(call => call[0])).toEqual(['/v1/account/encryption/currentness']);
    });
});
