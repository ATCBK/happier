import { pick } from 'zod/mini';
import type { ArtifactCoarseKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { MemoryDecisionSourceErrorCodeV1Schema } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest, ArtifactUpdateResponse } from '@/sync/domains/artifacts/artifactTypes';
import { HappyError } from '@/utils/errors/errors';
import { createServerFetchForActiveServer, serverFetch, type ServerFetch } from '@/sync/http/client';
import { encodeBase64 } from '@/encryption/base64';
import { ARTIFACT_UPLOAD_CONTENT_TYPE_V1, ARTIFACT_UPLOAD_PATH_V1, encodeArtifactUploadFrameV1,
    type ArtifactUploadDestinationV1 } from '@happier-dev/transfers';
import { ArtifactAccessErrorCodeV1Schema, ArtifactAccessGrantsListResponseV1Schema, ArtifactAccessGrantMutationResponseV1Schema, ArtifactAccessRecipientCensusResponseV1Schema, ArtifactRecipientKeyEnvelopeCommitResponseV1Schema, type ArtifactAccessGrantsListInputV1, type ArtifactAccessGrantSetInputV1, type ArtifactAccessGrantRemoveInputV1, type ArtifactRecipientKeyEnvelopeCommitInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { isPlainArtifactDataKeyMarker } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactPublicAudienceV1ReadSchema, ArtifactRevisionListResponseV1Schema, ArtifactQuotaExceededV1Schema, ArtifactRevisionV1Schema, ArtifactStorageUsageV1Schema, type ArtifactRevisionV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBlobReadResponseV1Schema, ArtifactBlobAccountEncryptionStageV1Schema, type ArtifactBlobStoredContentV1, type ArtifactBlobAccountEncryptionStageV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { ArtifactHtmlPreviewResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { ArtifactReadBatchInputV1Schema, ArtifactReadBatchResponseV1Schema, type ArtifactReadBatchResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createServerHttpRequestBodyItemBudgetV1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createScopedBatchResolutionSingleFlight, createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { readHomeAccountReadRevision } from '@/sync/runtime/orchestration/homeAccountChange';
/** The /v1/artifacts transport cursor; shared by complete sync and Action paging. */
export function encodeArtifactListCursor(row: Readonly<{ artifactId: string; updatedAt: number }>): string {
    return encodeBase64(new TextEncoder().encode(JSON.stringify({ updatedAt: row.updatedAt, id: row.artifactId })), 'base64url');
}

async function uploadArtifactContent(credentials: AuthCredentials, destination: ArtifactUploadDestinationV1,
    content: ArtifactBlobStoredContentV1, opts: Pick<ArtifactApiOptions, 'request' | 'signal'>): Promise<Response> {
    opts.signal?.throwIfAborted();
    const frame = encodeArtifactUploadFrameV1(destination, content);
    return (opts.request ?? serverFetch)(ARTIFACT_UPLOAD_PATH_V1, {
        method: 'POST', body: frame.buffer,
        headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': ARTIFACT_UPLOAD_CONTENT_TYPE_V1 },
        ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
}

export async function stageArtifactBlobAccountEncryptionConversion(credentials: AuthCredentials,
    artifactId: string, blobId: string, content: ArtifactBlobStoredContentV1,
    opts: Pick<ArtifactApiOptions, 'request' | 'signal'> = {}): Promise<ArtifactBlobAccountEncryptionStageV1> {
    const response = await uploadArtifactContent(credentials, { kind: 'encryption-conversion', artifactId, blobId }, content, opts);
    if (!response.ok) throw await readWriteRefusal(response, 'Artifact conversion upload failed');
    const stage = ArtifactBlobAccountEncryptionStageV1Schema.safeParse(await response.json());
    if (!stage.success) throw new HappyError('Artifact conversion upload is unavailable', false, { code: 'artifact_content_unavailable' });
    return stage.data;
}

export async function cancelArtifactBlobAccountEncryptionConversion(credentials: AuthCredentials, uploadId: string,
    opts: Pick<ArtifactApiOptions, 'request'> = {}): Promise<void> {
    const response = await (opts.request ?? serverFetch)(`/v1/artifacts/content/uploads/${encodeURIComponent(uploadId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${credentials.token}` },
    }, { includeAuth: false, retry: 'none' });
    if (!response.ok) throw await readWriteRefusal(response, 'Artifact conversion cancellation failed');
}

/** A write the server refused for an operator storage budget (`quota_exceeded`), naming the budget and its sizes. */
export class ArtifactQuotaExceededError extends HappyError {
    readonly quota: Readonly<{ budget: 'document' | 'account'; limitBytes: number; usedBytes: number }>;
    constructor(quota: ArtifactQuotaExceededError['quota']) {
        super('quota_exceeded', false, { status: 413, code: 'quota_exceeded' });
        // HappyError installs its own prototype; retain this typed quota boundary.
        Object.setPrototypeOf(this, new.target.prototype);
        this.quota = quota;
    }
}

/** The 4xx refusal of a create or update: a typed budget refusal, else the server's message. */
async function readWriteRefusal(response: Response, fallback: string): Promise<HappyError> {
    const value: unknown = await response.json().catch(() => null);
    const quota = response.status === 413 ? ArtifactQuotaExceededV1Schema.safeParse(value) : null;
    if (quota?.success) return new ArtifactQuotaExceededError({ budget: quota.data.budget, limitBytes: quota.data.limitBytes, usedBytes: quota.data.usedBytes });
    const message = value && typeof value === 'object' && typeof Reflect.get(value, 'error') === 'string' ? String(Reflect.get(value, 'error')) : fallback;
    const sourceError = MemoryDecisionSourceErrorCodeV1Schema.safeParse(message);
    return new HappyError(message, false, { status: response.status, ...(sourceError.success ? { code: sourceError.data } : {}) });
}

const artifactAuthorityProjectionSchema = pick(ArtifactAccessRecipientCensusResponseV1Schema, {
    ownerAccountId: true, access: true, encryptionMode: true,
});

function readArtifactResponse(value: unknown): Artifact {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new HappyError('Artifact content is unavailable', false, { code: 'artifact_content_unavailable' });
    }
    const projection = artifactAuthorityProjectionSchema.safeParse({
        ownerAccountId: Reflect.get(value, 'ownerAccountId'),
        access: Reflect.get(value, 'access'),
        encryptionMode: Reflect.get(value, 'encryptionMode'),
    });
    if (!projection.success) {
        throw new HappyError('Artifact content is unavailable', false, { code: 'artifact_content_unavailable' });
    }
    if ((projection.data.encryptionMode === 'plain') !== isPlainArtifactDataKeyMarker(Reflect.get(value, 'dataEncryptionKey'))) {
        throw new HappyError('Artifact content does not match its owner Account mode', false, { code: 'artifact_account_mode_mismatch' });
    }
    return { ...value as Artifact, ...projection.data,
        publicAudience: ArtifactPublicAudienceV1ReadSchema.parse(Reflect.get(value, 'publicAudience')) };
}

export type ArtifactApiOptions = Readonly<{
    serverId?: string;
    coarseKind?: ArtifactCoarseKindV1;
    includeBody?: boolean;
    retry?: 'default' | 'none';
    request?: ServerFetch;
    /** A captured neutral transport; each consumer still owns disclosure admission. */
    readTransport?: CapturedServerReadTransport;
    /** An exact frontier or mutation witness must not borrow an earlier observation. */
    fresh?: boolean;
    limit?: number;
    cursor?: string;
    signal?: AbortSignal;
    /** Inventory selection only; the server remains the access authority. */
    ownerAccountId?: string;
}>;

type ArtifactReadBatchItem = ArtifactReadBatchResponseV1['items'][number];
type ArtifactListPage = Readonly<{ items: Artifact[]; hasUnclassified?: boolean }>;
const artifactDetailReads = createScopedBatchResolutionSingleFlight<ArtifactReadBatchItem>();
const artifactOpaqueReads = createScopedResolutionSingleFlight<Artifact>();
const artifactInventoryReads = createScopedResolutionSingleFlight<ArtifactListPage>();

function captureArtifactReadBinding(opts: Pick<ArtifactApiOptions, 'request' | 'readTransport'>) {
    const active = getActiveServerSnapshot();
    const activeRequest = opts.request ? undefined : createServerFetchForActiveServer(active);
    // Opaque callbacks may own another caller's cancellation or carrier lease.
    // Only a proven neutral binding can share its physical continuation.
    const scope = opts.readTransport?.key ?? (opts.request ? {} : JSON.stringify([
        active.serverId, active.serverUrl, active.generation, readHomeAccountReadRevision(active.serverId),
    ]));
    const read = async <T>(path: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> => {
        const options = { includeAuth: false, retry: 'none' } as const;
        if (opts.readTransport) return opts.readTransport.read(path, init, options, consume);
        if (activeRequest) return activeRequest(path, init, options, consume);
        return consume(await opts.request!(path, init, options));
    };
    return { scope, read };
}

/** Both HTTP read forms retain the incumbent single-read status classification. */
async function artifactHttpReadError(response: Response, fallback: string, code?: string): Promise<HappyError> {
    if (response.status === 404) {
        return new HappyError('Artifact not found', false, { status: 404, code: code ?? 'not_found' });
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        let message = fallback;
        const value: unknown = await response.json().catch(() => null);
        if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') message = value.error;
        return new HappyError(message, false, { status: response.status,
            ...(code ? { code } : response.status === 401 || response.status === 403 ? { code: 'content_unavailable' } : {}) });
    }
    return new HappyError(`${fallback}: ${response.status}`, true, { status: response.status, ...(code ? { code } : {}) });
}

/** Read only the selected details and their current authorized recipient census. */
export async function fetchArtifactReadBatch(credentials: AuthCredentials, artifactIds: readonly string[],
    opts: Pick<ArtifactApiOptions, 'request' | 'signal' | 'readTransport' | 'fresh'> = {}): Promise<ArtifactReadBatchResponseV1['items']> {
    throwIfAborted(opts.signal);
    if (artifactIds.length === 0) return [];
    ArtifactReadBatchInputV1Schema.parse({ artifactIds });
    const binding = captureArtifactReadBinding(opts);
    const result = await artifactDetailReads.run(JSON.stringify(['artifact-detail-census', resolveAuthCredentialsScopeKey(credentials)]),
        artifactIds, async (demandedIds, sharedSignal) => {
            const items = new Map<string, ArtifactReadBatchItem>();
            const batches: string[][] = [];
            let batch: string[] = [];
            let budget = createServerHttpRequestBodyItemBudgetV1({ artifactIds: [] });
            for (const id of demandedIds) {
                if (!budget.tryAdmit(id)) {
                    if (batch.length === 0) throw new HappyError('Artifact identity exceeds the HTTP request body limit', false, { status: 413 });
                    batches.push(batch);
                    batch = [];
                    budget = createServerHttpRequestBodyItemBudgetV1({ artifactIds: [] });
                    if (!budget.tryAdmit(id)) throw new HappyError('Artifact identity exceeds the HTTP request body limit', false, { status: 413 });
                }
                batch.push(id);
            }
            if (batch.length) batches.push(batch);
            for (const ids of batches) {
                throwIfAborted(sharedSignal);
                const consume = async (response: Response) => {
                    if (!response.ok) throw await artifactHttpReadError(response, 'Artifact details are unavailable', 'artifact_content_unavailable');
                    const parsed = ArtifactReadBatchResponseV1Schema.safeParse(await response.json());
                    throwIfAborted(sharedSignal);
                    if (!parsed.success || parsed.data.items.length !== ids.length
                        || parsed.data.items.some((item, index) => item.artifactId !== ids[index])) {
                        throw new HappyError('Artifact detail inventory is incomplete', false, { code: 'artifact_content_unavailable' });
                    }
                    for (const item of parsed.data.items) if (item.ok) readArtifactResponse(item.artifact);
                    return parsed.data.items;
                };
                const init = { method: 'POST', headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(ArtifactReadBatchInputV1Schema.parse({ artifactIds: ids })), signal: sharedSignal };
                const page = await binding.read('/v1/artifacts/read', init, consume);
                for (const item of page) items.set(item.artifactId, item);
            }
            return items;
        }, { scope: binding.scope, signal: opts.signal, fresh: opts.fresh });
    throwIfAborted(opts.signal);
    return artifactIds.map(id => {
        const item = result.get(id);
        if (!item) throw new HappyError('Artifact detail inventory is incomplete', false, { code: 'artifact_content_unavailable' });
        return item;
    });
}

/** The Home supplies only the isolated shell location, never opened HTML or a public grant. */
export async function fetchArtifactHtmlPreviewLocation(credentials: AuthCredentials, artifactId: string,
    opts: Pick<ArtifactApiOptions, 'request' | 'signal'> = {}): Promise<string> {
    opts.signal?.throwIfAborted();
    const response = await (opts.request ?? serverFetch)(`/v1/artifacts/${encodeURIComponent(artifactId)}/html-preview`, {
        headers: { Authorization: `Bearer ${credentials.token}` }, ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
    opts.signal?.throwIfAborted();
    if (!response.ok) throw new HappyError('HTML preview is unavailable', false,
        { status: response.status, code: 'artifact_html_preview_unavailable' });
    const parsed = ArtifactHtmlPreviewResponseV1Schema.safeParse(await response.json());
    opts.signal?.throwIfAborted();
    if (!parsed.success || new URL(parsed.data.url).pathname !== `/a/${encodeURIComponent(artifactId)}`)
        throw new HappyError('HTML preview is unavailable', false, { code: 'artifact_html_preview_unavailable' });
    return parsed.data.url;
}

/** Authenticated bytes only: verify the requested identity and owner mode before opening. */
export async function fetchArtifactBlob(credentials: AuthCredentials, artifactId: string, blobId: string,
    ownerMode: 'plain' | 'e2ee', opts: Pick<ArtifactApiOptions, 'request' | 'signal'> = {}) {
    opts.signal?.throwIfAborted();
    const response = await (opts.request ?? serverFetch)(`/v1/artifacts/${encodeURIComponent(artifactId)}/blobs/${encodeURIComponent(blobId)}`, {
        headers: { Authorization: `Bearer ${credentials.token}` }, ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
    opts.signal?.throwIfAborted();
    if (!response.ok) throw new HappyError('Artifact file is unavailable', false,
        { status: response.status, code: 'artifact_content_unavailable' });
    const parsed = ArtifactBlobReadResponseV1Schema.safeParse(await response.json());
    opts.signal?.throwIfAborted();
    if (!parsed.success || parsed.data.blobId !== blobId) throw new HappyError('Artifact file is unavailable', false,
        { code: 'artifact_content_unavailable' });
    if ((ownerMode === 'plain') !== (parsed.data.content.t === 'plain')) throw new HappyError('Artifact file does not match its owner Account mode', false,
        { code: 'artifact_account_mode_mismatch' });
    return parsed.data;
}

/** Read the complete retained-body inventory through the captured Account transport. */
export async function fetchArtifactRevisions(
    credentials: AuthCredentials,
    artifactId: string,
    opts: Pick<ArtifactApiOptions, 'request' | 'signal'> = {},
) {
    opts.signal?.throwIfAborted();
    const response = await (opts.request ?? serverFetch)(`/v1/artifacts/${encodeURIComponent(artifactId)}/revisions`, {
        headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
    opts.signal?.throwIfAborted();
    if (!response.ok) {
        throw new HappyError('Artifact revisions are unavailable', false, { status: response.status, code: 'artifact_content_unavailable' });
    }
    const parsed = ArtifactRevisionListResponseV1Schema.safeParse(await response.json());
    opts.signal?.throwIfAborted();
    if (!parsed.success) throw new HappyError('Artifact revision inventory is incomplete', false, { code: 'artifact_content_unavailable' });
    return parsed.data;
}

export async function fetchArtifactStorageUsage(credentials: AuthCredentials,
    opts: Pick<ArtifactApiOptions, 'request' | 'signal'> = {}) {
    opts.signal?.throwIfAborted();
    const response = await (opts.request ?? serverFetch)('/v1/artifacts/storage/usage', {
        headers: { Authorization: `Bearer ${credentials.token}` },
        ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
    opts.signal?.throwIfAborted();
    if (!response.ok) throw new HappyError('Artifact storage usage is unavailable', false,
        { status: response.status, code: 'content_unavailable' });
    const parsed = ArtifactStorageUsageV1Schema.safeParse(await response.json());
    opts.signal?.throwIfAborted();
    if (!parsed.success) throw new HappyError('Artifact storage usage is unavailable', false, { code: 'content_unavailable' });
    return parsed.data;
}

/** The key holder may reseal the selected body with new restore attribution; its content stays unchanged. */
export async function restoreArtifactRevision(credentials: AuthCredentials, input: Readonly<{
    kind?: ArtifactCoarseKindV1;
    artifactId: string; bodyVersion: number; header: string; body?: string; expectedRevision: ArtifactRevisionV1;
    provenance?: string | null; provenanceDataEncryptionKey?: string | null;
}>, opts: Pick<ArtifactApiOptions, 'request' | 'signal' | 'serverId'> = {}): Promise<ArtifactRevisionV1> {
    opts.signal?.throwIfAborted();
    const response = await (opts.request ?? serverFetch)(`/v1/artifacts/${encodeURIComponent(input.artifactId)}/revisions/${input.bodyVersion}/restore`, {
        method: 'POST', headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ header: input.header, ...(input.kind ? { kind: input.kind } : {}), expectedHeaderVersion: input.expectedRevision.headerVersion,
            expectedBodyVersion: input.expectedRevision.bodyVersion, ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
            ...(input.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: input.provenanceDataEncryptionKey }) }),
        ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
    opts.signal?.throwIfAborted();
    if (!response.ok) throw await readWriteRefusal(response, 'Artifact restore failed');
    const value: unknown = await response.json();
    opts.signal?.throwIfAborted();
    if (value && typeof value === 'object' && Reflect.get(value, 'success') === false
        && Reflect.get(value, 'error') === 'version-mismatch') {
        throw new HappyError('Artifact was modified by another client', false, { code: 'version_mismatch' });
    }
    const revision = ArtifactRevisionV1Schema.safeParse(value && typeof value === 'object' ? {
        headerVersion: Reflect.get(value, 'headerVersion'), bodyVersion: Reflect.get(value, 'bodyVersion'),
    } : null);
    if (!value || typeof value !== 'object' || Reflect.get(value, 'success') !== true || !revision.success)
        throw new HappyError('Artifact restore result is unavailable', false, { code: 'content_unavailable' });
    return revision.data;
}

/** The existing Artifact HTTP owner carries grants and fenced recipient keys. */
export function createArtifactAccessApi(credentials: AuthCredentials, opts: Pick<ArtifactApiOptions, 'request'> = {}) {
    const send = async <T>(artifactId: string, leaf: string, schema: { parse: (value: unknown) => T },
        method?: string, input?: unknown, signal?: AbortSignal): Promise<T> => {
        signal?.throwIfAborted();
        const response = await (opts.request ?? serverFetch)(`/v1/artifacts/${encodeURIComponent(artifactId)}/access/${leaf}`, {
            ...(method ? { method } : {}),
            headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
            ...(signal ? { signal } : {}),
        }, { includeAuth: false, retry: 'none' });
        signal?.throwIfAborted();
        const value: unknown = await response.json().catch(() => null);
        signal?.throwIfAborted();
        if (!response.ok) {
            const known = ArtifactAccessErrorCodeV1Schema.safeParse(value && typeof value === 'object' ? Reflect.get(value, 'error') : undefined);
            const code = known.success ? known.data
                : response.status === 404 || response.status === 405 ? 'artifact_access_unavailable' : 'artifact_access_failed';
            throw Object.assign(new Error(code), { code });
        }
        return schema.parse(value);
    };
    return {
        list: (input: ArtifactAccessGrantsListInputV1, signal?: AbortSignal) =>
            send(input.artifactId, 'grants', ArtifactAccessGrantsListResponseV1Schema, undefined, undefined, signal),
        set: (input: ArtifactAccessGrantSetInputV1, signal?: AbortSignal) =>
            send(input.artifactId, 'grants', ArtifactAccessGrantMutationResponseV1Schema, 'PUT', input, signal),
        remove: (input: ArtifactAccessGrantRemoveInputV1, signal?: AbortSignal) =>
            send(input.artifactId, 'grants', ArtifactAccessGrantMutationResponseV1Schema, 'DELETE', input, signal),
        readRecipients: (artifactId: string, signal?: AbortSignal) =>
            send(artifactId, 'recipients', ArtifactAccessRecipientCensusResponseV1Schema, undefined, undefined, signal),
        commitKeyEnvelopes: (input: ArtifactRecipientKeyEnvelopeCommitInputV1, signal?: AbortSignal) =>
            send(input.artifactId, 'key-envelopes', ArtifactRecipientKeyEnvelopeCommitResponseV1Schema, 'POST', input, signal),
    };
}

/**
 * Fetch all artifacts for the account
 */
export async function fetchArtifacts(
    credentials: AuthCredentials,
    opts: ArtifactApiOptions = {},
): Promise<Artifact[]> {
    return (await fetchArtifactListPage(credentials, opts)).items;
}

export async function fetchArtifactListPage(credentials: AuthCredentials, opts: ArtifactApiOptions = {}): Promise<ArtifactListPage> {
    throwIfAborted(opts.signal);
    const binding = captureArtifactReadBinding(opts);
    const filtered = opts.coarseKind !== undefined;
    const query = new URLSearchParams();
    if (opts.limit !== undefined) query.set('limit', String(opts.limit));
    if (opts.cursor !== undefined) query.set('cursor', opts.cursor);
    if (opts.includeBody) query.set('includeBody', 'true');
    if (filtered && opts.coarseKind) query.set('kind', opts.coarseKind);
    const search = query.toString();
    const key = JSON.stringify(['artifact-inventory', resolveAuthCredentialsScopeKey(credentials), search, opts.ownerAccountId, opts.retry ?? 'default']);
    const result = await artifactInventoryReads.run(key, async sharedSignal => {
        const run = () => {
            throwIfAborted(sharedSignal);
            return binding.read(`/v1/artifacts${search ? `?${search}` : ''}`, {
                signal: sharedSignal,
                headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            }, async response => {
                throwIfAborted(sharedSignal);
                if (!response.ok) {
                    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                        let message = 'Failed to fetch artifacts';
                        const error: unknown = await response.json().catch(() => null);
                        if (error && typeof error === 'object' && typeof Reflect.get(error, 'error') === 'string') message = String(Reflect.get(error, 'error'));
                        throw new HappyError(message, false, { status: response.status, ...(response.status === 400 ? { code: 'invalid_cursor' } : {}) });
                    }
                    throw new HappyError(`Failed to fetch artifacts: ${response.status}`, true, { status: response.status });
                }
                const value: unknown = await response.json();
                throwIfAborted(sharedSignal);
                const items: unknown = filtered && value && typeof value === 'object' ? Reflect.get(value, 'items') : value;
                const hasUnclassified: unknown = filtered && value && typeof value === 'object' ? Reflect.get(value, 'hasUnclassified') : undefined;
                if (!Array.isArray(items) || (filtered && typeof hasUnclassified !== 'boolean')) {
                    throw new HappyError('Artifact content is unavailable', false, { code: 'artifact_content_unavailable' });
                }
                const data = items.map(readArtifactResponse);
                return { items: opts.ownerAccountId === undefined ? data : data.filter(artifact => artifact.ownerAccountId === opts.ownerAccountId),
                    ...(filtered ? { hasUnclassified: hasUnclassified as boolean } : {}) };
            });
        };
        return opts.retry === 'none' ? run() : backoff(run);
    }, { scope: binding.scope, signal: opts.signal, fresh: opts.fresh });
    throwIfAborted(opts.signal);
    return result;
}

/**
 * Fetch a single artifact with full body
 */
export async function fetchArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    opts: ArtifactApiOptions = {},
): Promise<Artifact> {
    throwIfAborted(opts.signal);
    const binding = captureArtifactReadBinding(opts);
    const key = JSON.stringify(['artifact-opaque-detail', resolveAuthCredentialsScopeKey(credentials), artifactId, opts.retry ?? 'default']);
    const result = await artifactOpaqueReads.run(key, async sharedSignal => {
        const run = () => {
            throwIfAborted(sharedSignal);
            return binding.read(`/v1/artifacts/${artifactId}`, {
                signal: sharedSignal,
                headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            }, async response => {
                throwIfAborted(sharedSignal);
                if (!response.ok) throw await artifactHttpReadError(response, 'Failed to fetch artifact');
                const value: unknown = await response.json();
                throwIfAborted(sharedSignal);
                return readArtifactResponse(value);
            });
        };
        return opts.retry === 'none' ? run() : backoff(run);
    }, { scope: binding.scope, signal: opts.signal, fresh: opts.fresh });
    throwIfAborted(opts.signal);
    return result;
}

/**
 * Create a new artifact
 */
export async function createArtifact(
    credentials: AuthCredentials, 
    request: ArtifactCreateRequest,
    opts: ArtifactApiOptions = {},
): Promise<Artifact> {
    opts.signal?.throwIfAborted();
    if (request.memoryDecisionSource && request.blob)
        throw new HappyError('memory_decision_source_unsupported', false, { code: 'memory_decision_source_unsupported' });
    const artifactRequest = opts.request ?? (() => {
        const focusedRequest = createServerFetchForActiveServer();
        return ((path, init, options) => focusedRequest(path, init, { includeAuth: false, ...options })) satisfies ServerFetch;
    })();
    const scopedOptions = { ...opts, request: artifactRequest };
    const run = async () => {
        const path = request.memoryDecisionSource ? '/v1/artifacts/memory-decision/create'
            : request.blob ? '/v1/artifacts/content/binary' : '/v1/artifacts';
        const response = request.blob?.content
            ? await uploadArtifactContent(credentials, { kind: 'create', artifactId: request.id, blobId: request.blob.blobId,
                ...(request.kind ? { artifactKind: request.kind } : {}),
                header: request.header, body: request.body, dataEncryptionKey: request.dataEncryptionKey,
                provenance: request.provenance, provenanceDataEncryptionKey: request.provenanceDataEncryptionKey }, request.blob.content, scopedOptions)
            : await artifactRequest(path, {
            method: 'POST',
            ...(opts.signal ? { signal: opts.signal } : {}),
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                const refusal = await readWriteRefusal(response, 'Failed to create artifact');
                if (response.status === 404 && request.memoryDecisionSource && !MemoryDecisionSourceErrorCodeV1Schema.safeParse(refusal.code).success)
                    throw new HappyError('memory_decision_source_unsupported', false, { status: 404, code: 'memory_decision_source_unsupported' });
                if (response.status === 409 && !MemoryDecisionSourceErrorCodeV1Schema.safeParse(refusal.code).success)
                    throw new HappyError('Artifact ID already exists', false, { status: 409, code: 'conflict' });
                throw refusal;
            }
            throw new HappyError(`Failed to create artifact: ${response.status}`, true, { status: response.status });
        }

        return readArtifactResponse(await response.json());
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}

/**
 * Update an existing artifact
 */
export async function updateArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    request: ArtifactUpdateRequest,
    opts: ArtifactApiOptions = {},
): Promise<ArtifactUpdateResponse> {
    opts.signal?.throwIfAborted();
    if (request.memoryDecisionSource && request.blob)
        throw new HappyError('memory_decision_source_unsupported', false, { code: 'memory_decision_source_unsupported' });
    const artifactRequest = opts.request ?? (() => {
        const focusedRequest = createServerFetchForActiveServer();
        return ((path, init, options) => focusedRequest(path, init, { includeAuth: false, ...options })) satisfies ServerFetch;
    })();
    const scopedOptions = { ...opts, request: artifactRequest };
    const run = async () => {
        const path = `/v1/artifacts/${encodeURIComponent(artifactId)}${request.memoryDecisionSource ? '/memory-decision'
            : request.blob !== undefined ? '/content/binary' : ''}`;
        if (request.blob?.content && (request.body === undefined || request.expectedBodyVersion === undefined)) {
            throw new HappyError('Artifact binary update requires its body revision', false, { status: 400 });
        }
        const response = request.blob?.content && request.body !== undefined && request.expectedBodyVersion !== undefined
            ? await uploadArtifactContent(credentials, { kind: 'update', artifactId, blobId: request.blob.blobId,
                ...(request.kind ? { artifactKind: request.kind } : {}),
                header: request.header, expectedHeaderVersion: request.expectedHeaderVersion,
                body: request.body, expectedBodyVersion: request.expectedBodyVersion,
                provenance: request.provenance, provenanceDataEncryptionKey: request.provenanceDataEncryptionKey }, request.blob.content, scopedOptions)
            : await artifactRequest(path, {
            method: 'POST',
            ...(opts.signal ? { signal: opts.signal } : {}),
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                const refusal = await readWriteRefusal(response, 'Failed to update artifact');
                if (response.status === 404 && request.memoryDecisionSource && refusal.message !== 'Artifact not found'
                    && !MemoryDecisionSourceErrorCodeV1Schema.safeParse(refusal.code).success)
                    throw new HappyError('memory_decision_source_unsupported', false, { status: 404, code: 'memory_decision_source_unsupported' });
                if (response.status === 404 && !MemoryDecisionSourceErrorCodeV1Schema.safeParse(refusal.code).success)
                    throw new HappyError('Artifact not found', false, { status: 404, code: 'not_found' });
                throw refusal;
            }
            throw new HappyError(`Failed to update artifact: ${response.status}`, true, { status: response.status });
        }

        const data = await response.json() as ArtifactUpdateResponse;
        return data;
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}

/**
 * Delete an artifact
 */
export async function deleteArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    opts: ArtifactApiOptions & Readonly<{ expectedRevision?: Readonly<{ headerVersion: number; bodyVersion: number }>; onTransportIssued?: () => void }> = {},
): Promise<void> {
    const request = opts.request ?? createServerFetchForActiveServer();
    const run = async () => {
        opts.signal?.throwIfAborted();
        const revision = opts.expectedRevision;
        const path = `/v1/artifacts/${encodeURIComponent(artifactId)}${revision ? `/revision/${revision.headerVersion}/${revision.bodyVersion}` : ''}`;
        const response = await request(path, {
            method: 'DELETE',
            ...(opts.signal ? { signal: opts.signal } : {}),
            headers: {
                'Authorization': `Bearer ${credentials.token}`
            }
        }, { includeAuth: false, retry: opts.retry,
            ...(opts.onTransportIssued ? { onIssued: opts.onTransportIssued } : {}),
        });

        if (!response.ok) {
            if (response.status === 409 && revision) {
                throw new HappyError('Artifact revision changed', false, { status: 409, code: 'version_mismatch' });
            }
            if (response.status === 404) {
                throw new HappyError('Artifact not found', false, { status: 404, code: 'not_found' });
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to delete artifact';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: response.status });
            }
            throw new HappyError(`Failed to delete artifact: ${response.status}`, true, { status: response.status });
        }
    };

    // The Home may have committed before its acknowledgement was lost. Replaying
    // DELETE would turn that unknown outcome into a misleading not-found result.
    await run();
}
