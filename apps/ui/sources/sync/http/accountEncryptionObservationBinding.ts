import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';

/** Authority retained by the authenticated Account transport, never inferred from a bearer. */
export type AccountEncryptionObservationBinding = Readonly<{
    credentials: AuthCredentials;
    credentialScopeKey: string;
    serverId: string;
    endpointUrl: string;
    runtimeOrigin: string;
    homeCarrierEndpointId: string | null;
    isCurrent: () => boolean;
    read: (signal?: AbortSignal) => Promise<AccountEncryptionIdentity>;
    peek: () => AccountEncryptionIdentity | null;
}>;

const accountEncryptionObservation = Symbol('accountEncryptionObservation');

export function matchesAccountEncryptionObservationCredentials(
    binding: AccountEncryptionObservationBinding,
    credentials: AuthCredentials,
): boolean {
    return binding.credentials === credentials || binding.credentialScopeKey === resolveAuthCredentialsScopeKey(credentials);
}

export function bindAccountEncryptionObservation<T extends object>(
    request: T,
    binding: AccountEncryptionObservationBinding | undefined,
): T {
    if (binding) Object.defineProperty(request, accountEncryptionObservation, { value: binding });
    return request;
}

export function readAccountEncryptionObservationBinding(
    request: object,
    credentials: AuthCredentials,
): AccountEncryptionObservationBinding | null {
    if (!(accountEncryptionObservation in request)) return null;
    const binding = request[accountEncryptionObservation] as AccountEncryptionObservationBinding;
    return matchesAccountEncryptionObservationCredentials(binding, credentials) && binding.isCurrent() ? binding : null;
}
