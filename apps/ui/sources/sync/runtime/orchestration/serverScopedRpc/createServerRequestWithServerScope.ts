import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import {
    areServerAccountScopesEqual,
    createServerAccountScope,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { createServerFetchAtEndpoint, type ServerFetchOptions, type ServerResponseRequest } from '@/sync/http/client';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';

import { resolveServerAccountRequestContext } from './resolveServerAccountRequestContext';
import { onceAsync } from './resolveServerScopedTransport';
import type {
    ResolvedServerAccountRequestContext,
} from './resolveServerAccountRequestContext';

type ScopedServerAccountRequestContext = Extract<
    ResolvedServerAccountRequestContext,
    { scope: 'scoped' }
>;

export type ServerAccountRequestOptions = Readonly<Pick<ServerFetchOptions, 'onIssued' | 'retry'>>;
export type ServerAccountResponseRequest = ServerResponseRequest<ServerAccountRequestOptions>;
type RawServerAccountRequest = (path: string, init?: RequestInit, options?: ServerAccountRequestOptions) => Promise<Response>;

export function createServerRequestForExplicitServerScope(params: Readonly<{
    serverUrl: string;
    homeIdentityId?: string;
    runtimeOrigin?: string;
    token: string;
    timeoutMs?: number;
    /**
     * A Home that owns its own bytes and has no origin a URL fetch can reach
     * (browser Iroh, Lane 06 A7.3/A7.4). When one is resolved, it — not the
     * canonical URL — is how this request travels; the URL keeps describing
     * identity, audience and logging exactly as it does for every other carrier.
     */
    homeCarrier?: HomeCarrier;
}>): ServerAccountResponseRequest {
    function request(path: string, init?: RequestInit, options?: ServerAccountRequestOptions): Promise<Response>;
    function request<T>(path: string, init: RequestInit | undefined, options: ServerAccountRequestOptions | undefined, consumeResponse: (response: Response) => Promise<T>): Promise<T>;
    async function request<T>(path: string, init?: RequestInit, options?: ServerAccountRequestOptions, consumeResponse?: (response: Response) => Promise<T>): Promise<Response | T> {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${params.token}`);
        if (params.homeCarrier || options?.retry === 'none') {
            // The canonical HTTP owner composes semantic carriers and explicit
            // no-retry requests. Supply its scoped credential and request policy
            // here instead of parking user Retry on passive reachability.
            const endpointRequest = createServerFetchAtEndpoint({
                endpointUrl: params.serverUrl,
                ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
                ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
                credentials: { token: params.token },
            });
            const requestInit = { ...init, method: init?.method ?? 'GET', headers };
            const requestOptions = { retry: 'none' as const, ...(options?.onIssued ? { onIssued: options.onIssued } : {}) };
            return consumeResponse ? await endpointRequest(path, requestInit, requestOptions, consumeResponse)
                : await endpointRequest(path, requestInit, requestOptions);
        }
        const requestParams = {
            serverUrl: params.serverUrl,
            ...(params.homeIdentityId ? { homeIdentityId: params.homeIdentityId } : {}),
            token: params.token,
            url: `${params.runtimeOrigin ?? params.serverUrl}${path}`,
            ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
            ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
            init: {
                ...init,
                method: init?.method ?? 'GET',
                headers,
            },
            ...(options?.onIssued ? { onIssued: options.onIssued } : {}),
        };
        return consumeResponse ? await runtimeFetchWithServerReachability(requestParams, consumeResponse)
            : await runtimeFetchWithServerReachability(requestParams);
    }
    return request;
}

export type ServerAccountRequestAuthority = Readonly<{
    scope: ServerAccountScope;
    context: ScopedServerAccountRequestContext;
    request: (path: string, init?: RequestInit, options?: ServerAccountRequestOptions) => Promise<Response>;
    release: () => Promise<void>;
    /**
     * Moves this authority's physical carrier release to a pooled socket
     * acquisition. After this succeeds, `release` no longer owns a carrier and
     * cannot tear it down while a pooled logical socket still uses it.
     */
    transferCarrierCustody?: () => () => Promise<void>;
}>;

export function createServerRequestForResolvedServerScope(params: Readonly<{ context: ResolvedServerAccountRequestContext; activeRequest: ServerAccountResponseRequest }>): ServerAccountResponseRequest;
export function createServerRequestForResolvedServerScope(params: Readonly<{ context: ResolvedServerAccountRequestContext; activeRequest: RawServerAccountRequest }>): RawServerAccountRequest;
export function createServerRequestForResolvedServerScope(params: Readonly<{
    context: ResolvedServerAccountRequestContext;
    activeRequest: ServerAccountResponseRequest | RawServerAccountRequest;
}>): ServerAccountResponseRequest | RawServerAccountRequest {
    function request(path: string, init?: RequestInit, options?: ServerAccountRequestOptions): Promise<Response>;
    function request<T>(path: string, init: RequestInit | undefined, options: ServerAccountRequestOptions | undefined, consumeResponse: (response: Response) => Promise<T>): Promise<T>;
    async function request<T>(path: string, init?: RequestInit, options?: ServerAccountRequestOptions, consumeResponse?: (response: Response) => Promise<T>): Promise<Response | T> {
        if (params.context.scope === 'active') {
            // The public overload pairs consumer callers with a consumer-capable
            // request; legacy raw callers continue to use its three-argument path.
            const activeRequest: (path: string, init?: RequestInit, options?: ServerAccountRequestOptions, consumeResponse?: (response: Response) => Promise<T>) => Promise<Response | T> = params.activeRequest;
            return await activeRequest(path, init, options, consumeResponse);
        }

        const homeIdentityId = resolvePortableServerIdentityForRoutingId(params.context.targetServerId);
        const scopedRequest = createServerRequestForExplicitServerScope({
            serverUrl: params.context.targetServerUrl,
            ...(homeIdentityId ? { homeIdentityId } : {}),
            ...(params.context.runtimeOrigin ? { runtimeOrigin: params.context.runtimeOrigin } : {}),
            token: params.context.token,
            timeoutMs: params.context.timeoutMs,
            // The resolved transport already decided how this Home is reached;
            // dropping its carrier here would send every account-scoped request
            // to an origin an ingress-less Home does not have.
            ...(params.context.homeCarrier ? { homeCarrier: params.context.homeCarrier } : {}),
        });
        return consumeResponse ? await scopedRequest(path, init, options, consumeResponse) : await scopedRequest(path, init, options);
    }
    return request;
}

export function createServerRequestWithServerScope(params: Readonly<{
    serverId?: string | null;
    timeoutMs?: number;
    preferScoped?: boolean;
    activeRequest: RawServerAccountRequest;
}>): (path: string, init?: RequestInit, options?: ServerAccountRequestOptions) => Promise<Response> {
    return async (path: string, init?: RequestInit, options?: ServerAccountRequestOptions) => {
        const context = await resolveServerAccountRequestContext({
            serverId: params.serverId ?? null,
            ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
            ...(params.preferScoped === true ? { preferScoped: true } : {}),
        });
        try {
            const response = await createServerRequestForResolvedServerScope({
                context,
                activeRequest: params.activeRequest,
            })(path, init, options);
            if (context.scope === 'active' || response.body === null) return response;

            // A scoped Iroh origin is lease-backed. Buffer these JSON/control
            // responses before releasing the lease so callers can consume the
            // returned Response without racing tunnel teardown.
            const body = await response.arrayBuffer();
            return new Response(body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        } finally {
            if (context.scope === 'scoped') await context.release?.();
        }
    };
}

type ServerAccountRequestTarget =
    | Readonly<{ scope: ServerAccountScope; serverId?: never }>
    | Readonly<{ serverId: string; scope?: never }>;

type CaptureServerAccountRequestParams = ServerAccountRequestTarget & Readonly<{
    activeRequest: RawServerAccountRequest;
}>;

export async function captureServerRequestAuthorityForServerAccountScope(params: CaptureServerAccountRequestParams): Promise<ServerAccountRequestAuthority> {
    const serverId = params.scope?.serverId ?? params.serverId;
    if (!serverId?.trim()) throw new Error('Account-scoped request requires an explicit Home');
    const context = await resolveServerAccountRequestContext({
        serverId,
        preferScoped: true,
    });
    if (context.scope !== 'scoped') {
        throw new Error('Account-scoped request did not resolve to scoped credentials');
    }
    const resolvedScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
    if (!resolvedScope || (params.scope && !areServerAccountScopesEqual(resolvedScope, params.scope))) {
        await context.release?.();
        throw new Error('Account-scoped request authenticated account does not match requested scope');
    }
    // Release ownership must survive a rejection: coalesce concurrent callers,
    // propagate the first rejection, and retry the underlying release on the
    // next explicit call instead of losing custody before the await resolves.
    let carrierRelease: (() => Promise<void>) | null = onceAsync(async () => {
        await context.release?.();
    });
    let authorityReleaseInFlight: Promise<void> | null = null;
    const release = async (): Promise<void> => {
        if (!carrierRelease) return;
        authorityReleaseInFlight ??= carrierRelease().then(
            () => {
                carrierRelease = null;
                authorityReleaseInFlight = null;
            },
            (error: unknown) => {
                authorityReleaseInFlight = null;
                throw error;
            },
        );
        await authorityReleaseInFlight;
    };
    const transferCarrierCustody = (): (() => Promise<void>) => {
        if (!carrierRelease || authorityReleaseInFlight) {
            throw new Error('Server Account request authority carrier custody is no longer available');
        }
        const transferredRelease = carrierRelease;
        carrierRelease = null;
        return transferredRelease;
    };
    return {
        scope: resolvedScope,
        context,
        request: createServerRequestForResolvedServerScope({
            context,
            activeRequest: params.activeRequest,
        }),
        release,
        transferCarrierCustody,
    };
}

export async function runWithServerRequestAuthorityForServerAccountScope<TResult>(params: CaptureServerAccountRequestParams, operation: (authority: ServerAccountRequestAuthority) => Promise<TResult>): Promise<TResult> {
    const authority = await captureServerRequestAuthorityForServerAccountScope(params);
    try {
        return await operation(authority);
    } finally {
        await authority.release();
    }
}

/** Response bytes stay under the same lease as the Account-authenticated request. */
export function createServerRequestForServerAccountScope(params: Readonly<{
    scope: ServerAccountScope;
    activeRequest: RawServerAccountRequest;
}>): (path: string, init?: RequestInit, options?: ServerAccountRequestOptions) => Promise<Response> {
    return (path, init, options) => runWithServerRequestAuthorityForServerAccountScope(params, async (authority) => {
        const response = await authority.request(path, init, options);
        if (response.body === null) return response;
        return new Response(await response.arrayBuffer(), {
            status: response.status, statusText: response.statusText, headers: response.headers,
        });
    });
}

/** Resolves an explicitly disposable authority; callers must release it. */
export async function resolveServerRequestForServerAccountScope(params: Readonly<{
    scope: ServerAccountScope;
    activeRequest: RawServerAccountRequest;
}>): Promise<ServerAccountRequestAuthority> {
    return await captureServerRequestAuthorityForServerAccountScope(params);
}
