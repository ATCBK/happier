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
