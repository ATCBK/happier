import { describe, expect, it, vi } from 'vitest';
import {
    createConversationAttachmentIdV1,
    encodeConversationAttachmentBytesV1,
    readConversationAttachmentIdV1,
} from './attachments.js';

describe('portable provider attachment identity', () => {
    it('preserves Unicode and delimiter-bearing native identities without a Node global', () => {
        vi.stubGlobal('Buffer', undefined);
        try {
            const parts = ['bot:/消息', 'message:1', 'file/é', 20_971_520, null] as const;
            const id = createConversationAttachmentIdV1('telegram', parts);
            expect(readConversationAttachmentIdV1(id, 'telegram')).toEqual(parts);
            expect(readConversationAttachmentIdV1(id, 'discord')).toBeNull();
            expect(readConversationAttachmentIdV1(`${id}!`, 'telegram')).toBeNull();
            expect(encodeConversationAttachmentBytesV1(new Uint8Array([0, 128, 255]))).toBe('AID/');
        } finally { vi.unstubAllGlobals(); }
    });

    it('rejects malformed identities instead of interpreting another native reference', () => {
        for (const id of ['', 'telegram-file:v1:!', 'telegram-file:v1:e30', 'telegram-file:v1:W3t9XQ', 'telegram-file:v1:W10=']) {
            expect(readConversationAttachmentIdV1(id, 'telegram')).toBeNull();
        }
    });
});
