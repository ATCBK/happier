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
    resolve(signal: AbortSignal, onIssued: () => void): Promise<T>;
    onIssued?: () => void;
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
                    onPhysicalAcquire: input.onPhysicalAcquire, onIssued: input.onIssued }) as T;
        },
    };
}

export function resetAdmittedMachineRpcReadsForTests(): void { admittedReads.reset(); }

/** Joining is possible only after this borrower's route and Machine admission. */
export async function runAdmittedMachineRpcRead<T>(input: Readonly<{
    admission?: MachineRpcReadAdmission;
    binding: AdmittedMachineRpcReadBinding;
    signal?: AbortSignal;
    resolve(signal: AbortSignal | undefined, onIssued: () => void): Promise<T>;
    /** Pure ingress decoding; use a stable function so compatible readers can join. */
    decodeResult?: (raw: unknown) => T;
    onIssued?: () => void;
    onPhysicalAcquire(signal: AbortSignal): () => void | Promise<void>;
}>): Promise<T> {
    const decodeResult = input.decodeResult;
    const resolve = decodeResult
        ? async (signal: AbortSignal | undefined, onIssued: () => void) => decodeResult(await input.resolve(signal, onIssued))
        : input.resolve;
    if (!input.admission) return await resolve(input.signal, () => input.onIssued?.());
    input.binding.assertCurrent();
    const result = await input.admission.run({
        // Existing function identity partitions raw and differently decoded
        // results without a decoder registry or a second pending owner.
        binding: decodeResult ? { ...input.binding, scope: [...input.binding.scope, decodeResult] } : input.binding,
        signal: input.signal,
        resolve,
        onIssued: input.onIssued,
        onPhysicalAcquire: input.onPhysicalAcquire,
    });
    input.binding.assertCurrent();
    return result;
}
