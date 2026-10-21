import {
  ConnectedAccountUiProjectionEntryV1Schema,
  type ConnectedAccountUiProjectionEntryV1,
} from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import type { DaemonContributionRegistryProjection } from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import { resolveFleetReadState, resolveFleetSupplyAgreement } from '@/sync/domains/machines/administration/fleetUnion';

export type ConnectedAccountDescriptorProjectionErrorReason =
  | 'unsupported'
  | 'malformed'
  | 'transport'
  | 'partial_machine_failure';

export type ConnectedAccountDescriptorMachineProjection =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{
      kind: 'ready';
      descriptors: readonly ConnectedAccountUiProjectionEntryV1[];
      /** Static declarations remain visible when Administration withdraws execution. */
      executionUnavailablePluginIds?: readonly string[];
    }>
  | Readonly<{ kind: 'error'; reason: ConnectedAccountDescriptorProjectionErrorReason }>;

export type ConnectedAccountDescriptorProjectionConflict =
  | Readonly<{
      kind: 'identity_divergence';
      descriptorIdentity: string;
      serviceIds: readonly ConnectedAccountUiProjectionEntryV1['serviceId'][];
    }>
  /**
   * Compatibility input for a projection produced before Connected Account
   * services were qualified. A local id is no longer an ownership key, so the
   * UI registry deliberately does not use this fact to disable either owner.
   */
  | Readonly<{
      kind: 'service_ownership';
      serviceId: ConnectedAccountUiProjectionEntryV1['serviceId'];
      descriptorIdentities: readonly string[];
    }>;

export type ConnectedAccountDescriptorProjectionResolution =
  | Readonly<{
      kind: 'loading' | 'ready' | 'conflict';
      descriptors: readonly ConnectedAccountUiProjectionEntryV1[];
      conflicts: readonly ConnectedAccountDescriptorProjectionConflict[];
    }>
  | Readonly<{
      kind: 'error';
      reason: ConnectedAccountDescriptorProjectionErrorReason;
      /**
       * Facts the machines that DID answer reported. A degraded read is not
       * authoritative for absence: refresh answered identities while retaining
       * unanswered services for display.
       */
      descriptors?: readonly ConnectedAccountUiProjectionEntryV1[];
      conflicts?: readonly ConnectedAccountDescriptorProjectionConflict[];
    }>;

export type ConnectedAccountDescriptorProjectionState = Readonly<{
  scopeKey: string;
  status: 'loading' | 'ready' | 'stale' | 'error' | 'conflict';
  descriptors: readonly ConnectedAccountUiProjectionEntryV1[];
  /**
   * Current answering identities, distinct from retained display descriptors.
   * Complete ready/conflict snapshots may omit this fact: every descriptor is answered.
   */
  answeredDescriptorIdentities?: readonly string[];
  conflicts: readonly ConnectedAccountDescriptorProjectionConflict[];
  errorReason: ConnectedAccountDescriptorProjectionErrorReason | null;
}>;

export function readConnectedAccountDescriptorProjection(
  projection: DaemonContributionRegistryProjection | null,
): ConnectedAccountDescriptorMachineProjection {
  if (!projection) return { kind: 'error', reason: 'unsupported' };
  const family = projection.familiesById.connectedAccounts;
  if (!family) return { kind: 'ready', descriptors: [] };

  const descriptors: ConnectedAccountUiProjectionEntryV1[] = [];
  for (const entry of Object.values(family.entriesById)) {
    const parsed = ConnectedAccountUiProjectionEntryV1Schema.safeParse(entry);
    if (!parsed.success) return { kind: 'error', reason: 'malformed' };
    descriptors.push(parsed.data);
  }
  return { kind: 'ready', descriptors };
}

function connectedAccountDescriptorIdentity(entry: ConnectedAccountUiProjectionEntryV1): string {
  return `${entry.pluginId ?? 'first_party'}\u0000${entry.id}`;
}

function descriptorFingerprint(entry: ConnectedAccountUiProjectionEntryV1): string {
  // Diagnostics describe one machine's runtime, not the Account declaration.
  // In particular, an External Sessions refusal cannot change its auth modes.
  const { diagnostics, ...declaration } = entry;
  return JSON.stringify(declaration);
}

/**
 * Deterministic fail-closed union for the account-wide settings surface. Equal facts collapse.
 * Divergent candidates are retained with explicit conflict facts so the registry can keep every
 * affected service visible without making any candidate executable.
 */
export function mergeConnectedAccountDescriptorProjections(
  projections: readonly ConnectedAccountDescriptorMachineProjection[],
): ConnectedAccountDescriptorProjectionResolution {
  const answering = projections.filter((projection) => projection.kind === 'ready');
  // A pending read, or a retrying transport beside an answering machine, is
  // incomplete knowledge. The per-machine reader owns retry and settlement.
  const readState = resolveFleetReadState(projections.map((projection) => projection.kind === 'ready' ? 'current'
    : projection.kind === 'loading' ? 'resolving' : projection.reason === 'transport' ? 'transportFailure' : 'failed'));
  if (readState === 'resolving') {
    return { ...unionReadyConnectedAccountDescriptorProjections(answering), kind: 'loading' };
  }
  if (readState === 'failed') {
    if (answering.length === 0) {
      return {
        kind: 'error',
        reason: projections.find((projection) => projection.kind === 'error')?.reason ?? 'transport',
      };
    }
    // The union of the machines that answered is still a fact. Carry it so a
    // cold read that hits one failing machine degrades to `stale` with real
    // descriptors instead of collapsing to "no Connected Account exists".
    const partial = unionReadyConnectedAccountDescriptorProjections(answering);
    return {
      kind: 'error',
      reason: 'partial_machine_failure',
      descriptors: partial.descriptors,
      conflicts: partial.conflicts,
    };
  }

  return unionReadyConnectedAccountDescriptorProjections(projections);
}

function unionReadyConnectedAccountDescriptorProjections(
  projections: readonly ConnectedAccountDescriptorMachineProjection[],
): Extract<ConnectedAccountDescriptorProjectionResolution, { descriptors: readonly ConnectedAccountUiProjectionEntryV1[] }> {
  const supplies = projections.flatMap((projection) => projection.kind !== 'ready' ? [] : projection.descriptors.map((entry) => {
      // Occurrences identify one machine's live runtime slot, not an Account
      // declaration. Keep them on raw machine publications, never in this union.
      let descriptor = entry;
      if (entry.occurrenceId !== undefined) {
        const { occurrenceId, ...declaration } = entry;
        descriptor = declaration;
      }
      return { value: descriptor, selectable: !descriptor.pluginId
        || !projection.executionUnavailablePluginIds?.includes(descriptor.pluginId) };
  }));
  const executableIdentities = new Set(supplies.filter(supply => supply.selectable)
    .map(supply => connectedAccountDescriptorIdentity(supply.value)));
  // Prefer admitted declarations for execution/conflict decisions. With no
  // admitted supply, retain descriptive identity through the same union, but
  // never let that declaration make the registry executable.
  const visibleSupplies = supplies.map(supply => {
    const descriptiveOnly = !supply.selectable && !executableIdentities.has(connectedAccountDescriptorIdentity(supply.value));
    return descriptiveOnly ? {
      selectable: true,
      value: supply.value.availability.state === 'available' ? { ...supply.value,
        availability: { state: 'blocked' as const, reason: 'execution_origin_unavailable' },
      } : supply.value,
    } : supply;
  });
  const { variantsByIdentity, conflictingIdentities } = resolveFleetSupplyAgreement({ supplies: visibleSupplies,
    identity: connectedAccountDescriptorIdentity, content: descriptorFingerprint });

  // Preserve every answering supplier's diagnostics without making them a
  // competing declaration. Excluded execution supplies cannot alter this view.
  const diagnosticsByFingerprint = new Map<string, Set<string>>();
  for (const supply of visibleSupplies) {
    if (!supply.selectable) continue;
    const fingerprint = descriptorFingerprint(supply.value);
    const diagnostics = diagnosticsByFingerprint.get(fingerprint) ?? new Set<string>();
    for (const diagnostic of supply.value.diagnostics) diagnostics.add(diagnostic);
    diagnosticsByFingerprint.set(fingerprint, diagnostics);
  }

  const descriptors = [...variantsByIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, variants]) => [...variants.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fingerprint, entry]) => {
        const diagnostics = [...diagnosticsByFingerprint.get(fingerprint)!].sort();
        return equalFacts(entry.diagnostics, diagnostics) ? entry : { ...entry, diagnostics };
      }));

  const conflicts: ConnectedAccountDescriptorProjectionConflict[] = [];
  for (const identity of [...conflictingIdentities].sort((left, right) => left.localeCompare(right))) {
    const variants = variantsByIdentity.get(identity)!;
    const serviceIds = [...new Set([...variants.values()].map((entry) => entry.serviceId))]
      .sort((left, right) => left.localeCompare(right));
    conflicts.push({ kind: 'identity_divergence', descriptorIdentity: identity, serviceIds });
  }

  return {
    kind: conflicts.length > 0 ? 'conflict' : 'ready',
    descriptors,
    conflicts,
  };
}

export function createConnectedAccountDescriptorProjectionLoadingState(
  scopeKey: string,
): ConnectedAccountDescriptorProjectionState {
  return { scopeKey, status: 'loading', descriptors: [], answeredDescriptorIdentities: [], conflicts: [], errorReason: null };
}

function equalFacts(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function advanceConnectedAccountDescriptorProjectionState(
  previous: ConnectedAccountDescriptorProjectionState,
  resolution: ConnectedAccountDescriptorProjectionResolution,
): ConnectedAccountDescriptorProjectionState {
  // Incomplete coverage refreshes answered facts but cannot prove another
  // service disappeared. Retained presentation never supplies admission.
  const answeredDescriptors = resolution.descriptors ?? [];
  const answeredIdentities = new Set(answeredDescriptors.map(connectedAccountDescriptorIdentity));
  const nextAnsweredDescriptorIdentities = [...answeredIdentities];
  const answeredDescriptorIdentities = equalFacts(previous.answeredDescriptorIdentities ?? [], nextAnsweredDescriptorIdentities)
    ? previous.answeredDescriptorIdentities ?? nextAnsweredDescriptorIdentities
    : nextAnsweredDescriptorIdentities;
  const incomplete = resolution.kind === 'loading' || resolution.kind === 'error';
  const nextDescriptors = incomplete
    ? [...answeredDescriptors, ...previous.descriptors.filter((descriptor) => (
      !answeredIdentities.has(connectedAccountDescriptorIdentity(descriptor))
    ))]
    : answeredDescriptors;
  const nextConflicts = incomplete
    ? [...(resolution.conflicts ?? []), ...previous.conflicts.filter((conflict) => (
      conflict.kind !== 'identity_divergence' || !answeredIdentities.has(conflict.descriptorIdentity)
    ))]
    : resolution.conflicts;
  const descriptors = equalFacts(previous.descriptors, nextDescriptors)
    ? previous.descriptors
    : nextDescriptors;
  const conflicts = equalFacts(previous.conflicts, nextConflicts)
    ? previous.conflicts
    : nextConflicts;
  const status = resolution.kind === 'error'
    ? descriptors.length > 0 ? 'stale' : 'error'
    : resolution.kind;
  const errorReason = resolution.kind === 'error' ? resolution.reason : null;
  if (
    previous.status === status
    && previous.errorReason === errorReason
    && previous.descriptors === descriptors
    && previous.conflicts === conflicts
    && previous.answeredDescriptorIdentities === answeredDescriptorIdentities
  ) {
    return previous;
  }
  return { ...previous, status, descriptors, answeredDescriptorIdentities, conflicts, errorReason };
}
