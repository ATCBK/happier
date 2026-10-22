import type { ConnectedServiceProjectionSnapshot } from '../accountGroups/generation/connectedServiceProjectionSnapshot';
import type { ConnectedServiceRuntimeTarget } from '../runtimeRegistry/target';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';

export function isExecutionRunConnectedServiceGenerationCurrent(input: Readonly<{
  runId: string;
  target: ConnectedServiceRuntimeTarget;
  projection: ConnectedServiceProjectionSnapshot;
}>): boolean {
  if (input.target.materializationKey !== input.runId) return false;
  if (input.target.activeBindings.length === 0) {
    // Brokered Team routes retain no local Account credential generation.
    // Their existing broker owner revalidates Team/source authority per request,
    // just as it does for the parent Session. Missing local material is still a
    // refusal for any route that actually requires a local credential.
    const parsed = ConnectedServiceBindingsV2Schema.safeParse(input.target.connectedServicesBindingsRaw);
    if (!parsed.success) return false;
    const bindings = Object.values(parsed.data.bindingsByServiceId);
    return bindings.some(binding => binding.source === 'team_resource' && binding.deliveryMode === 'brokered')
      && bindings.every(binding => binding.source === 'native'
        || binding.source === 'team_resource' && binding.deliveryMode === 'brokered');
  }
  return input.target.activeBindings.every((binding) => {
    const currentRevision = input.projection.resolveCredentialRevision(binding.serviceId, binding.profileId);
    if (currentRevision === null || currentRevision !== binding.credentialRevision) return false;
    if (binding.groupId === null) return binding.groupGeneration === null;
    const group = input.projection.groups.find((candidate) =>
      candidate.serviceId === binding.serviceId && candidate.groupId === binding.groupId);
    return Boolean(group)
      && group!.activeProfileId === binding.profileId
      && group!.generation === binding.groupGeneration;
  });
}
