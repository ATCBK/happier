import { afterEach, describe, expect, it } from 'vitest';
import {
    publishPresentationNotice,
    readPresentationNotice,
    retirePresentationNotice,
    shouldSchedulePresentationNoticeRetirement,
} from './presentationNotices';

afterEach(() => retirePresentationNotice());

describe('presentation notice lifetime', () => {
    it('keeps sticky notices out of the host timer and retains exact retirement and replacement', () => {
        const sticky = { key: 'undo', message: 'Version replaced', severity: 'info', sticky: true } as const;
        expect(shouldSchedulePresentationNoticeRetirement(sticky, false)).toBe(false);
        expect(shouldSchedulePresentationNoticeRetirement({ ...sticky, sticky: false }, false)).toBe(true);
        expect(shouldSchedulePresentationNoticeRetirement({ ...sticky, sticky: false }, true)).toBe(false);
        expect(shouldSchedulePresentationNoticeRetirement(null, false)).toBe(false);
        publishPresentationNotice(sticky);
        retirePresentationNotice('previous');
        expect(readPresentationNotice()).toBe(sticky);
        const next = { ...sticky, key: 'newer' };
        publishPresentationNotice(next);
        retirePresentationNotice(sticky.key);
        expect(readPresentationNotice()).toBe(next);
        retirePresentationNotice(next.key);
        expect(readPresentationNotice()).toBeNull();
    });
});
