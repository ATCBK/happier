import { describe, expect, it } from 'vitest';
import { buildRecoveryCreditConsumeIdempotencyKey } from './recoveryCreditConsumeIdempotencyKey.js';

describe('recovery credit consume identity', () => {
    it('replays one selected-credit observation and distinguishes a later use', () => {
        const account = { serviceId: 'happier.agent.codex/openai-codex', profileId: 'work' };
        const key = buildRecoveryCreditConsumeIdempotencyKey({ ...account, providerCreditId: ' credit-1 ' });
        expect(key).toBe(buildRecoveryCreditConsumeIdempotencyKey({ ...account, providerCreditId: 'credit-1' }));
        const first = buildRecoveryCreditConsumeIdempotencyKey({ ...account, providerCreditId: 'credit-1', sourceSnapshotFetchedAtMs: 123 });
        expect(first).not.toBe(key);
        expect(first).toBe(buildRecoveryCreditConsumeIdempotencyKey({ ...account, providerCreditId: ' credit-1 ', sourceSnapshotFetchedAtMs: 123.9 }));
        expect(first).not.toBe(buildRecoveryCreditConsumeIdempotencyKey({ ...account, providerCreditId: 'credit-1', sourceSnapshotFetchedAtMs: 124 }));
        expect(first).not.toBe(buildRecoveryCreditConsumeIdempotencyKey({ ...account, providerCreditId: 'credit-1:snapshot:123' }));
        expect(buildRecoveryCreditConsumeIdempotencyKey(account)).toMatch(/aggregate:unknown$/);
        expect(buildRecoveryCreditConsumeIdempotencyKey({ ...account, sourceSnapshotFetchedAtMs: 123 })).not.toBe(buildRecoveryCreditConsumeIdempotencyKey({ ...account, sourceSnapshotFetchedAtMs: 124 }));
        expect(buildRecoveryCreditConsumeIdempotencyKey({ ...account, providerCreditId: 'x'.repeat(400) }).length).toBeLessThanOrEqual(256);
    });
});
