import { z } from 'zod/mini';

import { RunnerPublicKeySchema } from '@happier-dev/protocol/ephemeralRunner/activation';
import {
    readDeviceLocalStorageString,
    writeDeviceLocalStorageString,
} from '@/auth/storage/deviceLocalStorage';
import { encodeBase64 } from '@/encryption/base64';
import { digest } from '@/platform/digest';
import {
    createServerAccountScope,
    serverAccountScopedResourceKey,
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

/**
 * Creator-local verifier custody for a Temporary computer's Machine content key.
 *
 * The Machine-content-key proof is signed by the creator-generated activation
 * signing identity. A later read of the published Machine row — on the creating
 * device — can only trust that proof if it recovers the activation public key
 * from its own storage: a Home-relayed verifier identity would let a Home
 * substitute verifier key, binding and an Account-openable envelope together.
 * This module is that storage, and it holds only non-secret public material.
 *
 * Readers await device-local custody before choosing Machine semantics. Only a
 * successful absent read is cached as absence; storage failure remains retryable.
 */
export type RunnerCreatorMachineContentKeyTrustV1 = Readonly<{
    activationId: string;
    activationSigningPublicKey: string;
}>;

type StoredRunnerCreatorMachineContentKeyTrustV1 = Readonly<{
    v: 1;
    activationId: string;
    activationSigningPublicKey: string;
}>;

const STORAGE_PREFIX = 'happier-runner-machine-trust-v1';

const trustByScopedMachine = new Map<string, RunnerCreatorMachineContentKeyTrustV1 | null>();
const pendingLoads = new Map<string, Promise<RunnerCreatorMachineContentKeyTrustV1 | null>>();

function memoKey(scope: ServerAccountScope, machineId: string): string {
    return serverAccountScopedResourceKey(scope, machineId);
}

async function storageKey(scope: ServerAccountScope, machineId: string): Promise<string> {
    const scopeDigest = await digest('SHA-256', new TextEncoder().encode(serverAccountScopeKeySuffix(scope)));
    const machineDigest = await digest('SHA-256', new TextEncoder().encode(machineId));
    // Expo SecureStore permits only alphanumeric, dot, hyphen and underscore keys.
    return `${STORAGE_PREFIX}.${encodeBase64(scopeDigest, 'base64url')}.${encodeBase64(machineDigest, 'base64url')}`;
}

function parseStored(value: string | null): RunnerCreatorMachineContentKeyTrustV1 | null {
    if (value === null) return null;
    const record: unknown = JSON.parse(value);
    if (!record || typeof record !== 'object') throw new Error('Invalid Runner Machine trust custody');
    const row = record as Partial<StoredRunnerCreatorMachineContentKeyTrustV1>;
    if (row.v !== 1) throw new Error('Invalid Runner Machine trust custody');
    const activationId = z.string().check(z.uuid()).safeParse(row.activationId);
    const publicKey = RunnerPublicKeySchema.safeParse(row.activationSigningPublicKey);
    if (!activationId.success || !publicKey.success) throw new Error('Invalid Runner Machine trust custody');
    return { activationId: activationId.data, activationSigningPublicKey: publicKey.data };
}

/** Retains the exact verifier identity for a Machine the creator just proved. */
export async function retainRunnerCreatorMachineContentKeyTrust(input: Readonly<{
    scope: Readonly<{ homeServerIdentityId: string; creatorAccountId: string }>;
    machineId: string;
    activationId: string;
    activationSigningPublicKey: string;
}>): Promise<void> {
    const scope = createServerAccountScope(input.scope.homeServerIdentityId, input.scope.creatorAccountId);
    const machineId = input.machineId.trim();
    if (!scope || !machineId) return;
    const record: StoredRunnerCreatorMachineContentKeyTrustV1 = {
        v: 1,
        activationId: input.activationId,
        activationSigningPublicKey: input.activationSigningPublicKey,
    };
    await writeDeviceLocalStorageString(await storageKey(scope, machineId), JSON.stringify(record));
    trustByScopedMachine.set(memoKey(scope, machineId), {
        activationId: record.activationId,
        activationSigningPublicKey: record.activationSigningPublicKey,
    });
}

/** Coalesces cold reads; rejects unavailable custody without caching absence. */
export async function loadRunnerCreatorMachineContentKeyTrust(
    scope: ServerAccountScope,
    machineId: string,
): Promise<RunnerCreatorMachineContentKeyTrustV1 | null> {
    const key = memoKey(scope, machineId);
    const known = trustByScopedMachine.get(key);
    if (known !== undefined) return known;
    const pending = pendingLoads.get(key);
    if (pending) return await pending;
    const load = (async () => {
        const stored = parseStored(await readDeviceLocalStorageString(await storageKey(scope, machineId)));
        // Retention may have completed while the cold read was pending.
        const trust = trustByScopedMachine.get(key) ?? stored;
        trustByScopedMachine.set(key, trust);
        return trust;
    })();
    pendingLoads.set(key, load);
    try {
        return await load;
    } finally {
        if (pendingLoads.get(key) === load) pendingLoads.delete(key);
    }
}

/** Test-only: drops the in-memory projection so a case starts from storage. */
export function resetRunnerCreatorMachineContentKeyTrustProjectionForTests(): void {
    trustByScopedMachine.clear();
    pendingLoads.clear();
}
