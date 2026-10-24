import {
    WorkspaceFaviconResolveRequestV1Schema,
    WorkspaceFaviconResolveResponseV1Schema,
    type WorkspaceFaviconResolveRequestV1,
} from '@happier-dev/protocol/workspace/favicon/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProbedResourceCache } from '@happier-dev/protocol/common/probedResourceCache';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type WorkspaceFaviconResult =
    | Readonly<{ status: 'disabled' }>
    | Readonly<{ status: 'missing' }>
    | Readonly<{ status: 'found'; uri: string; relativePath: string }>;

export type ResolveWorkspaceFaviconInput = Readonly<{
    machineId: string;
    workspacePath: string;
    serverId?: string | null;
    enabled?: boolean;
    refresh?: boolean;
    timeoutMs?: number | null;
    signal?: AbortSignal;
}>;

export type WorkspaceFaviconSource = Pick<ResolveWorkspaceFaviconInput, 'serverId' | 'machineId' | 'workspacePath'>;
export type WorkspaceFavicon = Extract<WorkspaceFaviconResult, { status: 'found' }>;

// Keep the existing process-lifetime result cache; only pending work belongs to its readers.
const faviconCache = new ProbedResourceCache<WorkspaceFaviconResult>({
    staleTimeMs: Number.POSITIVE_INFINITY,
    errorCooldownMs: 0,
});

export function clearWorkspaceFaviconCacheForTests(): void {
    faviconCache.clear();
}

/** Observe the existing resource only: observation neither resolves nor retains pending work. */
export function subscribeWorkspaceFaviconResult(source: WorkspaceFaviconSource | null, listener: () => void): () => void {
    return source ? faviconCache.subscribe(buildWorkspaceFaviconCacheKey(source), listener) : () => {};
}

/** Return the stable resource value, not an allocating cache snapshot. Refresh/error means fallback. */
export function readWorkspaceFaviconResult(source: WorkspaceFaviconSource | null): WorkspaceFavicon | null {
    const snapshot = source ? faviconCache.read(buildWorkspaceFaviconCacheKey(source)) : null;
    return snapshot && !snapshot.inflight && !snapshot.error && snapshot.data?.status === 'found'
        ? snapshot.data : null;
}

export async function resolveWorkspaceFavicon(input: ResolveWorkspaceFaviconInput): Promise<WorkspaceFaviconResult> {
    if (input.enabled === false) return { status: 'disabled' };
    const cacheKey = buildWorkspaceFaviconCacheKey(input);
    const result = await faviconCache.ensure(cacheKey,
        (signal) => resolveWorkspaceFaviconUncached({ ...input, signal }),
        { signal: input.signal, force: input.refresh === true });
    if (input.signal?.aborted) {
        throw Object.assign(new Error('Workspace favicon request was aborted'), { name: 'AbortError' });
    }
    const error = faviconCache.read(cacheKey)?.error;
    if (result === null && error) throw error;
    return result ?? { status: 'missing' };
}

async function resolveWorkspaceFaviconUncached(input: ResolveWorkspaceFaviconInput): Promise<WorkspaceFaviconResult> {
    const payload = WorkspaceFaviconResolveRequestV1Schema.parse({
        workspacePath: input.workspacePath,
    } satisfies WorkspaceFaviconResolveRequestV1);

    const response = await machineRpcWithServerScope<unknown, WorkspaceFaviconResolveRequestV1>({
        machineId: input.machineId,
        serverId: input.serverId ?? undefined,
        timeoutMs: input.timeoutMs ?? undefined,
        method: RPC_METHODS.WORKSPACE_FAVICON_RESOLVE,
        payload,
        signal: input.signal,
    });

    const parsed = WorkspaceFaviconResolveResponseV1Schema.safeParse(response);
    if (!parsed.success || !parsed.data.success || !parsed.data.found) {
        return { status: 'missing' };
    }

    return {
        status: 'found',
        uri: `data:${parsed.data.mimeType};base64,${parsed.data.contentBase64}`,
        relativePath: parsed.data.relativePath,
    };
}

function buildWorkspaceFaviconCacheKey(input: WorkspaceFaviconSource): string {
    return [
        input.serverId ?? '',
        input.machineId,
        input.workspacePath,
    ].join('\0');
}
