import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { decodeWorkspaceFileText, reconstructWorkspaceFileTextBytes } from './workspaceFileTextDecoding';

describe('held workspace text byte reconstruction', () => {
    it.each([
        { name: 'UTF8 BOM', content: '\uFEFFhello\n' },
        { name: 'CRLF', content: 'first\r\nsecond\r\n' },
        { name: 'mixed line endings', content: 'first\r\nsecond\nthird\r' },
        { name: 'multibyte text and repeated BOM', content: '\uFEFF\uFEFFhéllo 界 😀\r\n' },
    ])('restores the exact $name bytes through the real decoder', async ({ content }) => {
        const original = new TextEncoder().encode(content);
        const decoded = await decodeWorkspaceFileText(encodeBase64(original, 'base64'));
        expect(decoded.kind).toBe('text');
        if (decoded.kind !== 'text') throw new Error('Expected strict UTF8 text');
        expect(reconstructWorkspaceFileTextBytes({ text: decoded.text, complete: true,
            encoding: { hasBom: decoded.hasBom, editable: true } })).toEqual(original);
    });

    it('classifies non-UTF8 bytes with NULs and control bytes as binary, and Latin-1 text as non-UTF8 text', async () => {
        const firmware = new Uint8Array([0x7f, 0x48, 0x50, 0x4b, 0x01, 0x00, 0xff, 0xfe, 0x00, 0x02, 0x9c, 0x03, 0x00, 0x11]);
        expect((await decodeWorkspaceFileText(encodeBase64(firmware, 'base64'))).kind).toBe('binary');
        const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in ISO-8859-1
        expect((await decodeWorkspaceFileText(encodeBase64(latin1, 'base64'))).kind).toBe('notUtf8');
    });

    it('refuses partial, non-UTF8 and unproven display text rather than changing the file bytes', async () => {
        const encoding = { hasBom: false, editable: true };
        expect(reconstructWorkspaceFileTextBytes({ text: 'head', complete: false, encoding })).toBeNull();
        const decoded = await decodeWorkspaceFileText(encodeBase64(new Uint8Array([0xff, 97]), 'base64'));
        expect(decoded.kind).toBe('notUtf8');
        expect(reconstructWorkspaceFileTextBytes({ text: '\uFFFDa', complete: true,
            encoding: { hasBom: false, editable: false, reason: 'notUtf8' } })).toBeNull();
        expect(reconstructWorkspaceFileTextBytes({ text: 'display without encoding evidence', complete: true })).toBeNull();
    });
});
