import type { RequesterSessionRuntimeContext } from '../../sessionEncryption/requesterSessionCredentials';
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { isAxiosError } from 'axios';
import {
    ConnectedAccountRequestAuthError,
    type ConnectedAccountRequestAuthServiceDependencies,
} from './ConnectedAccountRequestAuthService';

/** The daemon's existing qualified purpose callbacks; legacy ingress stays at its caller. */
type RequestAuthAccountContext = Readonly<{
    bootstrap: Pick<RequesterSessionRuntimeContext['bootstrap'], 'serverHttpBaseUrl'>;
    qualifiedConnectedAccountEstablishedRuntimeOwner?: Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'recordScopeChallenge'>;
}> & Pick<RequesterSessionRuntimeContext, 'isCurrent'>;

export function createDaemonQualifiedRequestAuthCallbacks<T extends RequestAuthAccountContext>(params: Readonly<{
    recordScopeChallenge?: QualifiedConnectedAccountEstablishedRuntimeOwner['recordScopeChallenge'];
    withSessionAccountContext?: <Result>(sessionId: string | null, operation: (context: T | null) => Promise<Result>) => Promise<Result>;
    /** The Session owner verifies both captured-context identity and fresh
     * admission. Direct context checks serve only the assertion-free adapter. */
    assertSessionAccountCurrent?: (sessionId: string, expected: T | null) => Promise<void>;
}>): Pick<ConnectedAccountRequestAuthServiceDependencies, 'resolveCurrentBinding' | 'materializeBearer' | 'reportScopeFailure'> {
    const withSessionAccountContext = async <Result>(sessionId: string | null, operation: (context: T | null) => Promise<Result>) => {
        if (sessionId && params.withSessionAccountContext) {
            return await params.withSessionAccountContext(sessionId, operation);
        }
        return await operation(null);
    };
    return {
        reportScopeFailure: async ({ subject, resolved, failure, signal }) => {
            signal.throwIfAborted();
            if (!subject.isCurrent()) return { status: 'stale_context' };
            return await withSessionAccountContext(subject.parentSessionId ?? null, async context => {
                if (subject.parentSessionId) {
                    // Null is the existing daemon-Account projection only when the
                    // Session admission owner proves it; missing requester custody
                    // must not borrow the Machine's writer.
                    if (!context && !params.assertSessionAccountCurrent) return { status: 'stale_context' as const };
                    await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
                }
                if (context && !params.assertSessionAccountCurrent && !await context.isCurrent()) return { status: 'stale_context' as const };
                const record = context ? context.qualifiedConnectedAccountEstablishedRuntimeOwner?.recordScopeChallenge : params.recordScopeChallenge;
                if (!record) return { status: 'denied' as const };
                const write = () => record({ account: resolved.account, expectedCredentialRevision: resolved.credentialRevision,
                    requiredScopes: failure.requiredScopes, signal });
                const result = await (context ? runWithServerHttpBaseUrl(context.bootstrap.serverHttpBaseUrl, write) : write());
                signal.throwIfAborted();
                if (subject.parentSessionId) await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
                if (!subject.isCurrent() || (context && !params.assertSessionAccountCurrent && !await context.isCurrent())) return { status: 'stale_context' as const };
                return result;
            });
        },
        resolveCurrentBinding: async ({ subject, binding, signal }) => {
            signal.throwIfAborted();
            if (!subject.isCurrent()) return null;
            let phase: 'requester' | 'binding' = 'requester';
            try {
                return await withSessionAccountContext(subject.parentSessionId ?? null, async context => {
                    if (subject.parentSessionId && !context && !params.assertSessionAccountCurrent) {
                        throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable', { causeCode: 'requester_context_unavailable' });
                    }
                    const authority = subject.bindingAuthority;
                    if (!authority) throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable', { causeCode: 'binding_resolver_unavailable' });
                    if (subject.parentSessionId) await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
                    if (context && !params.assertSessionAccountCurrent && !await context.isCurrent()) throw new Error('requester_session_not_current');
                    phase = 'binding';
                    // A recovered Account runtime has a different process-local lease map.
                    // Keep the issuer's owner; requester custody still fences every read.
                    const read = () => authority.resolveCurrentBinding({ binding, signal });
                    const resolved = await (context ? runWithServerHttpBaseUrl(context.bootstrap.serverHttpBaseUrl, read) : read());
                    signal.throwIfAborted();
                    phase = 'requester';
                    if (subject.parentSessionId) await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
                    if (context && !params.assertSessionAccountCurrent && !await context.isCurrent()) throw new Error('requester_session_not_current');
                    if (!subject.isCurrent() || !resolved) return null;
                    return Object.freeze({ account: resolved.account, credentialRevision: resolved.credentialRevision,
                        ...(resolved.group ? { group: resolved.group } : {}) });
                });
            } catch (error) {
                signal.throwIfAborted();
                if (error instanceof ConnectedAccountRequestAuthError) throw error;
                const httpStatus = isAxiosError(error) ? error.response?.status : undefined;
                throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable', {
                    causeCode: httpStatus ? phase === 'requester' ? 'requester_http_refused' : 'binding_http_refused'
                        : error instanceof Error && error.message === 'requester_session_not_current' ? 'requester_session_not_current'
                            : phase === 'requester' ? 'requester_context_unavailable' : 'binding_resolution_failed',
                    ...(httpStatus ? { httpStatus } : {}),
                });
            }
        },
        materializeBearer: async ({ subject, binding, resolved, materialization, signal }) => {
            signal.throwIfAborted();
            if (!subject.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
            return await withSessionAccountContext(subject.parentSessionId ?? null, async context => {
                if (subject.parentSessionId && !context && !params.assertSessionAccountCurrent) {
                    throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable', { causeCode: 'requester_context_unavailable' });
                }
                const authority = subject.bindingAuthority;
                if (!authority) throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable', { causeCode: 'binding_resolver_unavailable' });
                if (subject.parentSessionId) await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
                if (context && !params.assertSessionAccountCurrent && !await context.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
                const read = () => authority.materializeBearer({ binding, resolved, materialization, signal });
                const result = await (context ? runWithServerHttpBaseUrl(context.bootstrap.serverHttpBaseUrl, read) : read());
                signal.throwIfAborted();
                if (subject.parentSessionId) await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
                if (context && !params.assertSessionAccountCurrent && !await context.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
                if (!subject.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
                return result;
            });
        },
    };
}
