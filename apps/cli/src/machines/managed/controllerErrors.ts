

export class ManagedMachineControllerError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'ManagedMachineControllerError';
    }
}
/** Definite provider refusal, distinct from policy, cancellation and uncertain IO. */
export class ManagedMachineNativeRefusal extends ManagedMachineControllerError {}
/** A private pre-handler guard prevented native IO, not an unknown delivery. */
export class ManagedMachineNativeEffectGuardRefusal extends ManagedMachineControllerError {}
