// @happier-platform:file feat=pending-wake-recovery
import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { logger } from '@/ui/logger';

import { createSessionProviderInputConsumer } from './SessionProviderInputConsumer';

describe('SessionProviderInputConsumer pending mismatch bounded rejoin', () => {
    it('retries a deferred pending_version_mismatch once after the retry delay without any wake event', async () => {
        let materializeCalls = 0;
        const session = {
            materializeNextPendingMessageSafely: async () => {
                materializeCalls += 1;
                if (materializeCalls === 1) {
                    return { type: 'deferred' as const, reason: 'pending_version_mismatch' as const, retryAfterMs: 20 };
                }
                // Second attempt keeps deferring; the consumer must not turn the bounded
                // rejoin into a polling loop (timedMaterializationRejoin is one-shot).
                return { type: 'deferred' as const, reason: 'pending_version_mismatch' as const, retryAfterMs: 20 };
            },
            // Parks forever: recovery in this test may only come from the bounded timed rejoin.
            waitForPendingEligibilityUpdate: () => new Promise<boolean>(() => {}),
        };
        const queue = new MessageQueue2<null>(() => 'mode');
        const consumer = createSessionProviderInputConsumer<null, string>({
            messageQueue: queue,
            session,
            metadataWaitRetryBackoffMs: 20,
        });
        const controller = new AbortController();
        try {
            const batch = consumer.waitForNextInput({ abortSignal: controller.signal });
            void batch.catch(() => undefined);
            // First call is the initial pass; the bounded rejoin must produce exactly one more
            // materialize attempt without any server hint or queue push. Observe a real quiet
            // window afterwards (fresh-review finding #2): no third call may arrive.
            await expect.poll(() => materializeCalls, { timeout: 3_000 }).toBe(2);
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(materializeCalls).toBe(2);
        } finally {
            controller.abort();
        }
    });

    it('force-reconciles, re-runs materialization, and logs when the pending wait goes silent past the staleness threshold', async () => {
        const previousThreshold = process.env.HAPPIER_PENDING_INPUT_STALE_RECHECK_MS;
        process.env.HAPPIER_PENDING_INPUT_STALE_RECHECK_MS = '25';
        let materializeCalls = 0;
        const reconcile = vi.fn(async (_opts: { force: boolean }) => undefined);
        const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const session = {
            materializeNextPendingMessageSafely: async () => {
                materializeCalls += 1;
                return { type: 'no_pending' as const };
            },
            // Parks forever: the staleness heartbeat is the only recovery path in this test.
            waitForPendingEligibilityUpdate: () => new Promise<boolean>(() => {}),
            reconcilePendingQueueState: reconcile,
        };
        const queue = new MessageQueue2<null>(() => 'mode');
        const consumer = createSessionProviderInputConsumer<null, string>({
            messageQueue: queue,
            session,
        });
        const controller = new AbortController();
        try {
            const batch = consumer.waitForNextInput({ abortSignal: controller.signal });
            void batch.catch(() => undefined);
            await expect.poll(() => reconcile.mock.calls.filter(([opts]) => opts?.force === true).length, { timeout: 3_000 }).toBeGreaterThanOrEqual(1);
            await expect.poll(() => materializeCalls, { timeout: 3_000 }).toBeGreaterThanOrEqual(2);
            expect(infoFile.mock.calls.some(([label]) => label === '[pendingQueue] input consumer wait staleness recheck')).toBe(true);
        } finally {
            controller.abort();
            infoFile.mockRestore();
            if (previousThreshold === undefined) delete process.env.HAPPIER_PENDING_INPUT_STALE_RECHECK_MS;
            else process.env.HAPPIER_PENDING_INPUT_STALE_RECHECK_MS = previousThreshold;
        }
    });
});
