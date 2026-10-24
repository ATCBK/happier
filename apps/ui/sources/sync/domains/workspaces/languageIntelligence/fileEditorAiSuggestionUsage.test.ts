import { describe, expect, it } from 'vitest';
import { appendFileEditorAiSuggestionUsage, selectFileEditorAiSuggestionUsage, FileEditorAiSuggestionUsageV1Schema } from './fileEditorAiSuggestionUsage';

describe('content-free editor suggestion usage', () => {
    it('retains exact event counts and reported facts through device persistence without recording content', () => {
        const now = new Date(2026, 9, 23, 12);
        let usage = appendFileEditorAiSuggestionUsage({}, 'account-a', { kind: 'requested' }, now);
        usage = appendFileEditorAiSuggestionUsage(usage, 'account-a', { kind: 'valid', latencyMs: 120, inputTokens: 200, outputTokens: 12, costUsd: 0.001 }, now);
        usage = appendFileEditorAiSuggestionUsage(usage, 'account-a', { kind: 'shown' }, now);
        usage = appendFileEditorAiSuggestionUsage(usage, 'account-a', { kind: 'acceptedPartial' }, now);
        const stored = FileEditorAiSuggestionUsageV1Schema.parse(JSON.parse(JSON.stringify(usage)));
        expect(selectFileEditorAiSuggestionUsage(stored, 'account-a', now)).toMatchObject({
            requested: 1, valid: 1, shown: 1, acceptedFull: 0, acceptedPartial: 1,
            inputTokens: 200, outputTokens: 12, reportedCostUsd: 0.001, costReports: 1, latencyMsTotal: 120, latencyReports: 1,
        });
        expect(selectFileEditorAiSuggestionUsage(stored, 'account-b', now).requested).toBe(0);
        const tomorrow = new Date(2026, 9, 24, 12);
        expect(selectFileEditorAiSuggestionUsage(stored, 'account-a', tomorrow).requested).toBe(0);
        const nextDay = appendFileEditorAiSuggestionUsage(stored, 'account-a', { kind: 'requested' }, tomorrow);
        expect(selectFileEditorAiSuggestionUsage(nextDay, 'account-a', tomorrow)).toMatchObject({ requested: 1, valid: 0, costReports: 0 });
    });
});
