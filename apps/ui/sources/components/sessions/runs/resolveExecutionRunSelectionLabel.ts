import type { ExecutionRunResolvedSelection } from '@happier-dev/protocol/execution/runs/requestedConfiguration';

import { readBackendTargetRefV2, type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveSessionModelLabel } from '@/sync/domains/models/modelOptions';
import { t } from '@/text';

const PROVENANCE_KEY = {
  inherited: 'runPage.menu.selectionInherited',
  explicit: 'runPage.menu.selectionExplicit',
  independent: 'runPage.menu.selectionIndependent',
  retained: 'runPage.menu.selectionRetained',
} as const satisfies Record<ExecutionRunResolvedSelection['source'], string>;

/**
 * Where a Run's model came from and what it runs through, from the host's resolved launch record
 * (plan R2/D9): "Inherit session · DeepSeek · deepseek-v4", "Chosen for this run · …". The route is
 * named from the recorded route's recipient-safe display facts; nothing is guessed.
 */
export function resolveExecutionRunSelectionLabel(
  selection: ExecutionRunResolvedSelection | undefined,
  connectionLabel: (connectionId: string) => string | null,
  /** Display only, from the canonical Connected/Team route presenter for this resolved selection. */
  resolvedSourceLabel?: string | null,
  /** The Agent catalog's title for one of its own models; a Provider or Team model id is already its name. */
  nativeModelLabel?: (modelId: string) => string | null,
): string | null {
  if (!selection) return null;
  const connectionId = selection.modelSelection?.providerConnectionId ?? null;
  const nativeModelId = connectionId || selection.teamCredentialModel
    ? null
    : selection.modelSelection?.modelId ?? selection.modelId ?? null;
  const model =
    (nativeModelId ? nativeModelLabel?.(nativeModelId) : null) ??
    selection.modelSelection?.modelId ??
    selection.teamCredentialModel?.modelId ??
    selection.modelId ??
    null;
  return [
    t(PROVENANCE_KEY[selection.source]),
    connectionId ? connectionLabel(connectionId) : resolvedSourceLabel,
    model,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/**
 * The native-model title resolver for a Run's recorded Agent: the same catalog lookup every
 * Session surface uses, null for a configured backend or an unknown id (callers keep the id then).
 */
export function resolveRunNativeModelLabel(backendTarget: BackendTargetRefV2Input | null | undefined) {
  let agentId: string | null = null;
  try {
    const target = backendTarget ? readBackendTargetRefV2(backendTarget) : null;
    agentId = target && !target.configuredBackendId ? target.backendId : null;
  } catch {
    agentId = null;
  }
  return (modelId: string): string | null =>
    agentId && isBundledAgentId(agentId) ? resolveSessionModelLabel(agentId, null, modelId) : null;
}
