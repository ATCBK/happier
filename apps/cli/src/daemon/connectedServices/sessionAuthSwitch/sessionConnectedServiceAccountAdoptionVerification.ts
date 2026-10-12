import type { ConnectedAccountServiceKey, ConnectedServiceBindingsV2 } from '@happier-dev/protocol';

import { getConnectedServiceRuntimeAuthAdapter } from '@/daemon/connectedServices/catalogHooks';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { TrackedSession } from '@/daemon/types';
import type {
  ConnectedServiceAccountTransitionVerificationResult,
  ConnectedServiceProviderRuntimeAuthAdapter,
} from '../runtimeAuth/types';
import { projectConnectedServiceRuntimeAuthTargetInput } from '../runtimeAuth/projectRuntimeAuthTargetInput';

export type ConnectedServiceAccountAdoptionVerificationInput = Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedAccountServiceKey;
  target: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    profileId: string | null;
    groupId?: string | null;
  }>;
  normalizedBindings: ConnectedServiceBindingsV2;
  action: 'hot_applied' | 'restart_requested';
  runtimeAuthSelection?: unknown;
}>;

export type ConnectedServiceAccountAdoptionVerifier = (
  input: ConnectedServiceAccountAdoptionVerificationInput,
) => Promise<ConnectedServiceAccountTransitionVerificationResult>;

export function createSessionConnectedServiceAccountAdoptionVerifier(deps?: Readonly<{
  resolveRuntimeAuthAdapter?: (agentId: CatalogAgentId) => Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;
}>): ConnectedServiceAccountAdoptionVerifier {
  const resolveRuntimeAuthAdapter = deps?.resolveRuntimeAuthAdapter
    ?? (async (agentId: CatalogAgentId) => await getConnectedServiceRuntimeAuthAdapter(agentId));

  return async function verifySessionConnectedServiceAccountAdoption(
    input: ConnectedServiceAccountAdoptionVerificationInput,
  ): Promise<ConnectedServiceAccountTransitionVerificationResult> {
    const adapter = await resolveRuntimeAuthAdapter(input.agentId);
    if (!adapter?.verifyActiveAccount) {
      return {
        status: 'unavailable',
        retryable: false,
        reason: 'active_account_verifier_unavailable',
      };
    }
    const binding = input.normalizedBindings.bindingsByServiceId[input.serviceId];
    return await adapter.verifyActiveAccount(projectConnectedServiceRuntimeAuthTargetInput({
      agentId: input.agentId,
      materializedSelection: input.runtimeAuthSelection,
      fallbackSelection: {
        ...(binding?.source === 'connected' ? { kind: binding.selection } : {}),
        serviceId: input.serviceId,
        binding,
        profileId: input.target.profileId,
        ...(input.target.groupId ? { groupId: input.target.groupId, activeProfileId: input.target.profileId } : {}),
      },
    }));
  };
}
