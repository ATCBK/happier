import { describe, expect, it } from 'vitest';

import {
    applyKnownPendingQueueState,
    readKnownPendingQueueState,
} from './pendingQueueState';

// @happier-platform:begin feat=pending-wake-recovery 版本回退 hint 必须纠偏采纳而非丢弃（丢失唤醒死锁根因修复）
describe('pendingQueueState regression adoption', () => {
    it('adopts regressive server pending state as a bookkeeping correction instead of dropping it', () => {
        const current = { known: true as const, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 10 };
        const applied = applyKnownPendingQueueState(current, {
            known: true,
            pendingCount: 2,
            pendingBlockedCount: 0,
            pendingVersion: 8,
        });
        expect(applied.changed).toBe(true);
        expect(applied.state).toEqual({
            known: true,
            pendingCount: 2,
            pendingBlockedCount: 0,
            pendingVersion: 8,
        });
    });

    it('still deduplicates same-version replays without waking', () => {
        const current = { known: true as const, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 8 };
        const applied = applyKnownPendingQueueState(current, {
            known: true,
            pendingCount: 2,
            pendingBlockedCount: 0,
            pendingVersion: 8,
        });
        expect(applied.changed).toBe(false);
        expect(applied.state).toEqual(current);
    });
});
// @happier-platform:end feat=pending-wake-recovery

describe('pendingQueueState', () => {
    it('rejects fractional pending counters instead of truncating them', () => {
        expect(readKnownPendingQueueState({ pendingCount: 0.9, pendingVersion: 1 })).toBeNull();
        expect(readKnownPendingQueueState({ pendingCount: 1, pendingVersion: 2.5 })).toBeNull();
    });

    it('preserves blocked pending counts and defaults old snapshots to zero blocked rows', () => {
        expect(readKnownPendingQueueState({
            pendingCount: 3,
            pendingBlockedCount: 2,
            pendingVersion: 5,
        })).toEqual({
            known: true,
            pendingCount: 3,
            pendingBlockedCount: 2,
            pendingVersion: 5,
        });

        expect(readKnownPendingQueueState({
            pendingCount: 3,
            pendingVersion: 5,
        })).toEqual({
            known: true,
            pendingCount: 3,
            pendingBlockedCount: 0,
            pendingVersion: 5,
        });
    });
});
