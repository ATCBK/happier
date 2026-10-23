import { expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryBatchResult } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { encodeUsageQueryResource } from './usageQueryResourceEncoding';

it('encodes a large immutable Resource with one native UTF-8 operation and preserves exact Unicode JSON', () => {
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
    const encodeInto = vi.spyOn(TextEncoder.prototype, 'encodeInto');
    try {
        const first = encodeUsageQueryResource(batch);
        expect(new TextDecoder().decode(first.bytes)).toBe(JSON.stringify(batch));
        expect(encode.mock.calls.length, 'one changed Resource needs one native UTF-8 operation, not a JavaScript walk per scalar/key').toBe(1);
        expect(encodeInto.mock.calls.length, 'native serialization must not cross the UTF-8 boundary for every key and scalar').toBe(0);
        encode.mockClear();
        const changed: UsageQueryBatchResult = { ...batch, results: [{ ...batch.results[0]!, accounting: {
            ...accounting, totals: { ...accounting.totals, eventCount: 1001 },
        } }] };
        const second = encodeUsageQueryResource(changed);
        expect(new TextDecoder().decode(second.bytes)).toBe(JSON.stringify(changed));
        expect(encode.mock.calls.length).toBe(1);
        encode.mockClear();
        const third: UsageQueryBatchResult = { ...changed, results: [{ ...changed.results[0]!, accounting: {
            ...changed.results[0]!.accounting!, contributions: accounting.contributions.map((row, index) => index === 0
                ? { ...row, id: 'changed-λ-🌍' } : row),
        } }] };
        const thirdBytes = encodeUsageQueryResource(third);
        expect(new TextDecoder().decode(thirdBytes.bytes)).toBe(JSON.stringify(third));
        expect(encode.mock.calls.length).toBe(1);
        // Native TextEncoder polyfills need not implement encodeInto.
        const descriptor = Object.getOwnPropertyDescriptor(TextEncoder.prototype, 'encodeInto');
        Object.defineProperty(TextEncoder.prototype, 'encodeInto', { configurable: true, value: undefined });
        try {
            expect(new TextDecoder().decode(encodeUsageQueryResource(batch).bytes))
                .toBe(new TextDecoder().decode(first.bytes));
        } finally {
            if (descriptor) Object.defineProperty(TextEncoder.prototype, 'encodeInto', descriptor);
            else Reflect.deleteProperty(TextEncoder.prototype, 'encodeInto');
        }
    } finally { encode.mockRestore(); encodeInto.mockRestore(); }
});
