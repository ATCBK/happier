import { describe, expect, it } from 'vitest';
import { summarizeUsageExecutionSources } from './usageSourceSummary.js';

describe('summarizeUsageExecutionSources', () => {
    it('weights shares by tokens and retains unknown execution independently of native capture', () => {
        const result = summarizeUsageExecutionSources([
            { tokens: { total: 20 }, sourceContext: { path: 'native' as const, execution: 'happier' as const } },
            { tokens: { total: 30 }, sourceContext: { path: 'runtime' as const, execution: 'outside' as const } },
            { tokens: { total: 50 } },
        ]);
        expect(result).toMatchObject({ coverage: 'partial', totalTokens: 100, groups: [
            { execution: 'happier', tokens: 20, share: 0.2 },
            { execution: 'outside', tokens: 30, share: 0.3 },
            { execution: 'unknown', tokens: 50, share: 0.5 },
        ] });
        expect(summarizeUsageExecutionSources(undefined)).toEqual({ coverage: 'unknown', totalTokens: null, groups: [] });
        expect(summarizeUsageExecutionSources([])).toEqual({ coverage: 'complete', totalTokens: 0, groups: [] });
        expect(summarizeUsageExecutionSources([{ tokens: { total: 50 } }])).toMatchObject({ coverage: 'unknown',
            totalTokens: 50, groups: [{ execution: 'unknown', tokens: 50, share: 1 }] });
        expect(summarizeUsageExecutionSources([{ tokens: { total: 0 },
            sourceContext: { path: 'runtime', execution: 'happier' } }])).toMatchObject({
            totalTokens: 0, groups: [{ execution: 'happier', tokens: 0, share: null }],
        });
    });
});
