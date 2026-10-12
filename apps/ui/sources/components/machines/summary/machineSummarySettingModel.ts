/**
 * The Machine summary setting's vocabulary — which instruments exist, the styles, the defaults and the
 * one normalizer the reader, the writer and `settings.get/set` share. Dependency-free so the settings
 * core can hold it without the summary's drawing code.
 */

/** The four instruments a machine summary can show, in their one canonical order. */
export const MACHINE_SUMMARY_METRICS = ['cpu', 'memory', 'disk', 'network'] as const;
export type MachineSummaryMetric = typeof MACHINE_SUMMARY_METRICS[number];

/** How the summary draws its instruments (R7/R8). Sparklines is the default. */
export const MACHINE_SUMMARY_STYLES = ['sparklines', 'bars', 'numbers', 'rings'] as const;
export type MachineSummaryStyle = typeof MACHINE_SUMMARY_STYLES[number];

export const DEFAULT_MACHINE_SUMMARY_STYLE: MachineSummaryStyle = 'sparklines';
export const DEFAULT_MACHINE_SUMMARY_METRICS: readonly MachineSummaryMetric[] = Object.freeze(['cpu', 'memory', 'disk']);

/**
 * The shown metrics as stored: known ids only, once each, in canonical order. An empty list is a valid
 * choice (R42.6: rows show names only); only an unreadable value falls back to the default.
 */
export function normalizeMachineSummaryMetrics(value: unknown): readonly MachineSummaryMetric[] {
    if (!Array.isArray(value)) return DEFAULT_MACHINE_SUMMARY_METRICS;
    const chosen = new Set(value.filter((entry): entry is MachineSummaryMetric => (MACHINE_SUMMARY_METRICS as readonly unknown[]).includes(entry)));
    return MACHINE_SUMMARY_METRICS.filter(metric => chosen.has(metric));
}
