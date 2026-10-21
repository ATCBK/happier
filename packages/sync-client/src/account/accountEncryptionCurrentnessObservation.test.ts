import { describe, expect, it, vi } from 'vitest';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { createAccountEncryptionCurrentnessObservation, projectAccountEncryptionIdentity } from './accountEncryptionCurrentnessObservation';

const plain = { mode: 'plain', version: 1, settingsVersion: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null } satisfies AccountEncryptionCurrentnessResponse;
const encrypted = { ...plain, mode: 'e2ee', version: 2, updatedAt: 2,
    contentKeyFingerprint: 'content-key' } satisfies AccountEncryptionCurrentnessResponse;
const update = (fact: unknown, id = 'account') => ({ id: 'update', seq: 2, createdAt: 2,
    body: { t: 'update-account', id, encryptionCurrentness: fact } });
const unavailable = () => new Error('currentness unavailable');

describe('portable Account encryption observation', () => {
    it('uses one initialization then synchronous pushes, not per-operation identity reads or cursor witnesses', async () => {
        const readFresh = vi.fn(async () => plain);
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account', readFresh, unavailable });
        observation.connected();
        await observation.read();
        expect(await Promise.all(Array.from({ length: 20 }, () => observation.read()))).toEqual(Array(20).fill(projectAccountEncryptionIdentity(plain)));
        expect(await observation.read()).toBe(observation.peek());
        expect(readFresh).toHaveBeenCalledTimes(1);
        observation.update(update(encrypted));
        expect(observation.peek()).toEqual(projectAccountEncryptionIdentity(encrypted));
        expect(observation.peek()).not.toHaveProperty('version');
        expect(observation.peek()).not.toHaveProperty('settingsVersion');
        expect(await observation.read()).toEqual(projectAccountEncryptionIdentity(encrypted));
        observation.update(update(plain));
        expect(await observation.read()).toEqual(projectAccountEncryptionIdentity(encrypted));
        expect(readFresh).toHaveBeenCalledTimes(1);
        observation.dispose();
    });

    it('does not resurrect a delayed HTTP fact after push or disconnect and refreshes a reconnect once', async () => {
        let finish!: (fact: AccountEncryptionCurrentnessResponse) => void;
        const readFresh = vi.fn(() => new Promise<AccountEncryptionCurrentnessResponse>(resolve => { finish = resolve; }));
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account', readFresh, unavailable });
        observation.connected();
        const initial = observation.read();
        const late = finish;
        observation.update(update(encrypted));
        await expect(initial).resolves.toEqual(projectAccountEncryptionIdentity(encrypted));
        late(plain);
        expect(await observation.read()).toEqual(projectAccountEncryptionIdentity(encrypted));
        observation.disconnected();
        expect(observation.peek()).toBeNull();
        await expect(observation.read()).rejects.toThrow('currentness unavailable');
        observation.connected();
        const peers = Promise.all([observation.read(), observation.read()]);
        finish(encrypted);
        await expect(peers).resolves.toEqual([projectAccountEncryptionIdentity(encrypted), projectAccountEncryptionIdentity(encrypted)]);
        expect(readFresh).toHaveBeenCalledTimes(2);
        observation.dispose();
    });

    it('ignores foreign updates and withdraws malformed matching facts before any later read', async () => {
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account', readFresh: async () => plain, unavailable });
        observation.connected();
        await observation.read();
        observation.update(update(encrypted, 'other-account'));
        expect(observation.peek()?.mode).toBe('plain');
        observation.update(update({ mode: 'unknown' }));
        expect(observation.peek()).toBeNull();
        expect(observation.isCurrent(plain)).toBe(false);
        observation.update(update(null));
        expect(observation.peek()).toBeNull();
        observation.dispose();
    });

    it('supports legacy AbortSignal readers and cancels one reader without retiring its peer', async () => {
        let finish!: (fact: AccountEncryptionCurrentnessResponse) => void;
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account',
            readFresh: () => new Promise(resolve => { finish = resolve; }), unavailable });
        observation.connected();
        const controller = new AbortController();
        // The platform boundary need only implement the original event API.
        const signal = Object.create(controller.signal) as AbortSignal;
        Object.defineProperties(signal, {
            any: { value: undefined }, throwIfAborted: { value: undefined },
            aborted: { get: () => controller.signal.aborted },
            reason: { get: () => controller.signal.reason },
            addEventListener: { value: controller.signal.addEventListener.bind(controller.signal) },
            removeEventListener: { value: controller.signal.removeEventListener.bind(controller.signal) },
        });
        const abandoned = observation.read(signal);
        const peer = observation.read();
        controller.abort(new Error('reader left'));
        await expect(abandoned).rejects.toThrow('reader left');
        finish(plain);
        await expect(peer).resolves.toEqual(projectAccountEncryptionIdentity(plain));
        observation.dispose();
        expect(observation.peek()).toBeNull();
        await expect(observation.read()).rejects.toThrow('currentness unavailable');
    });
});
