import { TokenStorage } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import {
    getServerProfileById,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { parseToken } from '@/utils/auth/parseToken';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import { createServerAccountScope, type ServerAccountScope, type ServerAccountScopeLifetime } from './serverAccountScope';

export type ServerCredentialAccountScopeResolution =
    | Readonly<{ kind: 'resolving' }>
    | Readonly<{ kind: 'unknown_home' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'signed_out' }>
    | Readonly<{ kind: 'bound'; scope: ServerAccountScope; credentialKey?: string; lifetime?: ServerAccountScopeLifetime & Readonly<{ revision: number }> }>;

type RetryListener = (serverId: string) => void;
const retryListeners = new Set<RetryListener>();

/**
 * Asks every live consumer of this Home's credential identity to read it again.
 * Only an `unavailable` (unreadable secure storage) resolution has anything to
 * gain from a re-read; the shared scope hook ignores the request otherwise.
 */
export function retryServerCredentialAccountScope(serverId: string): void {
    const canonicalServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    if (!canonicalServerId) return;
    for (const listener of [...retryListeners]) {
        try {
            listener(canonicalServerId);
        } catch {
            // One consumer cannot prevent its siblings from re-reading.
        }
    }
}

export function subscribeServerCredentialAccountScopeRetry(listener: RetryListener): () => void {
    retryListeners.add(listener);
    return () => {
        retryListeners.delete(listener);
    };
}

/**
 * Every consumer hook and every profile refresh resolves again, so a persistent
 * storage failure is reported once per Home and error class until a read of
 * that Home succeeds.
 */
const reportedReadFailures = new Map<string, Set<string>>();

function reportReadFailureOnce(serverId: string, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : typeof error;
    const reported = reportedReadFailures.get(serverId) ?? new Set<string>();
    if (reported.has(errorClass)) return;
    reported.add(errorClass);
    reportedReadFailures.set(serverId, reported);
    captureExceptionIfEnabled(error, {
        tags: { operation: 'resolve_server_credential_account_scope' },
        extra: { serverId },
    });
}


/** The credential-backed identity shared by routed projections and React readers. */
export function resolveAdmittedEmbedServerCredentialAccountScope(
    serverId: string,
): Exclude<ServerCredentialAccountScopeResolution, Readonly<{ kind: 'resolving' }>> {
    const admitted = getSyncSingleton().getEmbedSessionRequestContext();
    if (!admitted || admitted.serverId !== serverId || !admitted.isCurrent()) return { kind: 'unavailable' };
    const scope = createServerAccountScope(admitted.serverId, admitted.accountId);
    return scope ? { kind: 'bound', scope, credentialKey: resolveAuthCredentialsScopeKey(admitted.credentials), lifetime: {
        scope, revision: admitted.revision, isCurrent: admitted.isCurrent, onRetire: admitted.onRetire,
    } } : { kind: 'unavailable' };
}

export async function resolveServerCredentialAccountScope(
    serverId: string,
): Promise<Exclude<ServerCredentialAccountScopeResolution, Readonly<{ kind: 'resolving' }>>> {
    if (isEmbedWindowContext()) {
        return resolveAdmittedEmbedServerCredentialAccountScope(serverId);
    }
    const canonicalServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    const profile = getServerProfileById(canonicalServerId);
    if (!profile?.serverUrl?.trim()) return { kind: 'unknown_home' };
    let credentials: Awaited<ReturnType<typeof TokenStorage.getCredentialsForServerUrl>>;
    try {
        credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, {
            serverId: canonicalServerId,
            storageReadFailure: 'surface',
        });
    } catch (error) {
        // A secure-storage failure says nothing about whether a credential is
        // present. Keep it distinct from a confirmed absent credential so a
        // caller never turns a device read failure into a sign-out claim.
        reportReadFailureOnce(canonicalServerId, error);
        return { kind: 'unavailable' };
    }
    reportedReadFailures.delete(canonicalServerId);
    try {
        const scope = createServerAccountScope(
            canonicalServerId,
            credentials ? parseToken(credentials.token) : null,
        );
        return scope && credentials ? { kind: 'bound', scope, credentialKey: resolveAuthCredentialsScopeKey(credentials) } : { kind: 'signed_out' };
    } catch {
        // A malformed credential cannot establish an Account binding.
        return { kind: 'signed_out' };
    }
}
