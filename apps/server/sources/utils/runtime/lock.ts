export class LockAdmissionDeadlineExceededError extends Error {
    constructor() {
        super("Lock admission deadline expired before the operation could start");
        this.name = "LockAdmissionDeadlineExceededError";
    }
}

export function isLockAdmissionDeadlineExceededError(
    error: unknown,
): error is LockAdmissionDeadlineExceededError {
    return error instanceof LockAdmissionDeadlineExceededError;
}

type LockWaiter = Readonly<{
    resolve: () => void;
    reject: (error: unknown) => void;
    timeout: ReturnType<typeof setTimeout> | null;
    deadlineAtMs: number | undefined;
}>;

export class AsyncLock {
    private permits: number;
    private promiseResolverQueue: LockWaiter[] = [];

    constructor(private readonly capacity: number = 1) {
        if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Lock capacity must be a positive integer");
        this.permits = capacity;
    }

    async inLock<T>(
        func: () => Promise<T> | T,
        options: Readonly<{ deadlineAtMs?: number }> = {},
    ): Promise<T> {
        await this.lock(options);
        try {
            return await func();
        } finally {
            this.unlock();
        }
    }

    private async lock(options: Readonly<{ deadlineAtMs?: number }>) {
        const deadlineAtMs = options.deadlineAtMs;
        if (deadlineAtMs !== undefined && deadlineAtMs <= Date.now()) {
            throw new LockAdmissionDeadlineExceededError();
        }
        if (this.permits > 0) {
            this.permits = this.permits - 1;
            return;
        }
        await new Promise<void>((resolve, reject) => {
            let waiter: LockWaiter;
            const timeout = deadlineAtMs === undefined
                ? null
                : setTimeout(() => {
                    const index = this.promiseResolverQueue.indexOf(waiter);
                    if (index < 0) return;
                    this.promiseResolverQueue.splice(index, 1);
                    reject(new LockAdmissionDeadlineExceededError());
                }, Math.max(0, deadlineAtMs - Date.now()));
            waiter = { resolve, reject, timeout, deadlineAtMs };
            this.promiseResolverQueue.push(waiter);
        });
    }

    private unlock() {
        this.permits += 1;
        if (this.permits > this.capacity) {
            throw new Error('Lock released without an acquired permit.');
        }
        if (this.permits > 0) {
            while (this.promiseResolverQueue.length > 0) {
                const nextWaiter = this.promiseResolverQueue.shift();
                if (nextWaiter) {
                    if (nextWaiter.timeout !== null) clearTimeout(nextWaiter.timeout);
                    if (nextWaiter.deadlineAtMs !== undefined && nextWaiter.deadlineAtMs <= Date.now()) {
                        nextWaiter.reject(new LockAdmissionDeadlineExceededError());
                        continue;
                    }
                    this.permits -= 1;
                    nextWaiter.resolve();
                    return;
                }
            }
        }
    }
}
