import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';
import { NotificationPermissionJournal } from './notificationPermissionJournal';
import { createNotificationPermissionCoordinator } from './notificationPermissionCoordinator';

const request = { serverId: 'server', accountId: 'account', sessionId: 'session', requestId: 'request', action: 'allow' as const };

describe('notification permission issuance', () => {
    const storage = new MMKV({ id: 'notification-permission-test' });
    beforeEach(() => storage.clearAll());
    const setup = () => {
        const journal = new NotificationPermissionJournal(storage);
        return { journal, run: createNotificationPermissionCoordinator(journal) };
    };

    it('joins concurrent listener/task decisions and rejects the opposite decision', async () => {
        const { journal, run } = setup();
        let finish!: (value: unknown) => void;
        const send = vi.fn(async (onIssued: () => void) => {
            onIssued();
            expect(journal.read(request)?.state).toBe('issued');
            return new Promise((resolve) => { finish = resolve; });
        });
        const first = run(request, send);
        const second = run({ ...request }, send);
        expect(second).toBe(first);
        await expect(run({ ...request, action: 'deny' }, send)).resolves.toMatchObject({ status: 'conflict' });
        finish({ ok: true });
        await expect(first).resolves.toMatchObject({ status: 'confirmed' });
        await expect(run(request, send)).resolves.toMatchObject({ status: 'confirmed', duplicate: true });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('never replays after an issued timeout or a runtime restart', async () => {
        const first = setup();
        const send = vi.fn(async (issued: () => void) => { issued(); throw new Error('timeout'); });
        await expect(first.run(request, send)).resolves.toMatchObject({ status: 'unconfirmed' });
        const restarted = setup();
        await expect(restarted.run(request, send)).resolves.toMatchObject({ status: 'unconfirmed', duplicate: true });
        // A changed decision cannot overwrite an ambiguous issuance either.
        await expect(restarted.run({ ...request, action: 'deny' }, send)).resolves.toMatchObject({ status: 'conflict' });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('treats a process killed after issuance as unconfirmed', async () => {
        const { journal } = setup();
        journal.write(request, 'issued');
        const send = vi.fn();
        await expect(setup().run(request, send)).resolves.toMatchObject({ status: 'unconfirmed' });
        expect(send).not.toHaveBeenCalled();
    });

    it('joins cold-start observation to a live action but never issues from saved responses', async () => {
        const { run } = setup();
        const send = vi.fn(async (issued: () => void) => { issued(); return { ok: true }; });
        await expect(run(request, send, { allowExecution: false })).resolves.toMatchObject({ status: 'not_sent' });
        expect(send).not.toHaveBeenCalled();
        const first = run(request, send);
        expect(run(request, send, { allowExecution: false })).toBe(first);
        await expect(first).resolves.toMatchObject({ status: 'confirmed' });
    });

    it('prevents late preflight emission after the outer RPC deadline', async () => {
        vi.useFakeTimers();
        try {
            const { run } = setup();
            let issueLater!: () => void;
            let finish!: (result: unknown) => void;
            const pending = run(request, (issued) => {
                issueLater = issued;
                return new Promise((resolve) => { finish = resolve; });
            });
            await vi.advanceTimersByTimeAsync(30_000);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            expect(() => issueLater()).toThrow();
            finish({ ok: true });
        } finally { vi.useRealTimers(); }
    });

    it('lets a fresh press retry or change a never-sent decision, while saved responses still cannot execute', async () => {
        const { run } = setup();
        const send = vi.fn(async () => { throw new Error('offline'); });
        await expect(run(request, send)).resolves.toMatchObject({ status: 'not_sent' });
        expect(send).toHaveBeenCalledTimes(1);
        // A saved response is an observation, not fresh intent: never issues a never-sent decision.
        await expect(run(request, send, { allowExecution: false })).resolves.toMatchObject({ status: 'not_sent' });
        expect(send).toHaveBeenCalledTimes(1);
        // A fresh live press may change the decision because nothing was ever issued.
        const retry = vi.fn(async (issued: () => void) => { issued(); return { ok: true }; });
        await expect(run({ ...request, action: 'deny' }, retry)).resolves.toMatchObject({ status: 'confirmed' });
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it.each([
        [{ ok: false, errorCode: 'permission_request_expired' }, 'rejected'],
        [{ ok: false, errorCode: 'permission_request_not_found' }, 'rejected'],
        [undefined, 'unconfirmed'],
        [{}, 'unconfirmed'],
    ])('interprets application acknowledgement %j as %s', async (ack, status) => {
        const { run } = setup();
        const send = vi.fn(async (issued: () => void) => { issued(); return ack; });
        await expect(run(request, send)).resolves.toMatchObject({ status });
        // Issued/settled outcomes never re-send, even for a fresh press.
        await run(request, send);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('isolates accounts, sessions and servers without relying on notification IDs', async () => {
        const { run } = setup();
        const send = vi.fn(async (issued: () => void) => { issued(); return { ok: true }; });
        await run(request, send);
        await run({ ...request, accountId: 'other' }, send);
        await run({ ...request, sessionId: 'other' }, send);
        await run({ ...request, serverId: 'other' }, send);
        expect(send).toHaveBeenCalledTimes(4);
    });

    it('continues valid actions beyond capacity by reclaiming settled records', async () => {
        const journal = new NotificationPermissionJournal(storage, 2);
        const run = createNotificationPermissionCoordinator(journal);
        const send = vi.fn(async (issued: () => void) => { issued(); return { ok: true }; });
        for (let index = 0; index < 5; index += 1) {
            await expect(run({ ...request, requestId: `request-${index}` }, send)).resolves.toMatchObject({ status: 'confirmed' });
        }
        expect(send).toHaveBeenCalledTimes(5);
        expect(storage.getAllKeys().filter((key) => key.startsWith('request:v1:')).length).toBeLessThanOrEqual(2);
    });

    it('reclaims the oldest settled record and preserves ambiguous records regardless of age', () => {
        vi.useFakeTimers();
        try {
            const journal = new NotificationPermissionJournal(storage, 3);
            vi.setSystemTime(1000);
            journal.write({ ...request, requestId: 'old-settled' }, 'confirmed');
            vi.setSystemTime(2000);
            journal.write({ ...request, requestId: 'older-ambiguous' }, 'issued');
            vi.setSystemTime(3000);
            journal.write({ ...request, requestId: 'newer-settled' }, 'rejected');
            vi.setSystemTime(4000);
            journal.write({ ...request, requestId: 'incoming' }, 'confirmed');
            expect(journal.read({ ...request, requestId: 'old-settled' })).toBeNull();
            expect(journal.read({ ...request, requestId: 'older-ambiguous' })?.state).toBe('issued');
            expect(journal.read({ ...request, requestId: 'newer-settled' })?.state).toBe('rejected');
            expect(journal.read({ ...request, requestId: 'incoming' })?.state).toBe('confirmed');
        } finally { vi.useRealTimers(); }
    });

    it('fails closed when only ambiguous records remain, or the journal is corrupt or cannot persist issuance', async () => {
        const journal = new NotificationPermissionJournal(storage, 2);
        journal.write({ ...request, requestId: 'ambiguous-1' }, 'issued');
        journal.write({ ...request, requestId: 'ambiguous-2' }, 'unconfirmed');
        const run = createNotificationPermissionCoordinator(journal);
        const send = vi.fn(async (issued: () => void) => { issued(); return { ok: true }; });
        await expect(run({ ...request, requestId: 'next' }, send)).resolves.toMatchObject({ status: 'not_sent' });
        expect(send).not.toHaveBeenCalled();
        expect(journal.read({ ...request, requestId: 'ambiguous-1' })?.state).toBe('issued');
        expect(journal.read({ ...request, requestId: 'ambiguous-2' })?.state).toBe('unconfirmed');
        storage.clearAll();
        vi.spyOn(storage, 'set').mockImplementation(() => { throw new Error('disk full'); });
        let emitted = false;
        await run(request, async (issued) => { issued(); emitted = true; return { ok: true }; });
        expect(emitted).toBe(false);
        vi.restoreAllMocks();
        storage.set(journal.key(request), '{broken');
        await expect(run(request, send)).resolves.toMatchObject({ status: 'not_sent' });
    });
});
