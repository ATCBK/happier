import * as React from 'react';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import { readBuiltinWidgetDescriptorV1, proposeWidgetInputDefaultBindingsV1 } from '@happier-dev/protocol/widgets';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import {
  getUsageQueryKey,
  normalizeUsageQuery,
  normalizeUsageQueryBatchInput,
  type UsageQuery,
} from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { useAuth } from '@/auth/context/AuthContext';
import { decodeUsageQueryResource } from '@/sync/api/account/usageQueryResource';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { UsageWidgetQueryPlan } from '../usageWidgetQueries';
import {
  resolveUsageWidgetPageInitialQuery,
  type UsageWidgetQueryOverrides,
} from '../usageWidgetPageContext';
import {
  useUsageWidgetBodyModel,
  useUsageWidgetResource,
  type UsageWidgetBodyModel,
  type UsageWidgetResource,
} from '../useUsageWidgetResource';

type Registration = Readonly<{ query: UsageQuery; key: string }>;
type UsageQueryWidgetId = Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'>;
// Each body declares its accounting and private-evidence demand here. Capacity
// consumes B quota/selection only; other bodies retain their A projection.
const USAGE_WIDGET_DEMAND = {
  usage_daily: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_period_summary: { includeSessionEvidence: true, includeWorkEvidence: true },
  usage_cost_facts: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_flow: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_efficiency: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_breakdowns: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_capacity: { includeAccounting: false, includeQuotaHistory: false, includeSessionEvidence: false, includeWorkEvidence: false },
  usage_projections: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_resets: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_plan_fit: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_project_ledger: { includeSessionEvidence: false, includeWorkEvidence: true },
  usage_session_value: { includeSessionEvidence: false, includeWorkEvidence: true },
  usage_outcomes: { includeSessionEvidence: false, includeWorkEvidence: true },
  usage_coach: { includeSessionEvidence: true, includeTranscriptEvidence: true, includeWorkEvidence: false },
  // Rhythm's declared default metric is Busy time, which only witnessed intervals can answer.
  usage_rhythm: { includeSessionEvidence: true, includeWorkEvidence: false },
  usage_parallel: { includeSessionEvidence: true, includeWorkEvidence: false },
  usage_human_loop: { includeSessionEvidence: true, includeTranscriptEvidence: true, includeWorkEvidence: false },
  usage_night_shift: { includeSessionEvidence: true, includeWorkEvidence: false },
  usage_recap: { includeSessionEvidence: true, includeTranscriptEvidence: true, includeWorkEvidence: true },
  usage_footprint: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_source_coverage: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_unpriced: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_score: { includeSessionEvidence: true, includeWorkEvidence: false },
  usage_orbit: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_constellation: { includeSessionEvidence: true, includeTranscriptEvidence: true, includeWorkEvidence: false },
  usage_planet: { includeSessionEvidence: true, includeWorkEvidence: false },
  usage_run_length: { includeSessionEvidence: true, includeWorkEvidence: false },
  usage_atmosphere: { includeAccounting: false, includeSessionEvidence: true, includeWorkEvidence: false },
  // Kind evidence and owner-selected public links are unavailable in a private Usage query.
  // Offering these bodies must not hydrate private Session/SCM data to invent either fact.
  usage_machines: { includeAccounting: false, includeSessionEvidence: false, includeWorkEvidence: false },
  usage_projects: { includeAccounting: false, includeSessionEvidence: false, includeWorkEvidence: false },
} satisfies Record<UsageQueryWidgetId, Readonly<{ includeAccounting?: boolean; includeQuotaHistory?: boolean; includeSessionEvidence: boolean; includeTranscriptEvidence?: boolean; includeWorkEvidence: boolean }>>;
type UsageWidgetBatch = Readonly<{
  clauses: UsageWidgetQueryOverrides;
  register(id: string, registration: Registration): () => void;
  resource: UsageWidgetResource;
  inventoryKey: string | null;
}>;

const UsageWidgetBatchContext = React.createContext<UsageWidgetBatch | null>(
  null,
);

/** A setup preview belongs to its destination, independently of the page beneath it. */
export function UsageWidgetBatchBoundary(props: Readonly<{ children: React.ReactNode }>) {
  return <UsageWidgetBatchContext.Provider value={null}>{props.children}</UsageWidgetBatchContext.Provider>;
}

/**
 * One plan from the bodies' own platform-resolved inputs. The widget binder has already applied each
 * widget's value → group → page precedence; this only keys and batches the resulting queries.
 */
export function buildUsageWidgetQueryPlan(
  scope: ServerAccountScope | null,
  rows: ReadonlyMap<string, Registration>,
  inventoryQuery?: UsageQuery,
): UsageWidgetQueryPlan {
  const widgets = new Map(
    [...rows].map(([id, row]) => [
      id,
      {
        resolution: { status: 'ready' as const, input: {} },
        query: row.query,
        key: row.key,
      },
    ]),
  );
  const queries = [...rows.values()].map((row) => row.query);
  if (inventoryQuery) queries.push(inventoryQuery);
  return {
    scope: scope ?? { serverId: '', accountId: '' },
    input:
      scope && queries.length
        ? normalizeUsageQueryBatchInput({ queries })
        : null,
    widgets,
  };
}

/** Mounted by a page that shows several Usage widgets: their distinct requests travel in one `usage.query`. */
export function UsageWidgetBatchProvider(
  props: Readonly<{
    clauses: UsageWidgetQueryOverrides;
    inventoryQuery?: UsageQuery;
    children: React.ReactNode;
  }>,
) {
  const auth = useAuth();
  const viewer = useActiveServerAccountScope();
  const [rows, setRows] = React.useState<ReadonlyMap<string, Registration>>(
    () => new Map(),
  );
  const register = React.useCallback(
    (id: string, registration: Registration) => {
      setRows((current) =>
        current.get(id)?.key === registration.key
          ? current
          : new Map(current).set(id, registration),
      );
      return () =>
        setRows((current) => {
          if (current.get(id) !== registration) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
    },
    [],
  );
  const scope = React.useMemo(
    () =>
      viewer
        ? { serverId: viewer.serverId, accountId: viewer.accountId }
        : null,
    [viewer?.serverId, viewer?.accountId],
  );
  // Filter choices consume accounting membership, never private work detail.
  const inventoryQuery = React.useMemo(() => props.inventoryQuery
    ? normalizeUsageQuery({ ...props.inventoryQuery, includeSessionEvidence: false, includeWorkEvidence: false }) : undefined, [props.inventoryQuery]);
  const plan = React.useMemo(
    () => buildUsageWidgetQueryPlan(scope, rows, inventoryQuery),
    [scope, rows, inventoryQuery],
  );
  const resource = useUsageWidgetResource({
    credentials: auth.credentials,
    enabled: auth.credentials != null,
    plan,
  });
  const value = React.useMemo(
    () => ({ clauses: props.clauses, register, resource, inventoryKey: inventoryQuery ? getUsageQueryKey(inventoryQuery) : null }),
    [props.clauses, inventoryQuery, register, resource],
  );
  return (
    <UsageWidgetBatchContext.Provider value={value}>
      {props.children}
    </UsageWidgetBatchContext.Provider>
  );
}

function readStandaloneClauses(): UsageWidgetQueryOverrides {
  const query = resolveUsageWidgetPageInitialQuery({
    nowMs: Date.now(),
    timeZoneOffsetMinutes: -new Date().getTimezoneOffset(),
  });
  const {
    period: _p,
    agents: _a,
    machines: _m,
    projects: _pr,
    sources: _s,
    session: _se,
    costBasis: _c,
    metric: _me,
    breakdown: _b,
    ...clauses
  } = query;
  return clauses;
}

function resolveQuery(
  clauses: UsageWidgetQueryOverrides,
  input: Readonly<Record<string, JsonValue>>,
  widgetId: UsageQueryWidgetId,
): Registration | null {
  try {
    const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: widgetId })!;
    const defaults = proposeWidgetInputDefaultBindingsV1(descriptor);
    // The platform has already bound scope. Only own presentation defaults belong here;
    // never let a descriptor's empty scope defaults replace a page or group pin.
    const ownDefaults: Record<string, JsonValue> = Object.fromEntries(descriptor.inputs!.fields.flatMap(field => {
      const binding = field.contextMode === 'own' ? defaults[field.path] : undefined;
      return binding?.kind === 'value' ? [[field.path, binding.value]] : [];
    }));
    const resolvedInput: Record<string, JsonValue> = { ...ownDefaults, ...input };
    const effective = new Set(resolveEffectiveInputFields({ inputHints: descriptor.inputs }, resolvedInput).map(field => field.path));
    // Defaults may not resurrect an own input the platform has made non-applicable for this Style.
    // Scope pins still belong to the binder and are never pruned or re-defaulted here.
    for (const field of descriptor.inputs!.fields) if (field.contextMode === 'own' && !effective.has(field.path)) delete resolvedInput[field.path];
    const { style: _style, colourBy: _colourBy, day: _day, ...queryInput } = resolvedInput;
    // This widget bundle consumes both the calendar and weekday/hour facts, irrespective of partial route read clauses.
    // Direct usage.query callers retain their explicit includeActivity/activityResolution semantics.
    const singleSession = typeof input.session === 'string' && input.session.length > 0
      || Array.isArray(input.session) && input.session.length === 1;
    // The Work autopsy renders only for one selected Session. The aggregate
    // Session-value plot/rows consume allocation facts, not private transcripts.
    const autopsy = widgetId === 'usage_session_value' && singleSession;
    const rhythmMetric = queryInput.metric ?? 'tokens';
    const query = normalizeUsageQuery({ ...clauses, ...queryInput, includeActivity: true, activityResolution: 'both', includeAccounting: true,
      includeTranscriptEvidence: false,
      ...USAGE_WIDGET_DEMAND[widgetId],
      ...(typeof queryInput.includeQuotaHistory === 'boolean' ? { includeQuotaHistory: queryInput.includeQuotaHistory } : {}),
      ...(widgetId === 'usage_rhythm' ? {
        includeSessionEvidence: rhythmMetric !== 'tokens' && rhythmMetric !== 'cost',
        includeTranscriptEvidence: rhythmMetric === 'steering',
      } : {}),
      ...(autopsy ? { includeSessionEvidence: true, includeTranscriptEvidence: true } : {}),
    });
    return { query, key: getUsageQueryKey(query) };
  } catch {
    return null;
  }
}

/**
 * The one way a Usage body reads facts. On the Usage page it joins the page batch; elsewhere (Home,
 * a Project) it reads its own single-query batch through the same Resource store and decode path.
 */
export function useUsageWidgetModel(
  input: Readonly<Record<string, JsonValue>>,
  widgetId: UsageQueryWidgetId,
): Readonly<{
  model: UsageWidgetBodyModel;
  query: UsageQuery | null;
}> {
  const batch = React.useContext(UsageWidgetBatchContext);
  const auth = useAuth();
  const viewer = useActiveServerAccountScope();
  const id = React.useId();
  const [standaloneClauses] = React.useState(readStandaloneClauses);
  const clauses = batch?.clauses ?? standaloneClauses;
  const inputKey = JSON.stringify(input);
  const registration = React.useMemo(
    () => resolveQuery(clauses, input, widgetId),
    [clauses, inputKey, widgetId],
  );
  const register = batch?.register;
  React.useLayoutEffect(
    () => (registration && register ? register(id, registration) : undefined),
    [register, id, registration],
  );
  const scope = React.useMemo(
    () =>
      viewer
        ? { serverId: viewer.serverId, accountId: viewer.accountId }
        : null,
    [viewer?.serverId, viewer?.accountId],
  );
  const ownPlan = React.useMemo(
    () =>
      buildUsageWidgetQueryPlan(
        batch ? null : scope,
        registration ? new Map([[id, registration]]) : new Map(),
      ),
    [batch, scope, registration, id],
  );
  const own = useUsageWidgetResource({
    credentials: auth.credentials,
    enabled: !batch && auth.credentials != null,
    plan: ownPlan,
  });
  const model = useUsageWidgetBodyModel(batch?.resource ?? own, id);
  return { model, query: registration?.query ?? null };
}

const EMPTY_RESULTS: readonly UsageQueryResultSlice[] = Object.freeze([]);

/**
 * The page batch's decoded slices for page chrome (filter options, freshness line). It reads the same
 * Resource entry the widgets read and adds no request of its own; outside a page it is empty.
 */
function useDecodedUsageWidgetBatchSlices(demand = false): readonly UsageQueryResultSlice[] {
    const batch = React.useContext(UsageWidgetBatchContext);
    const entry = batch?.resource.entry ?? null;
    const subscribe = React.useCallback((listener: () => void) => entry?.subscribe(listener, demand) ?? (() => {}), [entry, demand]);
    const getSnapshot = React.useCallback(() => entry?.getSnapshot().value, [entry]);
    const value = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return React.useMemo(() => {
        if (!value || batch?.resource.lifetime?.isCurrent() !== true) return EMPTY_RESULTS;
        try { return decodeUsageQueryResource(value).results; } catch { return EMPTY_RESULTS; }
    }, [value, batch?.resource.lifetime]);
}

/** Only mounted widget results feed page totals and freshness; inventory is not a displayed total. */
export function useUsageWidgetBatchSlices(): readonly UsageQueryResultSlice[] {
    const batch = React.useContext(UsageWidgetBatchContext);
    const slices = useDecodedUsageWidgetBatchSlices();
    return React.useMemo(() => slices.filter(slice => [...(batch?.resource.plan.widgets.values() ?? [])].some(widget => widget.key === slice.key)), [slices, batch?.resource.plan]);
}

/** Unnarrowed choices share the page's canonical request, lifetime, decode and Resource owner. */
export function useUsageWidgetBatchInventorySlice(): UsageQueryResultSlice | undefined {
    const batch = React.useContext(UsageWidgetBatchContext);
    return useDecodedUsageWidgetBatchSlices(true).find(slice => slice.key === batch?.inventoryKey);
}

export function useUsageWidgetPageHasCoverageDetail(): boolean {
    const batch = React.useContext(UsageWidgetBatchContext);
    // Coverage belongs to the page from its first frame, including the time
    // before its inventory responds. Loading does not transfer it to a body.
    return batch !== null;
}
