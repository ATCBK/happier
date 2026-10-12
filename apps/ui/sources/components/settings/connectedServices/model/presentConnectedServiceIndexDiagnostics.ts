import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ConnectedAccountDescriptorProjectionErrorReason } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { t } from '@/text';

type IndexDiagnosticsPresentation = Readonly<{
  primary: string | null;
  supportDetails: string | null;
}>;

const MAX_SUPPORT_DETAILS = 4;

// These are failed registry reads, not failed account mutations. Each bounded
// read outcome uses the existing account-preserving read notice, including a
// malformed or unsupported machine response; none claims a change was sent.
const REGISTRY_READ_FAILURE_COPY = {
  unsupported: 'connectedServicesSettings.projectionErrorDescription',
  malformed: 'connectedServicesSettings.projectionErrorDescription',
  transport: 'connectedServicesSettings.projectionErrorDescription',
  partial_machine_failure: 'connectedServicesSettings.projectionErrorDescription',
} as const satisfies Record<ConnectedAccountDescriptorProjectionErrorReason, string>;

export function presentConnectedServiceRegistryReadFailure(reason: ConnectedAccountDescriptorProjectionErrorReason | null): string {
  return t((reason ? REGISTRY_READ_FAILURE_COPY[reason] : null) ?? 'connectedServicesSettings.projectionErrorDescription');
}

export function presentConnectedServiceIndexDiagnosticCopy(code: string): string {
  if (code === 'missing_runtime') return t('connectedServicesSettings.runtimeNotLoaded');
  // Registry diagnostics are read facts, including unknown boundary codes.
  // Never reinterpret them as an attempted Account mutation or display raw text.
  return presentConnectedServiceRegistryReadFailure(null);
}

function appendSafeSupportDetail(values: Set<string>, code: string | null | undefined): void {
  if (!code) return;
  const detail = presentConnectedServiceIndexDiagnosticCopy(code);
  if (values.size >= MAX_SUPPORT_DETAILS && !values.has(detail)) return;
  values.add(detail);
}

/**
 * Projects service-specific conflicts, availability and descriptor diagnostics.
 * Registry read failures belong to the page notice, never to each service.
 *
 * The primary row consumes only bounded state and read-diagnostic copy.
 * The support disclosure contains the same bounded product-copy
 * projection, never boundary text.
 */
export function presentConnectedServiceIndexDiagnostics(params: Readonly<{
  entry: ConnectedServiceRegistryEntry;
}>): IndexDiagnosticsPresentation {
  const primary = new Set<string>();
  const details = new Set<string>();
  const entry = params.entry;

  if (entry.projectionConflicts?.some(conflict => conflict.kind === 'identity_divergence')) {
    const conflict = t('connectedServicesSettings.identityConflict');
    primary.add(conflict);
    details.add(conflict);
  } else if (entry.projectionStatus === 'conflict') primary.add(t('common.blocked'));
  if (entry.availability?.state === 'blocked') primary.add(t('common.blocked'));
  if (entry.availability?.state === 'disabled') primary.add(t('common.disabled'));

  for (const diagnostic of entry.diagnostics ?? []) {
    primary.add(presentConnectedServiceIndexDiagnosticCopy(diagnostic));
    appendSafeSupportDetail(details, diagnostic);
  }
  if (entry.availability?.state !== 'available') {
    const reason = entry.availability?.reason;
    if (reason) primary.add(presentConnectedServiceIndexDiagnosticCopy(reason));
    appendSafeSupportDetail(details, reason);
  }
  return {
    primary: [...primary].filter(Boolean).join(' · ') || null,
    supportDetails: details.size > 0 ? [...details].join('\n') : null,
  };
}
