import type { ManagedControllerRequestFailureDetailsV1 } from '@happier-dev/protocol/actions/operations/v1';

export class ManagedMachineControllerError extends Error {
    constructor(readonly code: string, readonly status?: number, readonly details?: ManagedControllerRequestFailureDetailsV1) {
        super(code);
        this.name = 'ManagedMachineControllerError';
    }
}
/** Definite provider refusal, distinct from policy, cancellation and uncertain IO. */
export class ManagedMachineNativeRefusal extends ManagedMachineControllerError {}
/** A private pre-handler guard prevented native IO, not an unknown delivery. */
export class ManagedMachineNativeEffectGuardRefusal extends ManagedMachineControllerError {}
