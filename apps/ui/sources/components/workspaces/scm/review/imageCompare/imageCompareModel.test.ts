import { describe, expect, it } from 'vitest';
import { buildImageCompareModel, projectImageComparePreview } from './imageCompareModel';
import type { MediaStageItem } from '@/components/ui/media/stage/mediaStageItems';

describe('image comparison evidence', () => {
    it('keeps preview errors failed even when a successful revision read reported zero bytes', () => {
        const model = buildImageCompareModel({ changeKind: 'modified',
            before: projectImageComparePreview({ status: 'error', uri: null, error: 'Preview cache unavailable', sizeBytes: 0 }),
            after: projectImageComparePreview({ status: 'loaded', uri: 'after', error: null, byteLength: 0 }),
        });
        expect(model.before).toEqual({ kind: 'loadFailed', error: 'Preview cache unavailable' });
        expect(model.after).toEqual({ kind: 'noPreview', reason: 'empty' });
    });
    it.each(['disabled', 'loading'] as const)('does not treat %s preview metadata as loaded empty bytes', (status) => {
        const model = buildImageCompareModel({ changeKind: 'modified',
            before: projectImageComparePreview({ status, uri: null, error: null, sizeBytes: 0 }),
            after: projectImageComparePreview({ status, uri: null, error: null, byteLength: 0 }),
        });
        expect(model.before).toEqual({ kind: 'noPreview', reason: status });
        expect(model.after).toEqual({ kind: 'noPreview', reason: status });
    });
    it('keeps before/after order and never calls empty bytes deletion', () => {
        const empty = buildImageCompareModel({ changeKind: 'modified', before: { status: 'loaded', uri: 'before', sizeBytes: 0 },
            after: { status: 'loaded', uri: 'after', sizeBytes: 12 } });
        expect(empty.before).toEqual({ kind: 'noPreview', reason: 'empty' });
        expect(empty.after).toMatchObject({ kind: 'present', uri: 'after' });
        const beforeItem = { kind: 'image', title: 'Before', source: { enabled: true,
            source: { kind: 'uri', uri: 'before' }, cacheKey: 'pinned-before' } } satisfies MediaStageItem;
        const afterItem = { kind: 'image', title: 'After', source: { enabled: true,
            source: { kind: 'uri', uri: 'after' }, cacheKey: 'pinned-after' } } satisfies MediaStageItem;
        const model = buildImageCompareModel({ changeKind: 'modified', before: { status: 'loaded', uri: 'before', sizeBytes: 8 },
            after: { status: 'loaded', uri: 'after', sizeBytes: 12 }, beforeItem, afterItem });
        expect(model.gallery).toEqual([beforeItem, afterItem]);
        expect(model.gallery[0]).toBe(beforeItem);
    });
    it.each(['added', 'deleted'] as const)('uses explicit %s evidence even if a stale preview remains', (changeKind) => {
        const model = buildImageCompareModel({ changeKind, before: { status: 'loaded', uri: 'before' }, after: { status: 'loaded', uri: 'after' },
            beforeItem: 'before', afterItem: 'after' });
        expect(changeKind === 'added' ? model.before : model.after).toEqual({ kind: changeKind });
        expect(model.gallery).toEqual([changeKind === 'added' ? 'after' : 'before']);
    });
    it('distinguishes failed and over-budget reads and does not substitute the other image', () => {
        const model = buildImageCompareModel({ changeKind: 'modified', before: { status: 'error', error: 'missing pinned blob', errorCode: 'blob_unavailable' },
            after: { status: 'error', error: 'budget', errorCode: 'too_large' } });
        expect(model.before).toEqual({ kind: 'unreadable', cause: 'unverified', reason: 'missing pinned blob' });
        expect(model.after).toEqual({ kind: 'noPreview', reason: 'too_large', sizeBytes: null });
        expect(model.gallery).toEqual([]);
    });
    it('keeps an interrupted transfer retryable and a missing or unverified revision unreadable', () => {
        const interrupted = 'The direct machine connection was interrupted. Retry the transfer.';
        const model = buildImageCompareModel({ changeKind: 'modified',
            before: projectImageComparePreview({ status: 'error', uri: null, error: 'The revision bytes do not match their content hash.', errorCode: 'blob_unavailable' }),
            after: projectImageComparePreview({ status: 'error', uri: null, error: interrupted }),
        });
        expect(model.before).toEqual({ kind: 'unreadable', cause: 'unverified', reason: 'The revision bytes do not match their content hash.' });
        expect(model.after).toEqual({ kind: 'loadFailed', error: interrupted });
        const busy = buildImageCompareModel({ changeKind: 'modified',
            before: { status: 'error', error: 'Machine did not answer', errorCode: 'COMMAND_TIMEOUT' },
            after: { status: 'error', error: 'gone', errorCode: 'not_found' } });
        expect(busy.before).toEqual({ kind: 'loadFailed', error: 'Machine did not answer' });
        expect(busy.after).toEqual({ kind: 'unreadable', cause: 'missing', reason: 'gone' });
    });
    it('keeps the size of an over-budget side so its well can say how big it is', () => {
        const model = buildImageCompareModel({ changeKind: 'modified',
            before: projectImageComparePreview({ status: 'error', uri: null, error: 'too big', errorCode: 'too_large', sizeBytes: 40_000_000 }),
            after: projectImageComparePreview({ status: 'error', uri: null, error: 'format', errorCode: 'unsupported', sizeBytes: 12 }),
        });
        expect(model.before).toEqual({ kind: 'noPreview', reason: 'too_large', sizeBytes: 40_000_000 });
        expect(model.after).toEqual({ kind: 'noPreview', reason: 'unsupported' });
    });
});
