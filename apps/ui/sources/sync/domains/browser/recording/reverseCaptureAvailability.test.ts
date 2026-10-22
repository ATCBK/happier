import { describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ subscribe: null as ((listener: () => void) => () => void) | null }));

// Observe the real store's notifications at React's subscription boundary: equal boolean
// selections can hide redundant notifications from rendered hook assertions.
vi.mock('react', () => ({
    useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => boolean) => {
        boundary.subscribe = subscribe;
        return getSnapshot();
    },
}));

import {
    hasDesktopBrowserRecordingReverseCaptureHandler,
    registerDesktopBrowserRecordingReverseCaptureHandler,
    useDesktopBrowserRecordingReverseCaptureHandler,
} from './reverseCaptureAvailability';

describe('desktop browser recording reverse capture availability', () => {
    it('notifies only when the public availability changes across reference-counted handlers', () => {
        expect(useDesktopBrowserRecordingReverseCaptureHandler('machine-1')).toBe(false);
        const listener = vi.fn();
        const unsubscribe = boundary.subscribe!(listener);
        const releaseFirst = registerDesktopBrowserRecordingReverseCaptureHandler(' machine-1 ');
        const releaseSecond = registerDesktopBrowserRecordingReverseCaptureHandler('machine-1');
        try {
            expect(hasDesktopBrowserRecordingReverseCaptureHandler('machine-1')).toBe(true);
            expect(listener).toHaveBeenCalledOnce();
            releaseFirst();
            expect(hasDesktopBrowserRecordingReverseCaptureHandler('machine-1')).toBe(true);
            expect(listener).toHaveBeenCalledOnce();
            releaseSecond();
            expect(hasDesktopBrowserRecordingReverseCaptureHandler('machine-1')).toBe(false);
            expect(listener).toHaveBeenCalledTimes(2);
            releaseSecond();
            expect(listener).toHaveBeenCalledTimes(2);
        } finally { releaseFirst(); releaseSecond(); unsubscribe(); }
    });
});
