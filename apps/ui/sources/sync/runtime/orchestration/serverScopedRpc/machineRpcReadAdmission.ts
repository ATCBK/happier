import { createScopedResolutionSingleFlight } from './scopedResolutionSingleFlight';

/** Exact authorities already admitted by the incumbent Machine RPC route. */
export type AdmittedMachineRpcReadBinding = Readonly<{
    key: string;
    scope: readonly (object | string)[];
    assertCurrent(): void;
}>;

export type MachineRpcReadAdmissionInput<T> = Readonly<{
    binding: AdmittedMachineRpcReadBinding;
    signal?: AbortSignal;
    resolve(signal: AbortSignal): Promise<T>;
    onPhysicalAcquire(signal: AbortSignal): () => void | Promise<void>;
}>;

export type MachineRpcReadAdmission = Readonly<{
    run<T>(input: MachineRpcReadAdmissionInput<T>): Promise<T>;
}>;

// Pending physical reads only; each caller still owns its Action admission and result.
const admittedReads = createScopedResolutionSingleFlight<unknown>();

/** The resource supplies its namespaced question; the route supplies the exact admitted authority. */
export function createMachineRpcReadAdmission(question: readonly unknown[]): MachineRpcReadAdmission {
    return {
        async run<T>(input: MachineRpcReadAdmissionInput<T>): Promise<T> {
            return await admittedReads.run(JSON.stringify([...question, input.binding.key]),
                input.resolve, { signal: input.signal, scope: input.binding.scope,
                    onPhysicalAcquire: input.onPhysicalAcquire }) as T;
        },
    };
}

export function resetAdmittedMachineRpcReadsForTests(): void { admittedReads.reset(); }

/** Joining is possible only after this borrower's route and Machine admission. */
export async function runAdmittedMachineRpcRead<T>(input: Readonly<{
    admission?: MachineRpcReadAdmission;
    binding: AdmittedMachineRpcReadBinding;
    signal?: AbortSignal;
    resolve(signal?: AbortSignal): Promise<T>;
    onPhysicalAcquire(signal: AbortSignal): () => void | Promise<void>;
}>): Promise<T> {
    if (!input.admission) return await input.resolve(input.signal);
    input.binding.assertCurrent();
    const result = await input.admission.run({
        binding: input.binding,
        signal: input.signal,
        resolve: input.resolve,
        onPhysicalAcquire: input.onPhysicalAcquire,
    });
    input.binding.assertCurrent();
    return result;
}
