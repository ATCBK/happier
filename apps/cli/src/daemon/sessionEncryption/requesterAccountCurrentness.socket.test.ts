import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { prepareRequesterAccountActionContext, readRequesterAccountActionContext } from './requesterAccountActionProjection';
import { acquireRequesterAccountEncryptionCurrentness } from './requesterAccountEncryptionCurrentness';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { projectExternalActionRequesterHttpAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { prepareRequesterSessionBootstrap } from './requesterSessionCredentials';

const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
    accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
    actionId: 'projects.inspect', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: 'machine' },
} });
afterEach(() => vi.restoreAllMocks());

describe('requester Account currentness over the installed socket wiring', () => {
    it('shares the observed encryption fact with real requester bootstrap decisions', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
                updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const privateKey = nacl.sign.keyPair().secretKey;
        const custody = await prepareRequesterSessionBootstrap({ credentials: { token: 'bob', encryption: null },
            attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' },
            boundary: { serverId: 'home', serverHttpBaseUrl: 'https://home.example', happyHomeDir: '/unused-before-session-binding' },
            verifyMachineAdmissionCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: root,
                effectActionId: root.binding.actionId, target: root.binding.target, installationId: 'installation',
                privateKey, serverHttpBaseUrl: 'https://home.example' }),
        });
        try {
            if (!custody) throw new Error('Missing real requester bootstrap');
            const projected = await custody.admitted.projectExternalActionAuthorization(root, 'stable-home');
            expect(projected).not.toBeNull();
            expect(await projected?.requesterAccountProjection?.isCurrent()).toBe(true);
            expect(await custody.admitted.isCurrent()).toBe(true);
            expect(reads.mock.calls.filter(([url]) => String(url).endsWith('/currentness'))).toHaveLength(1);
            expect(channel.clients).toHaveLength(1);
            await channel.push('bob', { mode: 'e2ee', version: 2, updatedAt: 2,
                signingKeyFingerprint: 'changed-signing', contentKeyFingerprint: 'changed-content' });
            expect(await projected?.requesterAccountProjection?.isCurrent()).toBe(false);
            expect(await custody.admitted.isCurrent()).toBe(false);
        } finally { await custody?.cleanupOnFailure(); await channel.close(); }
    });

    it.each(['mode', 'signing key', 'content key', 'disconnect', 'withdrawn', 'malformed'] as const)(
        'refuses headers and new projection output when %s is pushed during a Home decision', async change => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const secret = new Uint8Array(32).fill(8);
        const mode = change === 'signing key' || change === 'content key' ? 'e2ee' : 'plain';
        const currentness = { mode, version: 1, updatedAt: 1,
            signingKeyFingerprint: mode === 'e2ee' ? computeAccountEncryptionMigrateKeyFingerprintV1(nacl.sign.keyPair.fromSeed(secret).publicKey) : null,
            contentKeyFingerprint: mode === 'e2ee' ? computeAccountEncryptionMigrateKeyFingerprintV1(nacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey) : null };
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/settings')) return { status: 200, data: mode === 'e2ee' ? { content: null, version: 0 }
                : { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/currentness')) return { status: 200, data: currentness };
            throw new Error(`Unexpected GET ${url}`);
        });
        let hold = false;
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(axios, 'post').mockImplementation(async () => {
            if (hold) { entered(); await held; }
            return { status: 200, data: { ok: true } };
        });
        const installationPrivateKey = nacl.sign.keyPair().secretKey;
        const prepared = await prepareRequesterAccountActionContext({ authorization: { ...root, binding: { ...root.binding, accountEncryptionMode: mode } },
            purpose: { kind: 'external_action' }, machineId: 'machine', installationId: 'installation', installationPrivateKey,
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example',
            ownCredentials: { token: 'bob', encryption: mode === 'e2ee' ? { type: 'legacy', secret } : null }, isCurrent: async () => true,
            createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
        });
        try {
            if (!prepared) throw new Error('Missing real requester custody');
            hold = true;
            const headers = prepared.authorization.requesterHttpProjection!.createRequestHeaders({
                effectActionId: 'projects.inspect', method: 'GET', path: '/v1/account/encryption/currentness' });
            const projection = projectExternalActionRequesterHttpAuthorization({ authorization: prepared.authorization, serverId: 'home',
                serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', target: root.binding.target,
                installationId: 'installation', privateKey: installationPrivateKey,
                isCurrent: prepared.authorization.requesterAccountProjection!.isCurrent });
            await waiting;
            if (change === 'disconnect') await channel.disconnect();
            else if (change === 'malformed') await channel.pushInvalidCurrentness('bob');
            else await channel.push('bob', change === 'withdrawn' ? null : { ...currentness, version: 2, updatedAt: 2,
                ...(change === 'mode' ? { mode: 'e2ee', signingKeyFingerprint: 'new-signing', contentKeyFingerprint: 'new-content' }
                    : change === 'signing key' ? { signingKeyFingerprint: 'changed-signing' } : { contentKeyFingerprint: 'changed-content' }) });
            release();
            expect(await headers).toBeNull();
            expect(await projection).toBeNull();
        } finally { release(); await prepared?.dispose?.(); await channel.close(); }
    });

    it('shares one Account fact, ignores profile/foreign changes, and reads once after reconnect', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: fact });
        const scope = { accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' };
        const first = acquireRequesterAccountEncryptionCurrentness(scope);
        const second = acquireRequesterAccountEncryptionCurrentness(scope);
        try {
            expect(await first.read()).toEqual(fact);
            expect(await second.read()).toEqual(fact);
            expect(reads).toHaveBeenCalledTimes(1);
            expect(channel.clients).toHaveLength(1);
            await channel.pushProfile('bob');
            await channel.push('other-account', { ...fact, mode: 'e2ee', version: 2 });
            expect(first.isCurrent(fact)).toBe(true);
            await channel.disconnect();
            expect(first.isCurrent(fact)).toBe(false);
            await expect(first.read()).rejects.toThrow();
            expect(reads).toHaveBeenCalledTimes(1);
            await channel.reconnect();
            expect(await second.read()).toEqual(fact);
            expect(reads).toHaveBeenCalledTimes(2);
            await first.dispose();
            expect(second.isCurrent(fact)).toBe(true);
        } finally { await first.dispose(); await second.dispose(); await channel.close(); }
    });

    it('keeps a pushed fact when an earlier HTTP subscription read finishes later', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        let entered!: () => void;
        let release!: (value: { status: number; data?: unknown }) => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<{ status: number; data?: unknown }>(resolve => { release = resolve; });
        vi.spyOn(axios, 'get').mockImplementation(async () => { entered(); return await held; });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' });
        const pending = observation.read();
        try {
            await waiting;
            const changed = { mode: 'e2ee' as const, version: 2, updatedAt: 2, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content' };
            await channel.push('bob', changed);
            release({ status: 200, data: { ...changed, mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } });
            expect(await pending).toEqual(changed);
            expect(observation.isCurrent(changed)).toBe(true);
        } finally { release({ status: 503 }); await observation.dispose(); await channel.close(); }
    });

    it('recovers an unknown HTTP fact on the next decision without a per-connection attempt limit', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        let available = false;
        const reads = vi.spyOn(axios, 'get').mockImplementation(async () => available
            ? { status: 200, data: fact } : { status: 503, data: {} });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' });
        try {
            await expect(observation.read()).rejects.toThrow();
            expect(observation.isCurrent(fact)).toBe(false);
            available = true;
            const before = reads.mock.calls.length;
            expect(await observation.read()).toEqual(fact);
            expect(reads.mock.calls.length - before).toBe(1);
            expect(await observation.read()).toEqual(fact);
            expect(reads.mock.calls.length - before).toBe(1);
        } finally { await observation.dispose(); await channel.close(); }
    });

    it('subscribes once and reuses the observed fact at repeated header decisions', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
                updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const prepared = await prepareRequesterAccountActionContext({ authorization: root, purpose: { kind: 'external_action' },
            machineId: 'machine', installationId: 'installation', installationPrivateKey: nacl.sign.keyPair().secretKey,
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example',
            ownCredentials: { token: 'bob', encryption: null }, isCurrent: async () => true,
            createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
        });
        try {
            expect(prepared).not.toBeNull();
            const context = readRequesterAccountActionContext(prepared?.authorization);
            expect(context).not.toBeNull();
            for (let decision = 0; decision < 3; decision++) {
                expect(await prepared?.authorization.requesterHttpProjection?.createRequestHeaders({
                    effectActionId: 'projects.inspect', method: 'GET', path: '/v1/account/encryption/currentness',
                })).not.toBeNull();
            }
            expect(reads.mock.calls.filter(([url]) => String(url).endsWith('/currentness'))).toHaveLength(1);
            expect(channel.clients).toHaveLength(1);
        } finally { await prepared?.dispose?.(); await channel.close(); }
    });
});
