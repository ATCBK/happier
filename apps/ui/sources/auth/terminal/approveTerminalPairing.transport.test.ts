import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';

import type { HomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { encodeBase64 } from '@/encryption/base64';
import { approveTerminalPairing } from './approveTerminalPairing';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('approveTerminalPairing transport ownership', () => {
    it.each([200, 404])('requires authenticated Account mode and token-only reader support despite retained keys (mode status %s)', async (modeStatus) => {
        const request = vi.fn(async (path: string) => jsonResponse(
            path === '/v1/account/encryption/currentness' ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 }
                : path.startsWith('/v1/auth/request/status') ? { status: 'pending', supportsV2: true }
                    : { success: true },
            path === '/v1/account/encryption/currentness' ? modeStatus : 200,
        ));
        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_plain_home',
            canonicalServerUrl: 'https://plain.example.test',
            revision: 1,
            endpoints: [{ kind: 'https' as const, url: 'https://plain.example.test' }],
        };
        const transport = {
            descriptor,
            canonicalServerUrl: descriptor.canonicalServerUrl,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            endpointUrl: descriptor.canonicalServerUrl,
            runtimeOrigin: descriptor.canonicalServerUrl,
            carrier: 'https' as const,
            authenticatedCredentialDestination: { kind: 'https' as const, applicationUrl: descriptor.canonicalServerUrl },
            createRequest: () => request,
            close: async () => {},
        } satisfies HomeEnrollmentTransport;
        const machineKey = new Uint8Array(32).fill(3);
        const approval = approveTerminalPairing({
            target: transport,
            requesterPublicKey: tweetnacl.box.keyPair().publicKey,
            pairingContext: { secret: new Uint8Array(32).fill(7), createdAtMs: 1000, expiresAtMs: 61000 },
            targetCredentials: {
                token: 'plain-account-token',
                encryption: { machineKey: encodeBase64(machineKey), publicKey: encodeBase64(tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey) },
            },
            supportsTokenOnly: false,
        });
        if (modeStatus === 404) await expect(approval).rejects.toMatchObject({ code: 'account-encryption-currentness-unavailable' });
        else await expect(approval).rejects.toThrow(/Token-only.*compatible reader/);
        expect(request.mock.calls.some(([path]) => path === '/v1/auth/response')).toBe(false);
    });

    it.each([false, true])('submits approval only for the current E2EE key through the resolved Home transport (obsolete=%s)', async (obsolete) => {
        const request = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ mode: 'e2ee', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(obsolete ? 4 : 3)).publicKey), updatedAt: 0 }))
            .mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }))
            .mockResolvedValueOnce(jsonResponse({ success: true }));
        const createRequest = vi.fn(() => request);
        const transport = {
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://home-b.example.test',
                revision: 1,
                endpoints: [{ kind: 'iroh', endpointId: 'iroh-home-b' }],
            },
            canonicalServerUrl: 'https://home-b.example.test',
            homeServerIdentityId: 'srv_home_b',
            endpointUrl: 'https://home-b.example.test',
            runtimeOrigin: 'http://127.0.0.1:43123',
            carrier: 'iroh',
            authenticatedCredentialDestination: {
                kind: 'iroh',
                endpointId: 'iroh-home-b',
            },
            createRequest,
            close: vi.fn(async () => {}),
        } satisfies HomeEnrollmentTransport;
        const machineKey = new Uint8Array(32).fill(3);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;

        const approval = approveTerminalPairing({
            target: transport,
            requesterPublicKey: tweetnacl.box.keyPair().publicKey,
            pairingContext: {
                secret: new Uint8Array(32).fill(7),
                createdAtMs: 1_000,
                expiresAtMs: 61_000,
            },
            targetCredentials: {
                token: 'home-b-token',
                encryption: {
                    publicKey: encodeBase64(publicKey),
                    machineKey: encodeBase64(machineKey),
                },
            },
            supportsTokenOnly: false,
        });
        if (obsolete) {
            await expect(approval).rejects.toThrow(/current Account content key/);
            expect(request.mock.calls.map((call) => call[0])).toEqual(['/v1/account/encryption/currentness']);
            return;
        }
        await expect(approval).resolves.toBe('approved');

        expect(createRequest).toHaveBeenCalledWith({ credentials: null });
        expect(request.mock.calls.map((call) => call[0])).toEqual([
            '/v1/account/encryption/currentness',
            expect.stringContaining('/v1/auth/request/status?publicKey='),
            '/v1/auth/response',
        ]);
    });
});
