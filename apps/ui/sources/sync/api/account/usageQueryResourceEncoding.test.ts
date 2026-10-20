import { expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryBatchResult } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { encodeUsageQueryResource } from './usageQueryResourceEncoding';

it('encodes changed members without a temporary whole-accounting buffer and preserves exact Unicode JSON', () => {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 100 } });
    const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
    const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' };
    const unicode = String.fromCharCode(0, 0x22, 0x5c, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0x20, 0xdc00, 0xe000, 0xffff)
        + String.fromCodePoint(0x10000, 0x10ffff);
    const accounting = { v: 1 as const, totals: { eventCount: 1000, tokens, cost },
        contributions: Array.from({ length: 1000 }, (_, index) => ({ id: `${index}-λ-🌍-\ud800-${unicode}`, observedAtMs: 1,
            sessionId: null, turnId: null, agentId: null, modelId: null, machineId: null, projectKey: null,
            workspaceId: null, source: null, tokens, cost })) };
    const batch: UsageQueryBatchResult = { v: 1, results: [{ key: 'query', requestedQuery: query, shownQuery: query,
        accounting, sources: [], pending: false }] };
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
        const first = encodeUsageQueryResource(batch);
        expect(new TextDecoder().decode(first.bytes)).toBe(JSON.stringify(batch));
        expect(encode.mock.calls.length, 'sizing must not allocate a temporary byte buffer for every scalar and key').toBe(0);
        const fullAccountingAllocations = encode.mock.calls.filter(([text]) => text?.includes('"contributions":') && text.includes('λ'));
        expect(fullAccountingAllocations.length, 'one field cannot grow an additional full-accounting byte buffer').toBe(0);
        encode.mockClear();
        const changed: UsageQueryBatchResult = { ...batch, results: [{ ...batch.results[0]!, accounting: {
            ...accounting, totals: { ...accounting.totals, eventCount: 1001 },
        } }] };
        const second = encodeUsageQueryResource(changed, first);
        expect(new TextDecoder().decode(second.bytes)).toBe(JSON.stringify(changed));
        expect(encode.mock.calls.filter(([text]) => text?.includes('λ')).length,
            'unchanged contribution rows reuse the already admitted byte range').toBe(0);
        encode.mockClear();
        const third: UsageQueryBatchResult = { ...changed, results: [{ ...changed.results[0]!, accounting: {
            ...changed.results[0]!.accounting!, contributions: accounting.contributions.map((row, index) => index === 0
                ? { ...row, id: 'changed-λ-🌍' } : row),
        } }] };
        const thirdBytes = encodeUsageQueryResource(third, second);
        expect(new TextDecoder().decode(thirdBytes.bytes)).toBe(JSON.stringify(third));
        expect(encode.mock.calls.filter(([text]) => text?.includes('λ')).length,
            'a later changed row still reuses siblings inside the previously copied array').toBeLessThanOrEqual(2);
        // Native TextEncoder polyfills need not implement encodeInto.
        const encodeInto = Object.getOwnPropertyDescriptor(TextEncoder.prototype, 'encodeInto');
        Object.defineProperty(TextEncoder.prototype, 'encodeInto', { configurable: true, value: undefined });
        try {
            expect(encodeUsageQueryResource(batch).bytes).toEqual(first.bytes);
        } finally {
            if (encodeInto) Object.defineProperty(TextEncoder.prototype, 'encodeInto', encodeInto);
            else Reflect.deleteProperty(TextEncoder.prototype, 'encodeInto');
        }
    } finally { encode.mockRestore(); }
});
