import { lazyZodSchema } from '../lazyZodSchema.js';
import * as z from 'zod/mini';
import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';
import { instantiateWidgetLayoutFragmentGroupV1, type WidgetLayoutFragmentDraftV1, type WidgetLayoutFragmentGroupV1 } from './widgetLayoutFragmentV1.js';
import { readBuiltinWidgetDescriptorV1 } from './builtinWidgetDescriptorV1.js';
import type { WidgetAreaPresetV1 } from './widgetSurfaceArtifactV1.js';
import { USAGE_QUERY_INPUT_FIELDS, UsageQuerySchema, type UsageQuery } from '../inputs/usageQuery.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/jsonSchema.js';
import type { UsageAnalyticsBreakdownDimension } from '../usage/usageAnalyticsContracts.js';
import type { WidgetSizeV1 } from './widgetPresentationV1.js';

export const USAGE_WIDGET_PRESET_IDS = ['overview', 'costs', 'work', 'usage', 'plans', 'coach', 'how-you-work', 'sources'] as const;
export type UsageWidgetPresetId = typeof USAGE_WIDGET_PRESET_IDS[number];
const defaultNames: Readonly<Record<UsageWidgetPresetId, string>> = {
    overview: 'Overview', costs: 'Costs', work: 'Work', usage: 'Usage', plans: 'Plans', coach: 'Coach',
    'how-you-work': 'How you work', sources: 'Sources',
};

const scopes = USAGE_QUERY_INPUT_FIELDS.filter(field => field.contextMode === 'follow');
const scopeSchema = () => PluginJsonSchemaV2Schema.parse(zodSchemaToJsonSchemaObject(lazyZodSchema(() => z.pick(UsageQuerySchema, {
    period: true, agents: true, machines: true, projects: true, sources: true, session: true, costBasis: true,
})), { target: 'draft-7' }));

type PresetWidget = Readonly<{ id: string; size: WidgetSizeV1; metric?: 'tokens' | 'cost';
    breakdown?: readonly UsageAnalyticsBreakdownDimension[] }>;
type Arrangement = Readonly<{ width: 'half' | 'full'; widgets: readonly PresetWidget[] }>;
const w = (id: string, size: WidgetSizeV1, extra?: Omit<PresetWidget, 'id' | 'size'>): PresetWidget => ({ id, size, ...extra });
/**
 * Each host view is one Card · Lines group (lab `d2views`, `wgusage-CD`): declared sizes pack into the
 * group's two columns — Overview's tall daily bars on the left beside the period and capacity — and a
 * phone stacks the same children in reading order.
 */
const arrangements: Readonly<Record<UsageWidgetPresetId, readonly Arrangement[]>> = {
    overview: [{ width: 'full', widgets: [w('usage_daily', 'tall'), w('usage_period_summary', 'medium'), w('usage_capacity', 'medium'),
        // Efficiency's four figures are the compact one: the group's column packing stacks it over Rhythm
        // beside the Projections list, so neither column ends in a half-empty cell (lab wgusage-CD).
        w('usage_coach', 'full'), w('usage_projections', 'medium'), w('usage_efficiency', 'small'),
        w('usage_rhythm', 'medium')] }],
    // Cost facts holds the money facts and the prices line behind them, so it takes the full band. The daily
    // cost bars sit beside Breakdowns over Efficiency (lab d2views-COST 2-up), so the chart's plot takes that
    // column's height rather than a short list's; Plan fit and Outcomes follow as their own bands.
    costs: [{ width: 'full', widgets: [w('usage_cost_facts', 'full', { metric: 'cost' }), w('usage_daily', 'tall', { metric: 'cost' }),
        w('usage_breakdowns', 'medium', { metric: 'cost', breakdown: ['agent'] }), w('usage_efficiency', 'medium', { metric: 'cost' }),
        w('usage_plan_fit', 'full', { metric: 'cost' }), w('usage_outcomes', 'full', { metric: 'cost' })] }],
    work: [{ width: 'full', widgets: [w('usage_project_ledger', 'large'), w('usage_session_value', 'tall'), w('usage_outcomes', 'tall')] }],
    // Daily beside the model breakdown; Efficiency is one compact band, so a period without a basis
    // costs a line, never a tall empty cell beside the chart.
    usage: [{ width: 'full', widgets: [w('usage_daily', 'tall'), w('usage_breakdowns', 'tall', { breakdown: ['model'] }),
        w('usage_efficiency', 'wide'), w('usage_flow', 'full'), w('usage_breakdowns', 'full', { breakdown: ['machine'] })] }],
    // Projections and Plan fit stack beside the longer Resets list: a short projection list never leaves a
    // tall empty column.
    plans: [{ width: 'full', widgets: [w('usage_capacity', 'full'), w('usage_projections', 'medium'), w('usage_resets', 'tall'),
        w('usage_plan_fit', 'medium')] }],
    coach: [{ width: 'full', widgets: [w('usage_coach', 'large')] }],
    'how-you-work': [{ width: 'full', widgets: [w('usage_rhythm', 'full'), w('usage_parallel', 'full'), w('usage_human_loop', 'medium'),
        w('usage_night_shift', 'medium'), w('usage_recap', 'large')] }],
    sources: [{ width: 'full', widgets: [w('usage_sources', 'large'), w('usage_source_coverage', 'medium'), w('usage_unpriced', 'medium')] }],
};

/** Portable fragments have no placement identities; the platform allocates each host occurrence. */
export function createUsageWidgetPresetFragments(names: Readonly<Record<UsageWidgetPresetId, string>>, options?: Readonly<{ initialMetric?: UsageQuery['metric'] }>):
    Readonly<Record<UsageWidgetPresetId, readonly WidgetLayoutFragmentDraftV1[]>> {
    const fragments: Partial<Record<UsageWidgetPresetId, readonly WidgetLayoutFragmentDraftV1[]>> = {};
    for (const id of USAGE_WIDGET_PRESET_IDS) fragments[id] = arrangements[id].map((arrangement): WidgetLayoutFragmentDraftV1 => {
        const group: WidgetLayoutFragmentGroupV1 = {
            width: arrangement.width, frameStyle: 'card', dividers: 'hairline',
            children: arrangement.widgets.map(widget => ({ kind: 'widget', size: widget.size,
                frameStyle: 'plain', instance: { v: 1, definition: { kind: 'builtin', id: widget.id }, bindings: {
                    ...Object.fromEntries(readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: widget.id })!.inputs!.fields
                        .filter(field => field.contextMode === 'follow').map(field => [field.path, { kind: 'context' as const, slot: field.path }])),
                    // Legacy routes open Overview. Their presentation seed must
                    // not replace the independent defaults of other named views.
                    ...Object.fromEntries(readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: widget.id })!.inputs!.fields
                        .filter(field => field.contextMode === 'own').map(field => [field.path, { kind: 'value' as const,
                            value: field.path === 'metric' ? (id === 'overview' ? options?.initialMetric : undefined) ?? widget.metric ?? 'tokens'
                                : [...(widget.breakdown ?? [])] }])),
                } } })),
        };
        const applicableScopes = scopes.filter(field => group.children.some(child => Object.hasOwn(child.instance.bindings, field.path)));
        return { name: names[id], inputs: { fields: applicableScopes.map(field => ({ ...field, required: true })) }, inputSchema: scopeSchema(), group };
    });
    return fragments as Record<UsageWidgetPresetId, readonly WidgetLayoutFragmentDraftV1[]>;
}

/** Host metadata is localized by the mounted page, never read from a caller's layout input. */
export function createUsageWidgetPresets(names: Readonly<Record<UsageWidgetPresetId, string>> = defaultNames, options?: Readonly<{ initialMetric?: UsageQuery['metric'] }>): readonly WidgetAreaPresetV1[] {
    const fragments = createUsageWidgetPresetFragments(names, options);
    return USAGE_WIDGET_PRESET_IDS.map(id => ({ id, name: names[id], items: fragments[id].map((fragment, index) =>
        instantiateWidgetLayoutFragmentGroupV1(fragment.group, { groupId: `${id}:group:${index}`,
            childIds: fragment.group.children.map((_, child) => `${id}:group:${index}:widget:${child}`) })) }));
}
