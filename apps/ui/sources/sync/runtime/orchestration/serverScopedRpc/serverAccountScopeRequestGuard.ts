import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** An exact Home request keeps its own credentials, independently of the active Home. */
export async function runWithHomeCredentialRequestSignal<TResult>(
    serverId: string,
    operation: (signal: AbortSignal) => Promise<TResult>,
): Promise<TResult> {
    const controller = new AbortController();
    const unsubscribe = subscribeHomeCredentialMutations(event => {
        if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) controller.abort();
    });
    try {
        return await operation(controller.signal);
    } finally {
        unsubscribe();
    }
}

/**
 * The currentness fence every exact-Account Session transport captures around one
 * operation.
 *
 * `runWithServerRequestAuthorityForServerAccountScope` proves which Account a
 * request authenticates as; it cannot notice that the Account retired, that the
 * caller's own view moved on, or that the target Home's credentials were replaced
 * while bytes were in flight. Those three facts are one concept, so they have one
 * owner rather than a copy per transport: a second copy is how one surface starts
 * accepting a response another surface would already have suppressed.
 */
export type ServerAccountScopeRequestGuard = Readonly<{
    /** Aborts as soon as the captured authority stops being current. */
    signal: AbortSignal;
    /** Whether the captured Home/Account authority still holds. */
    isCurrent: () => boolean;
    /** Throws the owner's stale-scope error the moment it no longer holds. */
    check: () => void;
}>;

export async function runWithServerAccountScopeRequestGuard<TResult>(
    params: Readonly<{
        scope: ServerAccountScope;
        isCurrent?: (() => boolean) | undefined;
        signal?: AbortSignal | undefined;
        /** The calling transport's own stale-scope failure; this owner has no error vocabulary. */
        staleError: () => Error;
    }>,
    operation: (guard: ServerAccountScopeRequestGuard) => Promise<TResult>,
): Promise<TResult> {
    return await runWithHomeCredentialRequestSignal(params.scope.serverId, async (credentialSignal) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        const controller = new AbortController();
        const abort = () => controller.abort();
        const retirement = lifetime?.onRetire(abort);
        credentialSignal.addEventListener('abort', abort, { once: true });
        if (credentialSignal.aborted) abort();
        params.signal?.addEventListener('abort', abort, { once: true });
        if (params.signal?.aborted) abort();
        const isCurrent = () => !controller.signal.aborted
            && params.isCurrent?.() !== false
            && lifetime?.isCurrent() !== false;
        const check = () => {
            if (!isCurrent()) throw params.staleError();
        };
        try {
            return await operation({ signal: controller.signal, isCurrent, check });
        } finally {
            retirement?.dispose();
            credentialSignal.removeEventListener('abort', abort);
            params.signal?.removeEventListener('abort', abort);
        }
    });
}
