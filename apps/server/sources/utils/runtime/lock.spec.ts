import { describe, expect, it, vi } from "vitest";

import { AsyncLock } from "./lock";

describe("AsyncLock bounded admission", () => {
    it("admits the supplied capacity and hands a released permit to the next waiter", async () => {
        vi.useFakeTimers();
        const lock = new AsyncLock(2);
        const entered: number[] = [];
        let releaseFirst!: () => void;
        let releaseSecond!: () => void;
        const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
        const secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
        const operations = [
            lock.inLock(async () => { entered.push(1); await firstHeld; }),
            lock.inLock(async () => { entered.push(2); await secondHeld; }),
            lock.inLock(async () => { entered.push(3); }),
        ];
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(entered).toEqual([1, 2]);
            releaseFirst();
            await vi.advanceTimersByTimeAsync(0);
            expect(entered).toEqual([1, 2, 3]);
        } finally {
            releaseFirst();
            releaseSecond();
            await Promise.all(operations);
            vi.useRealTimers();
        }
    });

    it("removes an expired waiter without starting it later or blocking its ordinary neighbor", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            const lock = new AsyncLock();
            let releaseFirst!: () => void;
            const first = lock.inLock(async () => await new Promise<void>((resolve) => { releaseFirst = resolve; }));
            await vi.advanceTimersByTimeAsync(0);

            const expiredOperation = vi.fn();
            const nextOperation = vi.fn(() => "next");
            const expired = lock.inLock(expiredOperation, { deadlineAtMs: 1_025 });
            const expiredRejection = expect(expired).rejects.toMatchObject({ name: "LockAdmissionDeadlineExceededError" });
            const next = lock.inLock(nextOperation);

            await vi.advanceTimersByTimeAsync(25);
            releaseFirst();
            await Promise.allSettled([first, expired, next]);

            await expiredRejection;
            expect(expiredOperation).not.toHaveBeenCalled();
            expect(nextOperation).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});
