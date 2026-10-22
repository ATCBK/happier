import { PublicProfilePolicyV1Schema, PublicProfileSnapshotV1Schema, PublicProfileMetadataV1Schema, PublicProfileIdentityV1Schema,
  type PublicProfilePolicyV1, type PublicProfileSnapshotV1, type PublicProfileField, type PublicUsageFactsV1,
  type PublicProfileMetadataV1, type PublicProfileIdentityV1 } from './publicProfile.js';
import { PublicProfileViewV1Schema, type PublicProfileViewV1, type PublicProfileContextV1, type PublicProfileAppearanceV1,
  type PublicProfilePreparedAppearanceV1, PublicProfileLocalPreviewViewV1Schema,
  type PublicProfileLocalPreviewViewV1 } from './publicProfilePublication.js';
import { PublicProfileLayoutV1Schema, type PublicProfileLayoutV1, type WidgetPublicSnapshotDocumentV1 } from '../widgets/widgetPublicSnapshotV1.js';
import { zodSchemaToJsonSchemaObject, type JsonSchemaObject } from '../actions/actionInputJsonSchema.js';
import { freezePluginDeclarativeDataNodeV1, isPluginDeclarativeDataNodeV1, validatePluginDeclarativeDataNodeFieldTypesV1, type PluginDeclarativeDataNodeV1,
  type PluginDeclarativeDataFieldV1 } from '../plugins/contributions/ui/declarativeDataV1.js';
import type { PluginDeclarativeNodeV2 } from '../plugins/contributions/ui/v2.js';
import type { BuiltinUsagePublicPresentationV1 } from '../widgets/builtinWidgetDescriptorV1.js';

const factFields = { tokens: 'tokens', activeDays: 'activeDays', agentTimeMs: 'agentTime', mergedPrs: 'mergedPrs',
  currentStreakDays: 'currentStreak', bestStreakDays: 'bestStreak', peakParallel: 'peakParallel', calendar: 'calendar',
  agentMix: 'agentMix', sourceSplit: 'sourceSplit', punch: 'punch', highlights: 'highlights', footprint: 'footprint',
  agentActiveDays: 'agentActiveDays', weeklyAgentMix: 'weeklyAgentMix', weeklyPeakParallel: 'weeklyPeakParallel',
  sessionDurations: 'sessionDurations', machineKinds: 'machineKinds', dayNightActivity: 'dayNightActivity',
} satisfies Record<keyof PublicUsageFactsV1, PublicProfileField>;

/** Dependencies belong to the disclosure owner, never to a block's asserted requirements. */
function enabled(policy: PublicProfilePolicyV1, field: PublicProfileField): boolean {
  return policy.fields[field] === true && (field !== 'weeklyPeakParallel' || policy.fields.peakParallel === true);
}
function projectFacts(facts: PublicUsageFactsV1, policy: PublicProfilePolicyV1): PublicUsageFactsV1 {
  const result = Object.fromEntries(Object.entries(facts).filter(([key]) => enabled(policy, factFields[key as keyof PublicUsageFactsV1]))) as PublicUsageFactsV1;
  if (!enabled(policy, 'tokens')) {
    if (result.agentMix) result.agentMix = result.agentMix.map(({ tokens: _tokens, ...entry }) => entry);
    if (result.sourceSplit) result.sourceSplit = result.sourceSplit.map(({ tokens: _tokens, ...entry }) => entry);
  }
  if (result.highlights) result.highlights = result.highlights.filter(highlight => enabled(policy,
    highlight.kind === 'active_days' ? 'activeDays' : highlight.kind === 'peak_parallel' ? 'peakParallel' : 'mergedPrs'));
  if (result.sessionDurations) result.sessionDurations = [...result.sessionDurations].sort((left, right) =>
    left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : left.durationMs - right.durationMs);
  return result;
}
/** Acceptance and reads both apply this mask, so late facts cannot restore narrowed consent. */
export function projectPublicProfileSnapshot(input: PublicProfileSnapshotV1, rawPolicy: PublicProfilePolicyV1): PublicProfileSnapshotV1 {
  const snapshot = PublicProfileSnapshotV1Schema.parse(input);
  const policy = PublicProfilePolicyV1Schema.parse(rawPolicy);
  const { lenses: _lenses, ...rest } = snapshot;
  return { ...rest, facts: projectFacts(snapshot.facts, policy),
    fieldCoverage: Object.fromEntries(Object.entries(snapshot.fieldCoverage).filter(([field]) => enabled(policy, field as PublicProfileField))),
    ...(enabled(policy, 'sourceSplit') && snapshot.lenses ? { lenses: snapshot.lenses.map(lens => ({ ...lens, facts: projectFacts(lens.facts, policy) })) } : {}),
  };
}
export function projectPublicProfileMetadata(input: PublicProfileMetadataV1, policy: PublicProfilePolicyV1): PublicProfileMetadataV1 {
  const metadata = PublicProfileMetadataV1Schema.parse(input);
  return Object.fromEntries(Object.entries(metadata).filter(([field]) => enabled(policy, field as PublicProfileField)));
}
export function projectPublicProfileIdentity(input: PublicProfileIdentityV1, policy: PublicProfilePolicyV1): PublicProfileIdentityV1 {
  const identity = PublicProfileIdentityV1Schema.parse(input);
  return { ...(enabled(policy, 'name') && identity.name !== undefined ? { name: identity.name } : {}),
    ...(enabled(policy, 'since') && identity.sinceMs !== undefined ? { sinceMs: identity.sinceMs } : {}),
    ...(enabled(policy, 'avatar') && identity.avatarUrl !== undefined ? { avatarUrl: identity.avatarUrl } : {}) };
}

function record(value: unknown): JsonSchemaObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonSchemaObject : undefined;
}
let bindingSchema: JsonSchemaObject | undefined;
function bindingRoot(): JsonSchemaObject {
  return bindingSchema ??= { type: 'object', properties: {
    snapshot: zodSchemaToJsonSchemaObject(PublicProfileSnapshotV1Schema),
    metadata: zodSchemaToJsonSchemaObject(PublicProfileMetadataV1Schema),
    identity: zodSchemaToJsonSchemaObject(PublicProfileIdentityV1Schema), handle: { type: 'string' },
  } };
}
function schemaAt(path: readonly string[]): JsonSchemaObject | undefined {
  let schema: JsonSchemaObject | undefined = bindingRoot();
  for (const key of path) schema = key === '*' ? record(schema?.items) : record(record(schema?.properties)?.[key]);
  return schema;
}
function permitted(path: readonly string[], policy: PublicProfilePolicyV1): boolean {
  if (path[0] === 'snapshot' && path[1] === 'lenses') {
    return enabled(policy, 'sourceSplit') && (path[2] !== '*' || permitted(['snapshot', ...path.slice(3)], policy));
  }
  if (path[0] === 'snapshot' && path[1] === 'facts') {
    const field = factFields[path[2] as keyof PublicUsageFactsV1];
    if (!field || !enabled(policy, field)) return false;
    if (path.slice(3).includes('tokens') && !enabled(policy, 'tokens')) return false;
  }
  if (path[0] === 'snapshot' && path[1] === 'fieldCoverage') return enabled(policy, path[2] as PublicProfileField);
  if (path[0] === 'identity') return enabled(policy, path[1] === 'sinceMs' ? 'since' : path[1] === 'avatarUrl' ? 'avatar' : 'name');
  if (path[0] === 'metadata') return enabled(policy, path[1] as PublicProfileField);
  return true;
}
/** Built-in bodies receive only masked facts; placements cannot grant their own disclosure. */
function permittedUsage(presentation: BuiltinUsagePublicPresentationV1, policy: PublicProfilePolicyV1): boolean {
  const any = (...fields: PublicProfileField[]) => fields.some(field => enabled(policy, field));
  switch (presentation.widgetId) {
    case 'usage_rhythm': return presentation.inputs.style === 'sky' || presentation.inputs.style === 'heatmap'
      ? enabled(policy, 'calendar') : presentation.inputs.style === 'daylight'
        ? any('punch', 'dayNightActivity') : enabled(policy, 'punch');
    case 'usage_daily': return enabled(policy, 'calendar');
    case 'usage_period_summary': return any('tokens', 'activeDays', 'agentTime', 'mergedPrs', 'currentStreak', 'bestStreak', 'peakParallel');
    case 'usage_breakdowns': return presentation.inputs.style === 'crew' ? any('agentMix', 'agentActiveDays') : any('agentMix', 'sourceSplit');
    case 'usage_constellation': case 'usage_orbit': return enabled(policy, 'agentMix');
    case 'usage_flow': return enabled(policy, 'weeklyAgentMix');
    case 'usage_parallel': return enabled(policy, 'peakParallel');
    case 'usage_outcomes': return enabled(policy, 'mergedPrs');
    case 'usage_recap': return presentation.inputs.style === 'personalRecords'
      ? any('activeDays', 'currentStreak', 'bestStreak', 'peakParallel', 'sessionDurations')
      : enabled(policy, 'highlights') && any('activeDays', 'peakParallel', 'mergedPrs');
    case 'usage_footprint': return enabled(policy, 'footprint');
    case 'usage_source_coverage': return any(...Object.values(factFields));
    case 'usage_run_length': return enabled(policy, 'sessionDurations');
    // Every encoding is independently masked; the neutral portrait carries no hidden fact.
    case 'usage_planet': return true;
  }
}
function assertField(field: PluginDeclarativeDataFieldV1, prefix: readonly string[] = []) {
  const schema = schemaAt([...prefix, ...field.path]);
  if (!schema || schema.type !== field.type && !(schema.type === 'integer' && field.type === 'number')) throw new Error('public_profile_binding_invalid');
}
function fields(node: PluginDeclarativeDataNodeV1): readonly PluginDeclarativeDataFieldV1[] {
  return node.kind === 'metric' ? [node.value, ...(node.comparison ? [node.comparison.value] : [])]
    : node.kind === 'chart' ? [node.x, ...('y' in node ? [node.y] : [node.series, node.value])]
    : [...node.columns.map(column => column.field), ...(node.mark ? [node.mark.field] : [])];
}
/** Field vocabulary and semantics remain here; admission delegates to this owner. */
export function validatePublicProfileDocumentBindings(document: WidgetPublicSnapshotDocumentV1): void {
  const pending = [document.root];
  while (pending.length) {
    const node = pending.pop()!;
    if (isPluginDeclarativeDataNodeV1(node)) {
      validatePluginDeclarativeDataNodeFieldTypesV1(node);
      if (node.kind !== 'metric' && schemaAt(node.rows)?.type !== 'array') throw new Error('public_profile_binding_invalid');
      for (const field of fields(node)) assertField(field, node.kind === 'metric' ? [] : [...node.rows, '*']);
    }
    if ('children' in node) pending.push(...node.children);
  }
}
/** Validate symbolic paths even when current facts are absent. */
export function validatePublicProfileLayout(input: PublicProfileLayoutV1): PublicProfileLayoutV1 {
  return PublicProfileLayoutV1Schema.parse(input);
}
function compileNode(node: PluginDeclarativeNodeV2, view: Readonly<{ snapshot: PublicProfileSnapshotV1; metadata: PublicProfileMetadataV1; identity: PublicProfileIdentityV1; handle: string }>, policy: PublicProfilePolicyV1): PluginDeclarativeNodeV2 | null {
  if (isPluginDeclarativeDataNodeV1(node)) {
    const prefix = node.kind === 'metric' ? [] : [...node.rows, '*'];
    if (node.kind !== 'metric' && !permitted(node.rows, policy)) return null;
    const allowed = (field: PluginDeclarativeDataFieldV1) => permitted([...prefix, ...field.path], policy);
    let selected = node;
    if (node.kind === 'table' || node.kind === 'rows') {
      const columns = node.columns.filter(column => allowed(column.field));
      if (!columns.length) return null;
      const { mark, ...rest } = node;
      selected = { ...rest, columns, ...(mark && allowed(mark.field) ? { mark } : {}) };
    } else if (node.kind === 'metric') {
      if (!allowed(node.value)) return null;
      const { comparison, ...rest } = node;
      selected = { ...rest, ...(comparison && allowed(comparison.value) ? { comparison } : {}) };
    } else if (fields(node).some(field => !allowed(field))) return null;
    try { return freezePluginDeclarativeDataNodeV1({ ...selected, data: { kind: 'value', value: view } }, view); }
    catch { return null; }
  }
  if (node.kind === 'stack' || node.kind === 'group') {
    const children = node.children.map(child => compileNode(child, view, policy)).filter((child): child is PluginDeclarativeNodeV2 => child !== null);
    return children.length ? { ...node, children } : null;
  }
  return node;
}
type PublicProfileProjectionInput = Readonly<{ context: PublicProfileContextV1; policy: PublicProfilePolicyV1;
  metadata: PublicProfileMetadataV1; snapshot: PublicProfileSnapshotV1; layout: PublicProfileLayoutV1 }>;
/** One compiler for current identity, consent, facts and inert placements in local and published views. */
function projectPublicProfileCore(input: PublicProfileProjectionInput): Omit<PublicProfileLocalPreviewViewV1, 'appearance'> | null {
  if (!input.context.handle) return null;
  const policy = PublicProfilePolicyV1Schema.parse(input.policy);
  const safe = { snapshot: projectPublicProfileSnapshot(input.snapshot, policy), metadata: projectPublicProfileMetadata(input.metadata, policy),
    identity: projectPublicProfileIdentity(input.context.identity, policy), handle: input.context.handle };
  const layout = validatePublicProfileLayout(input.layout);
  const projectWidget = (widget: Extract<PublicProfileLayoutV1['items'][number], { kind: 'widget' }>) => {
    if (widget.presentation.kind === 'usage') return permittedUsage(widget.presentation, policy) ? widget : null;
    const root = compileNode(widget.presentation.document.root, safe, policy);
    return root ? { ...widget, presentation: { kind: 'declarative' as const, document: { version: 1 as const, root } } } : null;
  };
  const items = layout.items.flatMap<PublicProfileViewV1['layout']['items'][number]>(item => {
    if (item.kind === 'widget') { const widget = projectWidget(item); return widget ? [widget] : []; }
    const children = item.children.map(projectWidget).filter(widget => widget !== null);
    return children.length ? [{ ...item, children }] : [];
  });
  return { v: 1, ...safe, indexable: policy.indexable, state: 'published', service: input.context.service,
    urls: input.context.urls, layout: { v: 1, items } };
}
/** Anonymous responses retain the strict applied/publication-reference-only representation. */
export function projectPublicProfile(input: PublicProfileProjectionInput & Readonly<{ appearance: PublicProfileAppearanceV1 }>): PublicProfileViewV1 | null {
  if (!input.context.service || !input.context.urls) return null;
  const view = projectPublicProfileCore(input);
  return view ? PublicProfileViewV1Schema.parse({ ...view, appearance: input.appearance }) : null;
}
/** The exact prepared pixels remain local; only Apply can turn them into a public publication reference. */
export function projectPublicProfilePreview(input: PublicProfileProjectionInput & Readonly<{ appearance: PublicProfilePreparedAppearanceV1 }>): PublicProfileLocalPreviewViewV1 | null {
  const view = projectPublicProfileCore(input);
  return view ? PublicProfileLocalPreviewViewV1Schema.parse({ ...view, appearance: input.appearance }) : null;
}
