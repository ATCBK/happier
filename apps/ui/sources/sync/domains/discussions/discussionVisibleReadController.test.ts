import { describe, expect, it, vi } from 'vitest';

import { createDiscussionVisibleReadController } from './discussionVisibleReadController';

async function flushWrites(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('Session Discussion visible read controller', () => {
    it('ignores viewability observed before the tracked surface is active and advances only after foreground observation', async () => {
        const writeCursor = vi.fn(async (lastReadSeq: number) => ({ kind: 'succeeded' as const, lastReadSeq }));
        const controller = createDiscussionVisibleReadController({ writeCursor });

        controller.updateEligibility({ activeAndVisible: false, lastReadSeq: 0 });
        controller.observeVisibleMessageSeqs([2, 4]);
        expect(writeCursor).not.toHaveBeenCalled();

        controller.updateEligibility({ activeAndVisible: true, lastReadSeq: 0 });
        await flushWrites();
        expect(writeCursor).not.toHaveBeenCalled();

        controller.observeVisibleMessageSeqs([2, 4]);
        expect(writeCursor).toHaveBeenCalledWith(4);
        await flushWrites();
        expect(writeCursor).toHaveBeenCalledTimes(1);
    });

    it('never creates tracking state from visible messages when the canonical cursor is null', async () => {
        const writeCursor = vi.fn(async (lastReadSeq: number) => ({ kind: 'succeeded' as const, lastReadSeq }));
        const controller = createDiscussionVisibleReadController({ writeCursor });
        controller.updateEligibility({ activeAndVisible: true, lastReadSeq: null });
        controller.observeVisibleMessageSeqs([10]);
        await flushWrites();
        expect(writeCursor).not.toHaveBeenCalled();
    });

    it('serializes a newer visible frontier behind the current write without advancing past observation', async () => {
        let resolveFirst: (value: Readonly<{ kind: 'succeeded'; lastReadSeq: number }>) => void = () => {
            throw new Error('write cursor resolver was not installed');
        };
        const writeCursor = vi.fn((lastReadSeq: number) => new Promise<Readonly<{ kind: 'succeeded'; lastReadSeq: number }>>((resolve) => {
            if (lastReadSeq === 2) resolveFirst = resolve;
            else resolve({ kind: 'succeeded', lastReadSeq });
        }));
        const controller = createDiscussionVisibleReadController({ writeCursor });
        controller.updateEligibility({ activeAndVisible: true, lastReadSeq: 0 });
        controller.observeVisibleMessageSeqs([2]);
        controller.observeVisibleMessageSeqs([3]);
        expect(writeCursor).toHaveBeenCalledTimes(1);
        resolveFirst({ kind: 'succeeded', lastReadSeq: 2 });
        await flushWrites();
        expect(writeCursor.mock.calls).toEqual([[2], [3]]);
    });

    it('retains a transiently failed visible frontier and retries it only after an existing state-change signal', async () => {
        const writeCursor = vi.fn()
            .mockResolvedValueOnce({ kind: 'retryable' as const })
            .mockResolvedValueOnce({ kind: 'succeeded' as const, lastReadSeq: 4 });
        const controller = createDiscussionVisibleReadController({ writeCursor });
        controller.updateEligibility({ activeAndVisible: true, lastReadSeq: 0 });
        controller.observeVisibleMessageSeqs([2, 4]);
        await flushWrites();
        expect(writeCursor).toHaveBeenCalledTimes(1);

        controller.updateEligibility({ activeAndVisible: true, lastReadSeq: 0 });
        await flushWrites();
        expect(writeCursor.mock.calls).toEqual([[4], [4]]);
    });

    it('stops on a permanent refusal and requires a fresh foreground observation after tracking returns', async () => {
        const writeCursor = vi.fn()
            .mockResolvedValueOnce({ kind: 'stopped' as const })
            .mockResolvedValueOnce({ kind: 'succeeded' as const, lastReadSeq: 2 });
        const controller = createDiscussionVisibleReadController({ writeCursor });
        controller.updateEligibility({ activeAndVisible: true, lastReadSeq: 0 });
        controller.observeVisibleMessageSeqs([2]);
        await flushWrites();

        controller.updateEligibility({ activeAndVisible: true, lastReadSeq: 0 });
        await flushWrites();
        expect(writeCursor).toHaveBeenCalledTimes(1);

        controller.observeVisibleMessageSeqs([2]);
        await flushWrites();
        expect(writeCursor.mock.calls).toEqual([[2], [2]]);
    });

    it('never adopts a server cursor beyond the exact locally observed sequence', async () => {
        const writeCursor = vi.fn(async () => ({ kind: 'succeeded' as const, lastReadSeq: 99 }));
        const controller = createDiscussionVisibleReadController({ writeCursor });
        controller.updateEligibility({ activeAndVisible: true, lastReadSeq: 0 });
        controller.observeVisibleMessageSeqs([2]);
        await flushWrites();
        controller.observeVisibleMessageSeqs([3]);
        await flushWrites();

        expect(writeCursor.mock.calls).toEqual([[2], [3]]);
    });
});
