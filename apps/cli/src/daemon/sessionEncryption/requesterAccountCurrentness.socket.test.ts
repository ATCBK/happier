import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { admitRequesterAccountActionContext, prepareRequesterAccountActionContext, readRequesterAccountActionContext } from './requesterAccountActionProjection';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createExternalActionAuthorizedRequestHeaders, projectExternalActionRequesterHttpAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { prepareRequesterSessionBootstrap } from './requesterSessionCredentials';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { projectAutomationAccountCurrentnessWitnessV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { logger } from '@/ui/logger';

const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
    accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
    actionId: 'projects.inspect', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: 'machine' },
} });
afterEach(() => vi.restoreAllMocks());

describe('requester Account currentness over the installed socket wiring', () => {
    it('reports transport creation failure without secrets while preserving fresh HTTP reads', async () => {
        const sockets = await import('@/api/session/sockets');
        // Transport creation and file logging are system boundaries; currentness logic stays real.
        vi.spyOn(sockets, 'createUserScopedSocketConnection').mockImplementation(() => {
            throw new Error('transport failure with secret-token');
        });
        const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const first = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        const second = { ...first, version: 2 };
        vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: first }).mockResolvedValueOnce({ status: 200, data: second });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'private-account', token: 'secret-token', serverBaseUrl: 'https://private-home.example' });
        try {
            await expect(observation.read()).resolves.toEqual(first);
            await expect(observation.read()).resolves.toEqual(second);
            expect(warnings).toHaveBeenCalled();
            expect(JSON.stringify(warnings.mock.calls)).not.toContain('secret-token');
            expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-account');
            expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-home.example');
        } finally {
            await observation.dispose();
        }
    });

    it('reads exact claim currentness freshly while sharing only Account/Home encryption identity', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        let serverFact = fact;
        let available = true;
        vi.spyOn(axios, 'get').mockImplementation(async () => available
            ? { status: 200, data: serverFact } : { status: 503, data: {} });
        const scope = { accountId: 'bob', token: `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`,
            serverBaseUrl: 'https://home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness(scope);
        try {
            await observation.read();
            // Claiming advances the Account cursor before returning its exact
            // witness. That response can arrive before the socket wake.
            serverFact = { ...fact, version: 2 };
            expect(projectAutomationAccountCurrentnessWitnessV1(await fetchAccountEncryptionCurrentness(scope)))
                .toEqual({ mode: 'plain', version: 2, contentKeyFingerprint: null });
            available = false;
            await expect(fetchAccountEncryptionCurrentness(scope)).rejects.toThrow();
            const fallback = vi.fn(async () => ({ status: 503, data: {} }));
            expect(await readAccountEncryptionModeOnce({ scope, request: fallback })).toEqual({ kind: 'resolved', mode: 'plain' });
            expect(fallback).not.toHaveBeenCalled();
            await expect(fetchAccountEncryptionCurrentness({ ...scope, serverBaseUrl: 'https://other.home' })).rejects.toThrow();
            await expect(fetchAccountEncryptionCurrentness({ ...scope,
                token: `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature` })).rejects.toThrow();
            const signedHeaders = createExternalActionAuthorizedRequestHeaders({ authorization: root,
                effectActionId: root.binding.actionId, target: root.binding.target, installationId: 'installation',
                method: 'GET', path: '/v1/account/encryption/currentness', privateKey: nacl.sign.keyPair().secretKey });
            await expect(fetchAccountEncryptionCurrentness({ ...scope, authorizationHeaders: signedHeaders })).rejects.toThrow();
            await channel.disconnect();
            await expect(fetchAccountEncryptionCurrentness(scope)).rejects.toThrow();
            await expect(readAccountEncryptionModeOnce({ scope, request: fallback })).rejects.toThrow();
            expect(fallback).not.toHaveBeenCalled();
        } finally { await observation.dispose(); await channel.close(); }
    });
    it.each(['finite', 'session'] as const)('does not register another Account credential as the requester observation (%s)', async kind => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const encryptionAccounts: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            const account = config?.headers?.Authorization === 'Bearer alice' ? 'alice' : 'bob';
            if (url.endsWith('/profile')) return { status: 200, data: { id: account } };
            if (url.endsWith('/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/currentness')) {
                encryptionAccounts.push(account);
                return { status: 200, data: { mode: 'plain', version: 1, updatedAt: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null } };
            }
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const privateKey = nacl.sign.keyPair().secretKey;
        const verify = () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: root,
            effectActionId: root.binding.actionId, target: root.binding.target, installationId: 'installation',
            privateKey, serverHttpBaseUrl: 'https://home.example' });
        const admit = async (token: string) => {
            const credentials = { token, encryption: null };
            if (kind === 'finite') return await admitRequesterAccountActionContext({ authorization: root, credentials,
                serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', isCurrent: verify });
            const prepared = await prepareRequesterSessionBootstrap({ credentials,
                attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' },
                boundary: { serverId: 'home', serverHttpBaseUrl: 'https://home.example', happyHomeDir: '/unused-before-session-binding' },
                verifyMachineAdmissionCurrent: verify });
            return prepared ? { dispose: prepared.cleanupOnFailure } : null;
        };
        let accepted: Awaited<ReturnType<typeof admit>> = null;
        try {
            expect(await admit('alice')).toBeNull();
            expect(channel.clients).toHaveLength(0);
            accepted = await admit('bob');
            expect(accepted).not.toBeNull();
            expect(encryptionAccounts).toEqual(['bob']);
            expect(channel.clients).toHaveLength(1);
        } finally { await accepted?.dispose(); await channel.close(); }
    });

    it.each(['unbound', 'bound'] as const)('shares the observed encryption fact with real requester bootstrap decisions (%s)', async binding => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/v2/sessions/session')) return { status: 200, data: { session: createSessionRecordFixture({
                id: 'session', encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }),
                dataEncryptionKey: null, share: null,
            }) } };
            if (url.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
                updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const privateKey = nacl.sign.keyPair().secretKey;
        const custody = await prepareRequesterSessionBootstrap({ credentials: { token: 'bob', encryption: null },
            attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' },
            boundary: { serverId: 'home', serverHttpBaseUrl: 'https://home.example', happyHomeDir: '/unused-before-session-binding' },
            ...(binding === 'bound' ? { boundSessionId: 'session' } : {}),
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
        } finally {
            await custody?.cleanupOnFailure();
            reads.mockClear();
            if (custody) expect(await custody.admitted.isCurrent()).toBe(false);
            expect(reads).not.toHaveBeenCalled();
            await channel.close();
        }
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

    it('shares one Account fact without idle polling, ignores profile/foreign changes, and reads once after reconnect', async () => {
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
            // Keep initial connection and reconnect on the real Socket.IO clock.
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
            await vi.advanceTimersByTimeAsync(600_000);
            expect(first.isCurrent(fact)).toBe(true);
            expect(await second.read()).toEqual(fact);
            expect(reads).toHaveBeenCalledTimes(1);
            expect(channel.clients).toHaveLength(1);
            vi.useRealTimers();
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
        } finally { vi.useRealTimers(); await first.dispose(); await second.dispose(); await channel.close(); }
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
            const failure: unknown = await observation.read().catch(error => error);
            expect(readHttpStatus(failure instanceof Error ? failure.cause : null)).toBe(503);
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

    it.each(['abort', 'dispose'] as const)('cancels a waiting reader on %s without retiring another holder of the same Account fact', async cancellationKind => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(axios, 'get').mockImplementation(async () => { entered(); await held; return { status: 200, data: fact }; });
        const scope = { accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' };
        const first = acquireRequesterAccountEncryptionCurrentness(scope);
        const second = acquireRequesterAccountEncryptionCurrentness(scope);
        const cancellation = new AbortController();
        let outcome = 'pending';
        const reading = first.read(cancellation.signal).then(() => { outcome = 'resolved'; }, () => { outcome = 'refused'; });
        try {
            await waiting;
            if (cancellationKind === 'abort') cancellation.abort();
            else await first.dispose();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(outcome).toBe('refused');
            await reading;
            await first.dispose();
            release();
            expect(await second.read()).toEqual(fact);
            expect(second.isCurrent(fact)).toBe(true);
        } finally { release(); await first.dispose(); await second.dispose(); await channel.close(); }
    });

    it('retires an observation while its initial HTTP read is pending', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(axios, 'get').mockImplementation(async () => { entered(); await held; return { status: 200, data: fact }; });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' });
        let outcome = 'pending';
        const reading = observation.read().then(() => { outcome = 'resolved'; }, () => { outcome = 'refused'; });
        try {
            await waiting;
            await new Promise<void>(resolve => setImmediate(resolve));
            await observation.dispose();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(outcome).toBe('refused');
            await reading;
            expect(observation.isCurrent(fact)).toBe(false);
        } finally { release(); await observation.dispose(); await channel.close(); }
    });
});
