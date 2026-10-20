import { expect, it } from 'vitest';
import { decodeFilePreviewSlice, resolveFilePreviewRead } from './decodeFilePreviewSlice';

it('uses the configured budget for a chosen head or tail, with no automatic partial read', () => {
    expect(resolveFilePreviewRead({ sizeBytes: 14, maxPreviewBytes: 10 })).toEqual({
        kind: 'tooLarge', sizeBytes: 14, maxPreviewBytes: 10,
    });
    expect(resolveFilePreviewRead({ sizeBytes: 14, maxPreviewBytes: 10, previewSlice: 'head' })).toEqual({
        kind: 'partial', slice: 'head', range: { offset: 0, length: 10 }, totalBytes: 14,
    });
    expect(resolveFilePreviewRead({ sizeBytes: 15, maxPreviewBytes: 10, previewSlice: 'tail' })).toEqual({
        kind: 'partial', slice: 'tail', range: { offset: 5, length: 10 }, totalBytes: 15,
    });
    expect(resolveFilePreviewRead({ sizeBytes: 10, maxPreviewBytes: 10, previewSlice: 'tail' })).toEqual({ kind: 'complete' });
    expect(resolveFilePreviewRead({ sizeBytes: null, maxPreviewBytes: 10, previewSlice: 'tail' })).toEqual({ kind: 'complete' });
    expect(resolveFilePreviewRead({ sizeBytes: 15, maxPreviewBytes: null, previewSlice: 'tail' })).toEqual({ kind: 'complete' });
});

it('trims a UTF-8 character split by either preview boundary without stripping interior replacement characters', () => {
    const bytes = new TextEncoder().encode('a€b😀c');
    expect(decodeFilePreviewSlice(bytes.slice(0, 3), { offset: 0, totalBytes: bytes.length })).toBe('a');
    expect(decodeFilePreviewSlice(bytes.slice(2), { offset: 2, totalBytes: bytes.length })).toBe('b😀c');
    expect(decodeFilePreviewSlice(bytes.slice(6, 8), { offset: 6, totalBytes: bytes.length })).toBe('');
    expect(decodeFilePreviewSlice(new Uint8Array([0x61, 0xff, 0x62]), { offset: 0, totalBytes: 3 })).toBe('a�b');
    expect(decodeFilePreviewSlice(new Uint8Array([0x61, 0xe2]), { offset: 0, totalBytes: 2 })).toBe('a�');
});
