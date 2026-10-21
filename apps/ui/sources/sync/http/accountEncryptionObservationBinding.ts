import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';
import { sync } from '@/sync/sync';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { HappyError } from '@/utils/errors/errors';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';

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

/** Capture an existing authenticated transport once; reads never select another owner. */
export function captureAccountEncryptionObservationForHome(params: Readonly<{
    serverId: string;
    endpointUrl: string;
    credentials: AuthCredentials;
    isCurrent?: () => boolean;
    signals?: readonly (AbortSignal | undefined)[];
}>): AccountEncryptionObservationBinding | undefined {
    const serverId = resolveServerProfileScopeIdForIdentifier(params.serverId);
    const source = sync?.getAccountEncryptionObservationBinding(params.credentials, serverId);
    if (!source || resolveServerProfileScopeIdForIdentifier(source.serverId) !== serverId
        || canonicalizeServerUrl(source.endpointUrl) !== canonicalizeServerUrl(params.endpointUrl)
        || !matchesAccountEncryptionObservationCredentials(source, params.credentials)) return undefined;
    const isCurrent = () => source.isCurrent() && params.isCurrent?.() !== false
        && !params.signals?.some(signal => signal?.aborted);
    const assertCurrent = () => {
        for (const signal of params.signals ?? []) throwIfAborted(signal);
        if (!isCurrent()) throw new HappyError('Account encryption observation unavailable', false, {
            kind: 'config', code: 'account-encryption-currentness-unavailable',
        });
    };
    return {
        ...source,
        isCurrent,
        read: async signal => {
            assertCurrent();
            const cancellation = mergeAbortSignals([...(params.signals ?? []), signal]);
            try {
                const identity = await source.read(cancellation.signal);
                assertCurrent();
                return identity;
            } finally { cancellation.dispose(); }
        },
        peek: () => isCurrent() ? source.peek() : null,
    };
}
