import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { openSessionSystemRecord, type SessionSystemRecordPayloadResult } from './codec';

const address = { owner: 'host', namespace: 'activity', kind: 'workflow_run.v1', localId: 'run-one' } as const;
const record = {
    id: 'record-one', address, content: { t: 'plain', v: { v: 1, title: 'ready' } },
    revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
};
const schema = z.strictObject({ v: z.literal(1), title: z.string() });
function decode(value: unknown): SessionSystemRecordPayloadResult<z.infer<typeof schema>> {
    if (value && typeof value === 'object' && 'v' in value && value.v !== 1) return { status: 'unsupported_version', version: value.v };
    const parsed = schema.safeParse(value);
    return parsed.success ? { status: 'ready', value: parsed.data } : { status: 'malformed' };
}
describe('System Record opening', () => {
    it('validates address and preserves malformed versus unsupported payload outcomes', async () => {
        const context = { mode: 'plain' } as const;
        expect(await openSessionSystemRecord({ record, address, context, decode })).toEqual({ status: 'ready', value: { v: 1, title: 'ready' } });
        expect(await openSessionSystemRecord({ record, address: { ...address, localId: 'other' }, context, decode })).toEqual({ status: 'malformed' });
        expect(await openSessionSystemRecord({ record: { ...record, content: { t: 'plain', v: { v: 2 } } }, address, context, decode })).toEqual({ status: 'unsupported_version', version: 2 });
        expect(await openSessionSystemRecord({ record: { ...record, content: { t: 'plain', v: { v: 1 } } }, address, context, decode })).toEqual({ status: 'malformed' });
    });
    it('distinguishes missing encryption context from hydrated context and a mismatched mode', async () => {
        const encrypted = { ...record, content: { t: 'encrypted', c: 'cipher' } };
        expect(await openSessionSystemRecord({ record: encrypted, address, context: { mode: 'e2ee', encryption: null }, decode })).toEqual({ status: 'locked' });
        const encryption = { encryptRaw: async () => 'cipher', decryptRaw: async () => ({ v: 1, title: 'ready' }) };
        expect(await openSessionSystemRecord({ record: encrypted, address, context: { mode: 'e2ee', encryption }, decode })).toEqual({ status: 'ready', value: { v: 1, title: 'ready' } });
        expect(await openSessionSystemRecord({ record: encrypted, address, context: { mode: 'plain' }, decode })).toEqual({ status: 'mode_mismatch' });
    });
});
