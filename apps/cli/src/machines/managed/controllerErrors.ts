import type { ManagedControllerRequestFailureDetailsV1 } from '@happier-dev/protocol/actions/operations/v1';

export class ManagedMachineControllerError extends Error {
    constructor(readonly code: string, readonly status?: number, readonly details?: ManagedControllerRequestFailureDetailsV1) {
        super(code);
        this.name = 'ManagedMachineControllerError';
    }
}
/** Definite native refusal, including proof that the handler never started. */
export class ManagedMachineNativeRefusal extends ManagedMachineControllerError {}
/** A private pre-handler guard prevented native IO, not an unknown delivery. */
export class ManagedMachineNativeEffectGuardRefusal extends ManagedMachineNativeRefusal {}

/** Only preparation can prove supersession before this policy has admission or native effects. */
export class ManagedRetentionWaitSuperseded extends ManagedMachineControllerError {
    constructor() { super('intent_changed'); }
}
