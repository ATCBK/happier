import type {
  PluginFinalPolicyInput,
  PluginFinalPolicyTargetGenerationMode,
  PluginHostAccessRequestV2,
} from '@happier-dev/protocol';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';
import type { PluginRuntimeOccurrenceId } from '../runtimeSlots';
import type { PluginSourceCustody } from '../sourceAuthority';

export type PluginFinalPolicyCurrentRuntime = Readonly<{
  /** Exact process-local runtime occurrence whose declaration describes this operation. */
  occurrenceId: PluginRuntimeOccurrenceId;
  /** Durable provenance of the source that produced the occurrence. */
  sourceCustody: PluginSourceCustody;
  /** Current desired occurrence, absent only when this runtime is retired. */
  desiredOccurrenceId: PluginRuntimeOccurrenceId | null;
  /** Occurrence actually applied to this operation's active runtime. */
  appliedOccurrenceId: PluginRuntimeOccurrenceId | null;
  /** Whether this exact occurrence is currently applied. */
  applied: boolean;
  selectedAccess: readonly SelectedPluginAccess[];
}>;

export type SelectedPluginAccess = PluginAccessSelection;

export type PluginFinalPolicyAuthorizationFacts = Pick<
  PluginFinalPolicyInput,
  | 'generation'
  | 'resourceSelections'
  | 'scopedGrants'
  | 'operatingSystemAuthorization'
>;

function fixedNetworkOrigins(scope: unknown): readonly string[] {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return Object.freeze([]);
  const targets = (scope as Readonly<Record<string, unknown>>).targets;
  if (!Array.isArray(targets)) return Object.freeze([]);
  return Object.freeze(targets.flatMap((target) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return [];
    const record = target as Readonly<Record<string, unknown>>;
    return record.kind === 'fixedOrigin' && typeof record.origin === 'string'
      ? [record.origin]
      : [];
  }));
}

/** Network disclosure is required manifest configuration, never an optional host-resource grant. */
export function resolveRequiredPluginNetworkOrigins(params: Readonly<{
  required: readonly PluginHostAccessRequestV2[];
}>): readonly string[] {
  const requiredOrigins = params.required.flatMap((request) => (
    request.capability === 'network' ? fixedNetworkOrigins(request.scope) : []
  ));
  return Object.freeze([...new Set(requiredOrigins)].sort());
}

/**
 * Materializes direct runtime currentness and independently owned authorization facts
 * once for every final-policy consumer. It deliberately does not decide action
 * surfaces/danger or Voice pack/license/resource semantics.
 */
export function resolvePluginFinalPolicyAuthorizationFacts(params: Readonly<{
  pluginId: string;
  current: PluginFinalPolicyCurrentRuntime | null;
  /** Declaration reads use the selected occurrence; execution requires application. */
  purpose?: 'declaration';
  targetGenerationMode?: Exclude<PluginFinalPolicyTargetGenerationMode, 'declared'>;
  resourceSelections?: PluginFinalPolicyAuthorizationFacts['resourceSelections'];
  scopedGrants?: PluginFinalPolicyAuthorizationFacts['scopedGrants'];
  operatingSystemAuthorization?: PluginFinalPolicyAuthorizationFacts['operatingSystemAuthorization'];
}>): PluginFinalPolicyAuthorizationFacts {
  const targetGeneration = params.current?.occurrenceId
    ?? `uncommitted:${params.pluginId}`;
  const desiredGeneration = params.current?.desiredOccurrenceId ?? null;
  const appliedGeneration = params.current?.appliedOccurrenceId ?? null;

  return Object.freeze({
    generation: Object.freeze({
      targetGeneration,
      desiredGeneration,
      appliedGeneration,
      targetGenerationMode: params.purpose === 'declaration' ? 'declared' : params.targetGenerationMode ?? 'current',
    }),
    resourceSelections: Object.freeze([...(params.resourceSelections ?? [])]),
    scopedGrants: Object.freeze([...(params.scopedGrants ?? [])]),
    operatingSystemAuthorization: Object.freeze([...(params.operatingSystemAuthorization ?? [])]),
  });
}
