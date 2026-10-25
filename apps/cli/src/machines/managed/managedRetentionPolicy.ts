import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

/** Home's admitted continuation may finish through native Stop or provider-native Suspend. */
export function hasSubmittedManagedRetentionEffect(machine: ManagedMachineV1, continuationRequestId?: string): boolean {
    return machine.retention.kind !== 'until-delete' && machine.retention.effect === 'stop'
        && continuationRequestId !== undefined && machine.submittedNativeEffect?.requestId === continuationRequestId
        && (machine.desired === 'stop' || machine.desired === 'suspend')
        && machine.submittedNativeEffect?.intent === machine.desired;
}
