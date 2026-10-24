import { z } from 'zod/mini';

export const FILE_EDITOR_AI_SUGGESTION_USAGE_KINDS = ['requested', 'valid', 'shown', 'acceptedFull', 'acceptedPartial', 'dismissed', 'kept'] as const;
export type FileEditorAiSuggestionUsageEvent = Readonly<{
    kind: typeof FILE_EDITOR_AI_SUGGESTION_USAGE_KINDS[number];
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    latencyMs?: number;
}>;
const count = () => z.number().check(z.int(), z.nonnegative());
export const FileEditorAiSuggestionDailyUsageSchema = z.object({
    day: z.string(), requested: count(), valid: count(), shown: count(),
    acceptedFull: count(), acceptedPartial: count(), dismissed: count(), kept: count(),
    inputTokens: count(), outputTokens: count(), reportedCostUsd: z.number().check(z.nonnegative()), costReports: count(),
    latencyMsTotal: z._default(z.number().check(z.nonnegative()), 0), latencyReports: z._default(count(), 0),
});
export const FileEditorAiSuggestionUsageV1Schema = z.catch(z.record(z.string(), FileEditorAiSuggestionDailyUsageSchema), {});
export type FileEditorAiSuggestionUsageV1 = z.infer<typeof FileEditorAiSuggestionUsageV1Schema>;
export type FileEditorAiSuggestionDailyUsage = z.infer<typeof FileEditorAiSuggestionDailyUsageSchema>;
export const EMPTY_FILE_EDITOR_AI_SUGGESTION_USAGE: FileEditorAiSuggestionDailyUsage = Object.freeze({
    day: '', requested: 0, valid: 0, shown: 0, acceptedFull: 0, acceptedPartial: 0, dismissed: 0,
    kept: 0, inputTokens: 0, outputTokens: 0, reportedCostUsd: 0, costReports: 0, latencyMsTotal: 0, latencyReports: 0,
});

function localDay(now: Date): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function selectFileEditorAiSuggestionUsage(
    usage: FileEditorAiSuggestionUsageV1, scopeKey: string, now = new Date(),
): FileEditorAiSuggestionDailyUsage {
    const value = usage[scopeKey];
    return value?.day === localDay(now) ? value : EMPTY_FILE_EDITOR_AI_SUGGESTION_USAGE;
}

/** Aggregates only admitted numeric facts. No prompt, path, language, model response or text is stored. */
export function appendFileEditorAiSuggestionUsage(
    usage: FileEditorAiSuggestionUsageV1, scopeKey: string, event: FileEditorAiSuggestionUsageEvent, now = new Date(),
): FileEditorAiSuggestionUsageV1 {
    const previous = selectFileEditorAiSuggestionUsage(usage, scopeKey, now);
    const reportedNumber = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const reportsCost = reportedNumber(event.costUsd);
    return { ...usage, [scopeKey]: {
        ...previous, day: localDay(now), [event.kind]: previous[event.kind] + 1,
        inputTokens: previous.inputTokens + (reportedNumber(event.inputTokens) ? Math.trunc(event.inputTokens!) : 0),
        outputTokens: previous.outputTokens + (reportedNumber(event.outputTokens) ? Math.trunc(event.outputTokens!) : 0),
        reportedCostUsd: previous.reportedCostUsd + (reportsCost ? event.costUsd! : 0),
        costReports: previous.costReports + (reportsCost ? 1 : 0),
        latencyMsTotal: previous.latencyMsTotal + (reportedNumber(event.latencyMs) ? event.latencyMs! : 0),
        latencyReports: previous.latencyReports + (reportedNumber(event.latencyMs) ? 1 : 0),
    } };
}
