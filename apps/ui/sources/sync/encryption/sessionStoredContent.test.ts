import { describe, expect, it } from 'vitest';
import { openSessionStoredContent } from '@happier-dev/sync-client';

describe('persisted Session content', () => {
    it('reports a failed crypto operation without turning it into missing content', async () => {
        const encryption = { encryptRaw: async () => 'cipher', decryptRaw: async () => { throw new Error('native crypto unavailable'); } };
        await expect(openSessionStoredContent({ mode: 'e2ee', encryption }, { t: 'encrypted', c: 'cipher' })).resolves.toEqual({ status: 'corrupt_or_unopenable' });
    });
    it('separates mode mismatch, unavailable key, failed open and valid plain JSON', async () => {
        await expect(openSessionStoredContent({ mode: 'plain' }, { t: 'encrypted', c: 'cipher' })).resolves.toEqual({ status: 'mode_mismatch' });
        await expect(openSessionStoredContent({ mode: 'e2ee', encryption: null }, { t: 'encrypted', c: 'cipher' })).resolves.toEqual({ status: 'locked' });
        // Crypto is the system boundary; failures do not disclose a finer diagnosis.
        const encryption = { encryptRaw: async () => 'cipher', decryptRaw: async () => null };
        await expect(openSessionStoredContent({ mode: 'e2ee', encryption }, { t: 'encrypted', c: 'cipher' })).resolves.toEqual({ status: 'corrupt_or_unopenable' });
        await expect(openSessionStoredContent({ mode: 'plain' }, { t: 'plain', v: null })).resolves.toEqual({ status: 'ready', value: null });
    });

    it('rejects invalid envelopes while opening explicit Plain content directly', async () => {
        await expect(openSessionStoredContent({ mode: 'plain' }, { v: 1 })).resolves.toEqual({ status: 'malformed' });
        await expect(openSessionStoredContent({ mode: 'plain' }, { t: 'plain', c: 'ambiguous' })).resolves.toEqual({ status: 'malformed' });
        await expect(openSessionStoredContent({ mode: 'plain' }, { t: 'plain', v: { v: 1 } })).resolves.toEqual({
            status: 'ready',
            value: { v: 1 },
        });
        // Stored reads discard unknown envelope fields without changing explicit content or mode.
        await expect(openSessionStoredContent({ mode: 'plain' }, { t: 'plain', v: { v: 1 }, c: 'future-field' })).resolves.toEqual({
            status: 'ready',
            value: { v: 1 },
        });
    });
});
