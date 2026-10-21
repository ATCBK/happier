import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import type { ServerFetch, ServerFetchOptions } from '@/sync/http/client';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

export type AutomationRequestContext = Readonly<{
    request: ServerFetch;
    serverId: string;
    readTransport?: CapturedServerReadTransport;
    accountLifetime?: ServerAccountScopeLifetime;
    invocationSignal?: AbortSignal;
    assertCurrent?: () => void;
}>;

// JSON acquisition only. Strict family parsing and per-invocation admission stay
// in the Automation/Workflow owners; no opened definition or Run is retained.
const automationReads = createScopedResolutionSingleFlight<unknown>();

export async function readAutomationApiJson(path: string, init: RequestInit, options: ServerFetchOptions,
    context: AutomationRequestContext | undefined, fallback: ServerFetch): Promise<unknown> {
    context?.assertCurrent?.();
    if (!context?.readTransport) return await readAutomationJsonOrThrow(await fallback(path, init, options));
    const transport = context.readTransport;
    const scope = transport.key;
    const abort = new AbortController();
    const retirement = context.accountLifetime?.onRetire(() => abort.abort());
    const cancellation = mergeAbortSignals([init.signal ?? undefined, context.invocationSignal, abort.signal]);
    try {
        const result = await automationReads.run(path,
            signal => transport.read(path, { ...init, signal }, options, readAutomationJsonOrThrow),
            { scope, signal: cancellation.signal });
        context.assertCurrent?.();
        return result;
    } finally { cancellation.dispose(); retirement?.dispose(); }
}

/** Local mutations also fence direct API readers that have no mounted Action. */
export function invalidateAutomationReadAcquisitions(context?: AutomationRequestContext): void {
    const transport = context?.readTransport;
    if (transport) automationReads.invalidate(transport.key);
}

export type AutomationApiErrorPayload = Readonly<{
    code: string;
    status: number;
    message?: string;
}>;

export class AutomationApiError extends HappyError {
    constructor(payload: AutomationApiErrorPayload) {
        super(
            payload.message ?? payload.code,
            payload.status === 408 || payload.status === 429 || payload.status >= 500,
            {
                code: payload.code,
                status: payload.status,
                kind: 'server',
            },
        );
        this.name = 'AutomationApiError';
        Object.setPrototypeOf(this, AutomationApiError.prototype);
    }
}

export function isAutomationApiErrorCode(error: unknown, code: string): error is AutomationApiError {
    return error instanceof AutomationApiError && error.code === code;
}

export async function readAutomationJsonOrThrow(response: Response): Promise<unknown> {
    if (!response.ok) {
        let message = `Automation API request failed: ${response.status}`;
        let code = 'automation_api_request_failed';
        try {
            const error = await response.json();
            const record = error && typeof error === 'object'
                ? error as Record<string, unknown>
                : null;
            if (typeof record?.error === 'string') {
                message = record.error;
                code = message;
            }
        } catch {
            // ignore
        }
        throw new AutomationApiError({ code, status: response.status, message });
    }
    return await response.json();
}

export function getAutomationAuthHeaders(
    credentials: AuthCredentials,
    options: Readonly<{ includeJsonContentType?: boolean }> = {},
): Record<string, string> {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${credentials.token}`,
    };
    if (options.includeJsonContentType) {
        headers['Content-Type'] = 'application/json';
    }
    return headers;
}
