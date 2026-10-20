import { expect, it } from 'vitest';
import { decodeFilePreviewSlice } from './decodeFilePreviewSlice';

it('trims a UTF-8 character split by either preview boundary without stripping interior replacement characters', () => {
    const bytes = new TextEncoder().encode('a€b😀c');
    expect(decodeFilePreviewSlice(bytes.slice(0, 3), { offset: 0, totalBytes: bytes.length })).toBe('a');
    expect(decodeFilePreviewSlice(bytes.slice(2), { offset: 2, totalBytes: bytes.length })).toBe('b😀c');
    expect(decodeFilePreviewSlice(bytes.slice(6, 8), { offset: 6, totalBytes: bytes.length })).toBe('');
    expect(decodeFilePreviewSlice(new Uint8Array([0x61, 0xff, 0x62]), { offset: 0, totalBytes: 3 })).toBe('a�b');
    expect(decodeFilePreviewSlice(new Uint8Array([0x61, 0xe2]), { offset: 0, totalBytes: 2 })).toBe('a�');
});
