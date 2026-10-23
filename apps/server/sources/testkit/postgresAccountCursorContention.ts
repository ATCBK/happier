import { expect } from 'vitest';
import { db } from '@/storage/db';

export function databaseLatch() {
    let resolve!: () => void;
    return { promise: new Promise<void>(done => { resolve = done; }), release: () => resolve() };
}

/** Hold a real cursor update across the owner's first attempt, without retrying it. */
export async function acrossAccountCursorCommit<T>(accountId: string, run: () => Promise<T>): Promise<T> {
    const held = databaseLatch(), release = databaseLatch();
    let holderPid = 0;
    const holder = db.$transaction(async tx => {
        await tx.account.update({ where: { id: accountId }, data: { seq: { increment: 1 } } });
        holderPid = (await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0].pid;
        held.release();
        await release.promise;
    });
    const holderOutcome = Promise.allSettled([holder]);
    await Promise.race([held.promise, holder.then(() => { throw new Error('Cursor holder did not reach its barrier'); })]);
    const operation = run();
    const outcome = Promise.allSettled([operation]);
    try {
        await expect.poll(async () => {
            const [{ blocked }] = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(
                'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() '
                + 'AND $1::int = ANY(pg_blocking_pids(pid))) AS blocked', holderPid,
            );
            return blocked;
        }).toBe(true);
    } finally {
        release.release();
        await holderOutcome;
    }
    const [result] = await outcome;
    if (result.status === 'rejected') throw result.reason;
    return result.value;
}
