import { describe, expect, it, vi } from 'vitest';
import { previewUnavailableCard, resolvePreviewUnavailable } from './previewUnavailable';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

describe('why a preview has no picture', () => {
    it('reads the owner code, never the message', () => {
        const message = 'File not found on this machine';
        expect(resolvePreviewUnavailable({ error: message, errorCode: 'too_large', sizeBytes: 40_000_000 }))
            .toEqual({ kind: 'tooLarge', sizeBytes: 40_000_000 });
        expect(resolvePreviewUnavailable({ error: message, errorCode: 'too_large' })).toEqual({ kind: 'tooLarge', sizeBytes: null });
        expect(resolvePreviewUnavailable({ error: message, errorCode: 'unsupported' })).toEqual({ kind: 'unsupported' });
        expect(resolvePreviewUnavailable({ error: message, errorCode: 'not_found' })).toEqual({ kind: 'missing' });
        expect(resolvePreviewUnavailable({ error: message, errorCode: 'blob_unavailable' })).toEqual({ kind: 'unverified', error: message });
        expect(resolvePreviewUnavailable({ error: message, errorCode: null })).toEqual({ kind: 'loadFailed', error: message });
        expect(resolvePreviewUnavailable({ error: message, errorCode: 'machine_carrier_transport_failed' })).toEqual({ kind: 'loadFailed', error: message });
    });

    it('says why, and only an unfinished read can be retried', () => {
        expect(previewUnavailableCard({ kind: 'tooLarge', sizeBytes: 40_265_318 }, 'hero.png'))
            .toMatchObject({ kind: 'empty', title: 'Too large to preview', reason: '40.3 MB', retryable: false });
        expect(previewUnavailableCard({ kind: 'unsupported' }, 'hero.heic')).toMatchObject({ kind: 'empty', title: "Can't preview this format", retryable: false });
        expect(previewUnavailableCard({ kind: 'missing' }, 'hero.png')).toMatchObject({ kind: 'empty', title: 'File not found', retryable: false });
        expect(previewUnavailableCard({ kind: 'unverified', error: 'hash' }, 'hero.png')).toMatchObject({ kind: 'error', title: 'This image could not be read', retryable: false });
        expect(previewUnavailableCard({ kind: 'loadFailed', error: 'interrupted' }, 'hero.png'))
            .toEqual({ kind: 'error', title: "Couldn't load hero.png", diagnosticCode: 'interrupted', retryable: true });
    });
});
