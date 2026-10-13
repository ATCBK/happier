import { describe, expect, it, vi } from 'vitest';

import { segmentSentencesForSynthesis } from '@/voice/kokoro/runtime/segmentSentences';
import { guardAbandonedPrefetch } from '@/voice/kokoro/runtime/streamKokoroWavSentences';

describe('segmentSentencesForSynthesis', () => {
    it('splits prose into sentence-level segments on terminators', () => {
        expect(segmentSentencesForSynthesis('First sentence. Second one! Third?')).toEqual([
            'First sentence.',
            'Second one!',
            'Third?',
        ]);
    });

    it('does not split decimals or known abbreviations', () => {
        expect(segmentSentencesForSynthesis('Pi is 3.14 today. See e.g. the docs.')).toEqual([
            'Pi is 3.14 today.',
            'See e.g. the docs.',
        ]);
    });

    it('keeps a trailing fragment without a terminator', () => {
        expect(segmentSentencesForSynthesis('Done. trailing bit')).toEqual(['Done.', 'trailing bit']);
    });

    it('returns the whole text as one segment when there is no terminator', () => {
        expect(segmentSentencesForSynthesis('no terminator here')).toEqual(['no terminator here']);
    });

    it('ignores empty/whitespace-only input', () => {
        expect(segmentSentencesForSynthesis('   ')).toEqual([]);
    });
});

describe('guardAbandonedPrefetch (L4-3 barge-in unhandled-rejection guard)', () => {
    // The double-buffer keeps the NEXT sentence's synthesis in flight while the
    // consumer plays the current one. On barge-in that prefetch is abandoned
    // without ever being awaited; when it later rejects (synthesizeKokoroWav's
    // abort race) it must NOT surface as an unhandled rejection. This is verified
    // at the guard seam directly: the async-generator path cannot reproduce the
    // leak under Vitest because the async-generator transform attaches its own
    // handlers to in-flight operands (native Hermes/RN does not), so the
    // chokepoint guard is the honestly testable contract.
    it('attaches a rejection handler synchronously while returning the same promise', async () => {
        let rejectionHandlerAttached = false;
        let rejectPrefetch: (error: Error) => void = () => {};
        const prefetch = new Promise<ArrayBuffer>((_resolve, reject) => {
            rejectPrefetch = reject;
        });
        const originalThen = prefetch.then.bind(prefetch);
        (prefetch as unknown as { then: PromiseLike<ArrayBuffer>['then'] }).then = ((
            onFulfilled?: any,
            onRejected?: any,
        ) => {
            if (typeof onRejected === 'function') {
                rejectionHandlerAttached = true;
            }
            return originalThen(onFulfilled, onRejected);
        }) as PromiseLike<ArrayBuffer>['then'];

        const guarded = guardAbandonedPrefetch(prefetch);

        // The guard attaches a rejection handler at creation (so an abandoned
        // prefetch cannot leak)...
        expect(rejectionHandlerAttached).toBe(true);
        // ...and returns the SAME promise so an awaiting consumer still observes
        // the rejection.
        expect(guarded).toBe(prefetch);

        rejectPrefetch(new Error('aborted'));
        await expect(guarded as Promise<ArrayBuffer>).rejects.toThrow(/aborted/i);
    });

    it('passes a null prefetch (end of stream) through unchanged', () => {
        expect(guardAbandonedPrefetch(null)).toBeNull();
    });
});
