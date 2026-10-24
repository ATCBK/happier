import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { deriveArtifactKindV1, tryDeriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { areCredentialsEqual } from '@/auth/storage/tokenStorage';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { digest } from '@/platform/digest';
import { fetchChanges, fetchCurrentChangesCursor } from '@/sync/api/session/apiChanges';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { loadArtifactInventoryWarmCache, saveArtifactInventoryWarmCache, type ArtifactInventoryWarmCache } from '@/sync/domains/state/warmCachePersistence';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { encodeBase64 } from '@/encryption/base64';
import { log } from '@/log';
import { randomUUID } from '@/platform/randomUUID';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { createServerFetchForActiveServer, type ServerFetch } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    type ArtifactApiOptions,
    createArtifact as createArtifactApi,
    createArtifactAccessApi,
    fetchArtifact as fetchArtifactApi,
    fetchArtifacts as fetchArtifactsApi,
    fetchArtifactReadBatch,
    encodeArtifactListCursor,
    updateArtifact as updateArtifactApi,
    fetchArtifactRevisions,
    fetchArtifactBlob,
    fetchArtifactHtmlPreviewLocation,
    restoreArtifactRevision,
} from '@/sync/api/artifacts/apiArtifacts';
import type { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption, projectArtifactHeaderForDisplay } from '@/sync/encryption/artifactEncryption';
import { HappyError } from '@/utils/errors/errors';
import { parseToken } from '@/utils/auth/parseToken';
import type {
    Artifact,
    ArtifactBodyInput,
    ArtifactCreateRequest,
    ArtifactLockedReason,
    ArtifactHtmlPreview,
    ArtifactUpdateRequest,
    DecryptedArtifact,
} from '@/sync/domains/artifacts/artifactTypes';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, isPlainArtifactDataKeyMarker } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactBodyV1Schema, ArtifactBodyEnvelopeV1StoredSchema, ArtifactSavedByV1Schema, type ArtifactBodyEnvelopeV1, type ArtifactSavedByV1, type ArtifactWorkspaceSourceV1, ArtifactBlobReferenceV1Schema, type ArtifactBlobReferenceV1, type ArtifactBodyV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { artifactKindHasSharedWidgetInputsV1, artifactKindRequiresTextBodyV1, getArtifactUseTargetV1, readArtifactSharedAudienceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { runArtifactRecipientKeyPreparationV1, prepareArtifactRecipientKeyEnvelopesV1 } from '@happier-dev/protocol/artifacts/artifactRecipientKeyPreparationV1';
import { withArtifactExcerptV1 } from '@happier-dev/protocol/artifacts/artifactExcerptV1';
import { canShareArtifactWriteContentV1, prepareArtifactHeaderForRevisionV1, prepareArtifactHeaderForBodyV1 } from '@happier-dev/protocol/artifacts/artifactHeaderRestorationV1';
import { ArtifactPublicAudienceV1ReadSchema, type ArtifactRevisionV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { isArtifactHtmlHeaderV1, artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { listArtifactHeadersV1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { readAccountNoticeArtifactHeaderV1, readUsageNoticeArtifactHeaderV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { hashArtifactBinaryContent, openArtifactBinaryContent, sealArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { openArtifactPrivateRevisionMetadata, sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import type { ArtifactRevisionProvenanceV1 } from '@happier-dev/protocol';
import type { ArtifactAccessRecipientCensusResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

function prepareArtifactBody(input: ArtifactBodyInput): ArtifactBodyV1 | null {
    if (input !== null && typeof input === 'object' && 'bytes' in input) return ArtifactBlobReferenceV1Schema.parse({
        blobId: randomUUID(), mime: input.mime, sizeBytes: input.bytes.length, sha256: hashArtifactBinaryContent(input.bytes),
    });
    return input === null ? null : ArtifactBodyV1Schema.parse(input);
}

function requireArtifactBodyKind(header: Readonly<Record<string, unknown>>, body: ArtifactBodyV1 | null): void {
    if (body !== null && typeof body !== 'string' && artifactKindRequiresTextBodyV1(header.kind)) {
        throw new HappyError('This Artifact kind requires text content', false, { code: 'artifact_invalid_body' });
    }
}

async function requireArtifactHtmlWriteContent(params: Readonly<{
    header: Readonly<Record<string, unknown>>;
    body: ArtifactBodyInput;
    signal?: AbortSignal;
    readReference?: (reference: ArtifactBlobReferenceV1) => Promise<Uint8Array>;
}>): Promise<void> {
    if (!isArtifactHtmlHeaderV1(params.header)) return;
    try {
        if (typeof params.body === 'string') artifactHtmlBundleFromBodyV1(params.body);
        else if (params.body !== null && 'bytes' in params.body) artifactHtmlBundleFromBodyV1(params.body.bytes, params.body.mime);
        else if (params.body !== null && params.readReference) {
            artifactHtmlBundleFromBodyV1(await params.readReference(params.body), params.body.mime);
        } else throw new Error('HTML content is unavailable');
    } catch {
        throwIfAborted(params.signal);
        throw new HappyError('HTML Artifact content is invalid', false, { code: 'artifact_html_content_invalid' });
    }
}

function artifactStorageIdentity(artifact: Pick<Artifact, 'dataEncryptionKey' | 'provenanceDataEncryptionKey'>) {
    return { contentKeyEnvelope: artifact.dataEncryptionKey,
        provenanceKeyEnvelope: artifact.provenanceDataEncryptionKey ?? null };
}

function artifactAccessProjection(artifact: Artifact) {
    return { kind: artifact.kind, ...(Object.hasOwn(artifact, 'kindHint') ? { kindHint: artifact.kindHint } : {}),
        access: artifact.access, ownerAccountId: artifact.ownerAccountId,
        publicAudience: ArtifactPublicAudienceV1ReadSchema.parse(artifact.publicAudience),
        storageIdentity: artifactStorageIdentity(artifact) };
}

async function sharedArtifactWriteContext(params: Readonly<{
    credentials: AuthCredentials; request?: ArtifactApiOptions['request']; signal?: AbortSignal;
    serverId?: string; readTransport?: ArtifactApiOptions['readTransport'];
    artifactId: string; current: DecryptedArtifact; header: Readonly<Record<string, unknown>>; candidateBody?: ArtifactBodyV1 | null;
}>) {
    const currentHeader = params.current.rawHeader;
    if (!artifactKindHasSharedWidgetInputsV1(currentHeader?.kind) && !artifactKindHasSharedWidgetInputsV1(params.header.kind)) return undefined;
    if (!currentHeader) throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
    const candidate = { artifactId: params.artifactId, header: currentHeader,
        ownerAccountId: params.current.ownerAccountId, access: params.current.access };
    if (params.candidateBody !== undefined && canShareArtifactWriteContentV1(candidate, params.header, params.candidateBody)) return undefined;
    // A cached private row can precede publication. Re-read exposure at the same
    // authenticated boundary as CLI writes instead of trusting cached none.
    const artifact = await fetchArtifactApi(params.credentials, params.artifactId, { ...params, fresh: true });
    const current = { ...candidate, ownerAccountId: artifact.ownerAccountId, access: artifact.access,
        publicAudience: artifact.publicAudience };
    const shared = await readArtifactSharedAudienceV1({ current, signal: params.signal,
        readGrants: () => createArtifactAccessApi(params.credentials, params).list({ artifactId: params.artifactId }, params.signal) });
    throwIfAborted(params.signal);
    return { current, shared };
}

type ArtifactContentProjection = Omit<Artifact, 'ownerAccountId' | 'access' | 'encryptionMode'>
    & Partial<Pick<Artifact, 'ownerAccountId' | 'access'>>;

/**
 * An unwrapped artifact data key together with the exact wrapped envelope it came
 * from. Unwrapping is a pure function of (envelope, account content key) and the
 * account content key is fixed for the lifetime of an `Encryption` instance, so a
 * byte-identical envelope never has to be opened twice. Keeping the envelope beside
 * the key is what makes "unchanged" checkable — a bare key cannot tell a rotated
 * envelope from an unchanged one, which is why the previous cache was written on
 * every refresh and read by no refresh.
 */
export type ArtifactDataKeyCacheEntry = Readonly<{
    envelope: string;
    dataKey: Uint8Array;
    /**
     * The opened list header beside the exact ciphertext it came from. Opening is a pure
     * function of (data key, ciphertext), so a refresh whose header is byte-identical
     * reuses it instead of opening every row of an unchanged inventory again.
     */
    header?: Readonly<{ ciphertext: string; raw: Readonly<Record<string, unknown>> }>;
    provenanceEnvelope?: string | null;
    provenanceDataKey?: Uint8Array;
}>;

export type ArtifactDataKeyCache = Map<string, ArtifactDataKeyCacheEntry>;

/**
 * Single owner of "which artifact data keys must actually be unwrapped".
 *
 * Reuses every entry whose server-reported envelope is byte-identical, opens the
 * remainder in ONE batch (`decryptEncryptionKeys` owns the native-worker routing
 * decision and can only make it for a batch it is given whole), and drops the
 * cached entry for any artifact whose envelope failed to open so a rotated key is
 * never served from a stale unwrap. Plaintext-mode artifacts carry a marker rather
 * than an envelope and never reach the batch.
 */
async function resolveArtifactDataKeys(params: {
    artifacts: readonly Pick<Artifact, 'id' | 'dataEncryptionKey'>[];
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
}): Promise<Map<string, Uint8Array | null>> {
    const { artifacts, encryption, artifactDataKeys } = params;

    const resolved = new Map<string, Uint8Array | null>();
    const pendingArtifactIds: string[] = [];
    const pendingEnvelopes: string[] = [];

    for (const artifact of artifacts) {
        const envelope = artifact.dataEncryptionKey;
        if (
            typeof envelope !== 'string'
            || envelope.length === 0
            || isPlainArtifactDataKeyMarker(envelope)
        ) {
            artifactDataKeys.delete(artifact.id);
            resolved.set(artifact.id, null);
            continue;
        }
        const cached = artifactDataKeys.get(artifact.id);
        if (cached && cached.envelope === envelope) {
            resolved.set(artifact.id, cached.dataKey);
            continue;
        }
        pendingArtifactIds.push(artifact.id);
        pendingEnvelopes.push(envelope);
    }

    if (pendingEnvelopes.length === 0) {
        return resolved;
    }

    let decryptedKeys: Array<Uint8Array | null>;
    if (!encryption) {
        decryptedKeys = pendingEnvelopes.map(() => null);
    } else {
        // Runtime/worker failures must reach InvalidateSync. Only a completed
        // cryptographic refusal (null) establishes a locked row.
        decryptedKeys = await encryption.decryptEncryptionKeys(pendingEnvelopes);
    }

    for (let index = 0; index < pendingArtifactIds.length; index += 1) {
        const artifactId = pendingArtifactIds[index]!;
        const dataKey = decryptedKeys[index] ?? null;
        if (!dataKey) {
            // A rotated envelope that fails to open must not leave the previous key
            // cached: the next refresh would reuse a key this artifact no longer uses.
            artifactDataKeys.delete(artifactId);
            resolved.set(artifactId, null);
            continue;
        }
        // A different content envelope replaces its custody; private metadata is
        // recovered from the current authenticated row rather than a losing create.
        artifactDataKeys.set(artifactId, { envelope: pendingEnvelopes[index]!, dataKey });
        resolved.set(artifactId, dataKey);
    }

    return resolved;
}

async function resolveArtifactDataKey(params: {
    artifact: Pick<Artifact, 'id' | 'dataEncryptionKey'>;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
}): Promise<Uint8Array | null> {
    const resolved = await resolveArtifactDataKeys({
        artifacts: [params.artifact],
        encryption: params.encryption,
        artifactDataKeys: params.artifactDataKeys,
    });
    return resolved.get(params.artifact.id) ?? null;
}

function requireArtifactEncryption(encryption: Encryption | null): Encryption {
    if (!encryption) {
        throw new Error('Account encryption material is unavailable for an encrypted artifact');
    }
    return encryption;
}

function decodePlainArtifactHeaderRaw(value: string): Readonly<Record<string, unknown>> {
    const decoded = decodePlainArtifactStoredContent(value);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('Invalid plaintext artifact header');
    }
    return decoded as Readonly<Record<string, unknown>>;
}

function decodePlainArtifactHeader(value: string): ArtifactHeader {
    return projectArtifactHeaderForDisplay(decodePlainArtifactHeaderRaw(value));
}

function decodePlainArtifactBody(value: string): ArtifactBodyEnvelopeV1 {
    const decoded = decodePlainArtifactStoredContent(value);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('Invalid plaintext artifact body');
    }
    return ArtifactBodyEnvelopeV1StoredSchema.parse(decoded);
}

function artifactRevisionProvenance(credentials: AuthCredentials, savedBy?: ArtifactSavedByV1,
    restoredFromBodyVersion?: number, source?: ArtifactWorkspaceSourceV1): ArtifactRevisionProvenanceV1 | undefined {
    let actor = savedBy;
    if (!actor) {
        try { actor = ArtifactSavedByV1Schema.parse({ kind: 'person', accountId: parseToken(credentials.token) }); }
        catch { /* No attributable Account without an authenticated token subject. */ }
    }
    return actor ? { savedBy: actor, ...(source ? { source } : {}), ...(restoredFromBodyVersion === undefined ? {} : { restoredFromBodyVersion }) } : undefined;
}

async function resolveArtifactProvenanceDataKey(params: Readonly<{
    artifact: Pick<Artifact, 'id' | 'provenanceDataEncryptionKey'>;
    encryption: Encryption | null; artifactDataKeys: ArtifactDataKeyCache;
}>): Promise<Uint8Array | null> {
    const envelope = params.artifact.provenanceDataEncryptionKey;
    const cached = params.artifactDataKeys.get(params.artifact.id);
    if (!envelope) return null;
    if (cached?.provenanceEnvelope === envelope && cached.provenanceDataKey) return cached.provenanceDataKey;
    const dataKey = params.encryption ? await params.encryption.decryptEncryptionKey(envelope) : null;
    if (cached) params.artifactDataKeys.set(params.artifact.id, { ...cached, provenanceEnvelope: envelope,
        provenanceDataKey: dataKey ?? undefined });
    return dataKey;
}

async function openArtifactProvenance(params: Readonly<{
    artifact: Pick<Artifact, 'id' | 'provenance' | 'provenanceDataEncryptionKey' | 'bodyVersion'>;
    mode: 'plain' | 'e2ee'; encryption: Encryption | null; artifactDataKeys: ArtifactDataKeyCache;
    resolvedProvenanceDataKey?: Uint8Array | null;
}>) {
    const dataKey = params.mode === 'e2ee' ? params.resolvedProvenanceDataKey !== undefined
        ? params.resolvedProvenanceDataKey : await resolveArtifactProvenanceDataKey(params) : null;
    if (params.artifact.provenance == null) return undefined;
    if (params.artifact.bodyVersion === undefined) throw new Error('Artifact private metadata revision is unavailable');
    return openArtifactPrivateRevisionMetadata({ mode: params.mode, artifactId: params.artifact.id,
        bodyVersion: params.artifact.bodyVersion, provenance: params.artifact.provenance, dataKey });
}

type ArtifactProvenanceWrite = Readonly<{
    write: Pick<ArtifactUpdateRequest, 'provenance' | 'provenanceDataEncryptionKey'>;
    candidate?: Readonly<{ provenanceEnvelope: string; provenanceDataKey: Uint8Array }>;
    initializedOwnerEnvelope?: string;
}>;

async function prepareArtifactProvenanceWrite(params: Readonly<{
    artifactId: string; bodyVersion: number; mode: 'plain' | 'e2ee'; provenance?: ArtifactRevisionProvenanceV1;
    encryption: Encryption | null; artifactDataKeys: ArtifactDataKeyCache;
    credentials: AuthCredentials; request?: ArtifactApiOptions['request']; signal?: AbortSignal;
    existingArtifact?: Pick<DecryptedArtifact, 'access' | 'ownerAccountId'>;
}>): Promise<ArtifactProvenanceWrite> {
    if (!params.provenance) return { write: {} };
    if (params.mode === 'plain') return { write: { provenance: await sealArtifactPrivateRevisionMetadata({ ...params,
        provenance: params.provenance }), provenanceDataEncryptionKey: null } };
    const cached = params.artifactDataKeys.get(params.artifactId);
    if (!cached) throw new Error('Artifact content key is unavailable');
    if (cached.provenanceEnvelope && !cached.provenanceDataKey)
        throw new Error('Artifact private metadata key is unavailable');
    const initializeKey = !cached.provenanceEnvelope;
    const dataKey = cached.provenanceDataKey ?? ArtifactEncryption.generateDataEncryptionKey();
    const envelope = cached.provenanceEnvelope ?? encodeBase64(await requireArtifactEncryption(params.encryption).encryptEncryptionKey(dataKey), 'base64');
    let ownerEnvelope = envelope;
    const grantInitialization = initializeKey && params.existingArtifact !== undefined && params.existingArtifact.access !== 'owner';
    if (grantInitialization) {
        const census = await createArtifactAccessApi(params.credentials, params).readRecipients(params.artifactId, params.signal);
        if (census.artifactId !== params.artifactId || census.callerDataEncryptionKey !== cached.envelope
            || census.provenanceDataEncryptionKey)
            throw Object.assign(new Error('Artifact data key changed'), { code: 'artifact_data_key_changed' });
        const owner = prepareArtifactRecipientKeyEnvelopesV1({ dataKey: cached.dataKey, provenanceDataKey: dataKey,
            recipients: census.recipients.filter(recipient => recipient.recipientAccountId === census.ownerAccountId),
            randomBytes: getRandomBytes, replaceExisting: true })[0];
        if (!owner?.encryptedProvenanceDataKey)
            throw Object.assign(new Error('Artifact owner key is unavailable'), { code: 'artifact_content_unavailable' });
        ownerEnvelope = owner.encryptedProvenanceDataKey;
    }
    return { write: { provenance: await sealArtifactPrivateRevisionMetadata({ ...params, provenance: params.provenance, dataKey }),
        ...(initializeKey ? { provenanceDataEncryptionKey: ownerEnvelope } : {}) },
        candidate: { provenanceEnvelope: envelope, provenanceDataKey: dataKey },
        ...(initializeKey && params.existingArtifact !== undefined ? { initializedOwnerEnvelope: ownerEnvelope } : {}) };
}

async function acknowledgeArtifactProvenanceWrite(params: Readonly<{
    artifactId: string; credentials: AuthCredentials; request?: ArtifactApiOptions['request']; signal?: AbortSignal;
    serverId?: string; readTransport?: ArtifactApiOptions['readTransport'];
    artifactDataKeys: ArtifactDataKeyCache;
}>, prepared: Awaited<ReturnType<typeof prepareArtifactProvenanceWrite>>) {
    if (!prepared.candidate) return;
    const cached = params.artifactDataKeys.get(params.artifactId);
    if (!cached) throw new Error('Artifact content key is unavailable');
    let envelope = prepared.candidate.provenanceEnvelope;
    if (prepared.initializedOwnerEnvelope) {
        const api = createArtifactAccessApi(params.credentials, params);
        const census = await api.readRecipients(params.artifactId, params.signal);
        if (census.artifactId !== params.artifactId || census.callerDataEncryptionKey !== cached.envelope
            || census.provenanceDataEncryptionKey !== prepared.initializedOwnerEnvelope || !census.dataEncryptionKey)
            throw Object.assign(new Error('Artifact data key changed'), { code: 'artifact_data_key_changed' });
        const recipients = prepareArtifactRecipientKeyEnvelopesV1({ dataKey: cached.dataKey,
            provenanceDataKey: prepared.candidate.provenanceDataKey,
            recipients: census.recipients.filter(recipient => recipient.recipientAccountId !== census.ownerAccountId), randomBytes: getRandomBytes });
        if (recipients.length) await api.commitKeyEnvelopes({ artifactId: params.artifactId,
            expectedDataEncryptionKey: census.dataEncryptionKey, expectedProvenanceDataEncryptionKey: prepared.initializedOwnerEnvelope,
            recipientKeyEnvelopes: recipients }, params.signal);
        const caller = recipients.find(recipient => recipient.recipientAccountId === parseToken(params.credentials.token));
        envelope = caller?.encryptedProvenanceDataKey ?? envelope;
    }
    params.artifactDataKeys.set(params.artifactId, { ...cached, ...prepared.candidate, provenanceEnvelope: envelope });
}

function createLockedArtifactView(params: Readonly<{
    artifact: ArtifactContentProjection;
    reason: ArtifactLockedReason;
    storageMode?: 'plain' | 'e2ee';
}>): DecryptedArtifact {
    const { artifact, reason } = params;
    return {
        kind: artifact.kind,
        ...(Object.hasOwn(artifact, 'kindHint') ? { kindHint: artifact.kindHint } : {}),
        ...(artifact.ownerAccountId === undefined ? {} : { ownerAccountId: artifact.ownerAccountId }),
        ...(artifact.access === undefined ? {} : { access: artifact.access }),
        publicAudience: ArtifactPublicAudienceV1ReadSchema.parse(artifact.publicAudience),
        id: artifact.id,
        header: null,
        title: null,
        body: undefined,
        headerVersion: artifact.headerVersion,
        bodyVersion: artifact.bodyVersion,
        seq: artifact.seq,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
        isDecrypted: false,
        storageMode: params.storageMode ?? 'e2ee',
        availability: {
            kind: 'locked',
            reason,
        },
    };
}

export async function decryptArtifactListItem(params: {
    artifact: Artifact;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
}): Promise<DecryptedArtifact | null> {
    const opened = await decryptArtifactListItems({ ...params, artifacts: [params.artifact] });
    return opened[0] ?? null;
}

export async function decryptArtifactListItems(params: {
    artifacts: readonly Artifact[];
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    includeBody?: boolean;
    /** Background indexes do not consume private attribution. Exact readers keep it by default. */
    includeProvenance?: boolean;
}): Promise<Array<DecryptedArtifact | null>> {
    const keys = await resolveArtifactDataKeys(params);
    return await Promise.all(params.artifacts.map(async (artifact) => {
        const dataKey = keys.get(artifact.id) ?? null;
        if (params.includeBody) {
            const opened = await decryptArtifactWithBody({
                artifact, encryption: params.encryption, artifactDataKeys: params.artifactDataKeys, resolvedDataKey: dataKey,
            });
            if (opened?.isDecrypted) return opened;
        }
        // A bad body must not erase its readable identity or the other list rows.
        return await buildDecryptedArtifactListItem({ artifact, encryption: params.encryption, artifactDataKeys: params.artifactDataKeys,
            dataKey, includeProvenance: params.includeProvenance });
    }));
}

async function openArtifactListHeader(params: Readonly<{
    artifact: Pick<Artifact, 'id' | 'header'>;
    dataKey: Uint8Array;
    artifactDataKeys: ArtifactDataKeyCache;
}>): Promise<Readonly<Record<string, unknown>> | null> {
    const { artifact, dataKey, artifactDataKeys } = params;
    const entry = artifactDataKeys.get(artifact.id);
    const retained = entry?.dataKey === dataKey ? entry.header : undefined;
    if (retained?.ciphertext === artifact.header) return retained.raw;
    const raw = await new ArtifactEncryption(dataKey).decryptHeaderRaw(artifact.header);
    // The entry's key identity proves it still belongs to this envelope; a rotated envelope replaced it.
    if (raw && entry?.dataKey === dataKey) artifactDataKeys.set(artifact.id, { ...entry, header: { ciphertext: artifact.header, raw } });
    return raw;
}

async function buildDecryptedArtifactListItem(params: {
    artifact: Artifact;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    dataKey: Uint8Array | null;
    includeProvenance?: boolean;
}): Promise<DecryptedArtifact | null> {
    const { artifact, encryption, dataKey } = params;

    if (isPlainArtifactDataKeyMarker(artifact.dataEncryptionKey)) {
        try {
            const rawHeader = decodePlainArtifactHeaderRaw(artifact.header);
            const header = projectArtifactHeaderForDisplay(rawHeader);
            return {
                id: artifact.id,
                header,
                rawHeader,
                title: header.title,
                sessions: header.sessions,
                draft: header.draft,
                body: undefined,
                ...(params.includeProvenance === false ? {} : { provenance: await openArtifactProvenance({ ...params, mode: 'plain' }) }),
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: true,
                storageMode: 'plain',
                ...artifactAccessProjection(artifact),
            };
        } catch {
            return createLockedArtifactView({
                artifact,
                reason: 'invalid_stored_content',
                storageMode: 'plain',
            });
        }
    }

    if (!encryption) {
        return createLockedArtifactView({
            artifact,
            reason: 'encryption_material_unavailable',
        });
    }

    const resolvedProvenanceDataKey = dataKey && params.includeProvenance !== false
        ? await resolveArtifactProvenanceDataKey(params) : null;
    try {
        if (!dataKey) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        const rawHeader = await openArtifactListHeader({ artifact, dataKey, artifactDataKeys: params.artifactDataKeys });
        const header = rawHeader ? projectArtifactHeaderForDisplay(rawHeader) : null;

        if (!header) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        return {
            id: artifact.id,
            header,
            rawHeader,
            title: header.title || null,
            sessions: header.sessions,
            draft: header.draft,
            body: undefined, // Body not loaded in list
            ...(params.includeProvenance === false ? {} : { provenance: await openArtifactProvenance({ ...params,
                resolvedProvenanceDataKey, mode: 'e2ee' }) }),
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: true,
            storageMode: 'e2ee',
            ...artifactAccessProjection(artifact),
        };
    } catch (err) {
        log.log(`Failed to decrypt artifact ${artifact.id}: ${err}`);
        return createLockedArtifactView({
            artifact,
            reason: 'decryption_failed',
        });
    }
}

export async function decryptArtifactWithBody(params: {
    artifact: Artifact;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    /** The list's batch result, including a failed unwrap; never retry it per record. */
    resolvedDataKey?: Uint8Array | null;
}): Promise<DecryptedArtifact | null> {
    const { artifact, encryption, artifactDataKeys } = params;

    if (isPlainArtifactDataKeyMarker(artifact.dataEncryptionKey)) {
        try {
            const rawHeader = decodePlainArtifactHeaderRaw(artifact.header);
            const header = projectArtifactHeaderForDisplay(rawHeader);
            const body = artifact.body ? decodePlainArtifactBody(artifact.body) : null;
            requireArtifactBodyKind(rawHeader, body?.body ?? null);
            return {
                id: artifact.id,
                header,
                rawHeader,
                title: header.title,
                sessions: header.sessions,
                draft: header.draft,
                body: body?.body ?? null,
                provenance: await openArtifactProvenance({ ...params, mode: 'plain' }),
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: true,
                storageMode: 'plain',
                ...artifactAccessProjection(artifact),
            };
        } catch {
            return createLockedArtifactView({
                artifact,
                reason: 'invalid_stored_content',
                storageMode: 'plain',
            });
        }
    }

    if (!encryption) {
        return createLockedArtifactView({
            artifact,
            reason: 'encryption_material_unavailable',
        });
    }

    // Opening custody can fail transiently. Do not turn an interrupted worker
    // operation into an authenticated refusal or publish a locked replacement.
    const decryptedKey = params.resolvedDataKey !== undefined ? params.resolvedDataKey
        : await resolveArtifactDataKey({ artifact, encryption, artifactDataKeys });
    const resolvedProvenanceDataKey = decryptedKey ? await resolveArtifactProvenanceDataKey(params) : null;
    try {
        if (!decryptedKey) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        // Create artifact encryption instance
        const artifactEncryption = new ArtifactEncryption(decryptedKey);

        // Decrypt header and body
        const rawHeader = await artifactEncryption.decryptHeaderRaw(artifact.header);
        const header = rawHeader ? projectArtifactHeaderForDisplay(rawHeader) : null;
        const body = artifact.body ? await artifactEncryption.decryptBody(artifact.body) : null;

        if (!header || (artifact.body && !body)) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        requireArtifactBodyKind(rawHeader!, body?.body ?? null);
        return {
            id: artifact.id,
            header,
            title: header.title || null,
            sessions: header.sessions,
            draft: header.draft,
            body: body?.body ?? null,
            provenance: await openArtifactProvenance({ ...params, resolvedProvenanceDataKey, mode: 'e2ee' }),
            rawHeader,
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: true,
            storageMode: 'e2ee',
            ...artifactAccessProjection(artifact),
        };
    } catch (error) {
        log.log(`Failed to decrypt artifact ${artifact.id}: ${error}`);
        return createLockedArtifactView({
            artifact,
            reason: 'decryption_failed',
        });
    }
}

// Only the ambient inventory producer supplies a scope. Keep its current
// attempt's completion, never its result or crypto, for qualified readers.
let pendingArtifactInventory: Readonly<{
    scope: ServerAccountScope;
    credentials: AuthCredentials;
    completion: Promise<void>;
}> | null = null;

export function awaitPendingArtifactInventory(params: Readonly<{
    scope: ServerAccountScope;
    credentials: AuthCredentials;
    signal?: AbortSignal;
}>): Promise<void> | null {
    throwIfAborted(params.signal);
    const pending = pendingArtifactInventory;
    if (!pending || !areServerAccountScopesEqual(pending.scope, params.scope)
        || !areCredentialsEqual(pending.credentials, params.credentials)) return null;
    const signal = params.signal;
    if (!signal) return pending.completion;
    return new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        void pending.completion.then(() => { signal.removeEventListener('abort', abort); resolve(); });
    });
}

export async function fetchAndApplyArtifactsList(params: {
    credentials: AuthCredentials | null | undefined;
    request?: ArtifactApiOptions['request'];
    readTransport?: ArtifactApiOptions['readTransport'];
    serverId?: string;
    signal?: AbortSignal;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    applyArtifacts: (artifacts: DecryptedArtifact[], source?: 'inventory') => void;
    shouldContinue?: () => boolean;
    /** Supplied only by the scoped ambient inventory writer. */
    inventoryScope?: ServerAccountScope | null;
    /** Publish last-known headers without granting complete/current coverage. */
    hydrateArtifacts?: (artifacts: DecryptedArtifact[]) => void;
    /** Same scoped snapshot used by the store's inventory reconciliation. */
    inventoryReadStartedWith?: Readonly<Record<string, DecryptedArtifact>>;
    /** Read the reconciled projection after publishing headers, including raced body arrivals. */
    readCurrentArtifacts?: () => Readonly<Record<string, DecryptedArtifact>>;
    changesPageLimit?: number;
    /** The open Artifact browser consumes attribution; background indexes do not. */
    includeProvenance?: boolean;
}): Promise<void> {
    const { credentials, encryption, artifactDataKeys, applyArtifacts } = params;
    const shouldContinue = () => !params.signal?.aborted && (params.shouldContinue?.() ?? true);

    log.log('📦 fetchArtifactsList: Starting artifact sync');
    if (!credentials) {
        log.log('📦 fetchArtifactsList: No credentials, skipping');
        return;
    }
    if (!shouldContinue()) return;

    let finishInventory = () => {};
    if (params.inventoryScope) {
        let complete!: () => void;
        const completion = new Promise<void>(resolve => { complete = resolve; });
        const pending = { scope: params.inventoryScope, credentials, completion };
        pendingArtifactInventory = pending;
        finishInventory = () => {
            if (pendingArtifactInventory === pending) pendingArtifactInventory = null;
            complete();
        };
    }

    try {
        // The binding invalidates opened headers when credential authority or Account key material changes.
        // Persist only its digest; neither credentials nor content keys enter the cache.
        const scope = params.inventoryScope;
        const binding = scope ? encodeBase64(await digest('SHA-256', new TextEncoder().encode(JSON.stringify(credentials)))) : null;
        if (!shouldContinue()) return;
        let cursor: string | null = null;
        let decryptedArtifacts: DecryptedArtifact[] | null = null;
        let retained: ArtifactInventoryWarmCache | null = null;
        let persistedHeaders: ArtifactInventoryWarmCache['artifacts'] | null = null;
        try { retained = scope && binding ? loadArtifactInventoryWarmCache(scope.serverId, scope.accountId, binding) : null; }
        catch { /* Unreadable device storage means an unknown cursor and a cold listing. */ }
        if (retained) {
            const baselineHeaders = retained.artifacts;
            let currentHeaders = baselineHeaders;
            // A warm refresh retains already-opened bodies/custody. The device
            // projection is only a fallback for rows absent from this process.
            const rows = baselineHeaders.map((previous, index) => {
                const current = params.inventoryReadStartedWith?.[previous.id];
                if (!current) return restoreInventoryHeader(previous);
                // Exact reads can update display/access facts without advancing this
                // checkpoint's cursor. Preserve them, but allocate only changed projections.
                const header = projectInventoryHeader(current, previous);
                if (header !== previous) {
                    if (currentHeaders === baselineHeaders) currentHeaders = [...baselineHeaders];
                    currentHeaders[index] = header;
                }
                return current;
            });
            params.hydrateArtifacts?.(rows);
            cursor = retained.cursor;
            // Account writes may continue throughout catch-up. The incumbent
            // cursor endpoint supplies this read's frontier; an empty moving
            // tail is neither necessary nor guaranteed to arrive.
            const frontier = await fetchCurrentChangesCursor({ credentials, request: params.request });
            if (!shouldContinue()) return;
            if (frontier.status !== 'ok') throw new Error('Artifact inventory changes are unavailable');
            if (Number(frontier.cursor) < Number(cursor)) cursor = null;
            const changedIds = new Set<string>();
            // Private attribution is demanded only by the open Artifact browser;
            // it is deliberately absent from the device header projection.
            if (params.includeProvenance) {
                for (const row of rows) if (!params.inventoryReadStartedWith?.[row.id]) changedIds.add(row.id);
            }
            while (cursor !== null && Number(cursor) < Number(frontier.cursor)) {
                const page = await fetchChanges({ credentials, request: params.request, afterCursor: cursor,
                    limit: params.changesPageLimit ?? loadSyncTuning().changesPageLimit });
                if (!shouldContinue()) return;
                if (page.status === 'cursor-gone') { cursor = null; break; }
                if (page.status !== 'ok') throw new Error('Artifact inventory changes are unavailable');
                for (const change of page.changes) if (change.kind === 'artifact') changedIds.add(change.entityId);
                if (Number(page.nextCursor) <= Number(cursor)) throw new Error('Artifact inventory cursor did not reach its frontier');
                cursor = page.nextCursor;
            }
            if (cursor !== null && changedIds.size === 0) decryptedArtifacts = rows;
            if (cursor !== null && changedIds.size > 0) {
                // A change identity demands only its current header. Body readers
                // keep their own selected demand; missing identities remove rows.
                const reads = await fetchArtifactReadBatch(credentials, [...changedIds], {
                    request: params.request, readTransport: params.readTransport, signal: params.signal, projection: 'headers',
                });
                if (!shouldContinue()) return;
                for (const item of reads) if (!item.ok && item.error !== 'artifact_not_found') {
                    throw new HappyError(item.error, item.retryable, { code: item.error, status: item.status });
                }
                const opened = await decryptArtifactListItems({ artifacts: reads.flatMap(item => item.ok ? [item.artifact] : []),
                    encryption, artifactDataKeys, includeProvenance: params.includeProvenance === true });
                if (!shouldContinue()) return;
                const byId = new Map(rows.map(row => [row.id, row]));
                const changedHeaders = new Map<string, ArtifactInventoryWarmCache['artifacts'][number]>();
                for (const item of reads) if (!item.ok) byId.delete(item.artifactId);
                for (const row of opened) if (row) {
                    byId.set(row.id, row);
                    changedHeaders.set(row.id, projectInventoryHeader(row));
                }
                decryptedArtifacts = [...byId.values()];
                // The cursor owner identified changed headers. Retain every other admitted
                // projection instead of rebuilding the full persistence graph from live bodies.
                let headersChanged = false;
                const mergedHeaders = currentHeaders.flatMap(previous => {
                    const replacement = changedHeaders.get(previous.id);
                    changedHeaders.delete(previous.id);
                    if (!byId.has(previous.id)) { headersChanged = true; return []; }
                    const header = replacement && !sameStrictJsonValue(previous, replacement) ? replacement : previous;
                    if (header !== previous) headersChanged = true;
                    return [header];
                });
                for (const header of changedHeaders.values()) { mergedHeaders.push(header); headersChanged = true; }
                if (headersChanged) currentHeaders = mergedHeaders;
            }
            persistedHeaders = currentHeaders;
        }
        if (decryptedArtifacts === null) {
            persistedHeaders = null;
            // Capture BEFORE listing: changes racing pagination remain replayable on
            // the next read, rather than disappearing behind a post-list cursor.
            if (scope) {
                const current = await fetchCurrentChangesCursor({ credentials, request: params.request });
                if (!shouldContinue()) return;
                cursor = current.status === 'ok' ? current.cursor : null;
            }
            log.log('📦 fetchArtifactsList: Fetching artifacts from server');
            const complete = await listArtifactHeadersV1({
                options: { signal: params.signal },
                encodeCursor: encodeArtifactListCursor,
                readPage: async (options) => {
                    if (!shouldContinue()) return { items: [] };
                    const page = await fetchArtifactsApi(credentials, { ...options, request: params.request,
                        readTransport: params.readTransport, signal: params.signal, retry: 'none' });
                    if (!shouldContinue()) return { items: [] };
                    // The decoder batches changed envelopes, retaining locked structural rows.
                    const opened = await decryptArtifactListItems({ artifacts: page, encryption, artifactDataKeys,
                        includeProvenance: params.includeProvenance === true });
                    if (!shouldContinue()) return { items: [] };
                    const items = opened.filter((artifact): artifact is DecryptedArtifact => artifact !== null)
                        .map(artifact => ({ artifactId: artifact.id, header: artifact.rawHeader ?? {},
                            createdAt: artifact.createdAt, updatedAt: artifact.updatedAt, artifact }));
                    const last = page.at(-1);
                    return { items, ...(last && page.length === options?.limit
                        ? { nextCursor: encodeArtifactListCursor({ artifactId: last.id, updatedAt: last.updatedAt }) } : {}) };
                },
            });
            if (!shouldContinue()) return;
            decryptedArtifacts = complete.items.map(item => item.artifact);
        }
        if (!shouldContinue()) return;
        if (scope && binding && cursor !== null) {
            try {
                const artifacts = persistedHeaders ?? decryptedArtifacts.map(row => projectInventoryHeader(row));
                const checkpoint = retained && cursor === retained.cursor && artifacts === retained.artifacts
                    ? retained : { binding, cursor, artifacts };
                saveArtifactInventoryWarmCache(scope.serverId, scope.accountId, checkpoint);
            }
            catch { /* Device quota/storage failure leaves the live inventory usable. */ }
        }
        applyArtifacts(decryptedArtifacts, 'inventory');
        // Membership is usable before independent actionable-body hydration.
        finishInventory();
        log.log(`📦 fetchArtifactsList: Applied ${decryptedArtifacts.length} artifact headers`);

        // The always-mounted Inbox badge consumes strict open approval bodies and
        // private Account notices. Settled receipts are demanded by their transcript;
        // Launch Profiles have their own scoped catalog read owner.
        const currentArtifacts = params.readCurrentArtifacts?.();
        const detailHeads = decryptedArtifacts.filter(candidate => {
            const decrypted = currentArtifacts ? currentArtifacts[candidate.id] : candidate;
            if (!decrypted || decrypted.body !== undefined) return false;
            const header = decrypted.header;
            const isApprovalIndex = header?.kind === 'approval_request.v1'
                || header?.kind === 'target_action_approval.v1'
                || header?.kind === 'execution_run_host_action_approval.v1';
            const noticeHeader = decrypted.rawHeader ?? header;
            const notice = readAccountNoticeArtifactHeaderV1(noticeHeader);
            const isOpenNotice = notice ? notice.status === 'open' && !notice.resolved
                : readUsageNoticeArtifactHeaderV1(noticeHeader)?.status === 'open';
            return decrypted.isDecrypted && ((isApprovalIndex && header?.approvalStatus === 'open') || isOpenNotice);
        });
        const bodyResults = await fetchAndApplyArtifactBodies({ ...params, credentials, artifactIds: detailHeads.map(artifact => artifact.id) });
        for (const result of bodyResults) if (result.status === 'rejected') throw result.reason;
        log.log('📦 fetchArtifactsList: Artifacts applied to storage');
    } catch (error) {
        // A background sync failure is recorded here and settled by the sync owner (retry, the one
        // Home-unreachable state). It is never a console error, which dev builds surface as a toast.
        log.log(`📦 fetchArtifactsList: Error fetching artifacts: ${error}`);
        throw error;
    } finally {
        // Failed or retired attempts wake readers too; they must recheck coverage.
        finishInventory();
    }
}

function projectInventoryHeader(row: DecryptedArtifact,
    previous?: ArtifactInventoryWarmCache['artifacts'][number]): ArtifactInventoryWarmCache['artifacts'][number] {
    const rawHeader = row.rawHeader ?? null;
    const lockedReason = row.isDecrypted ? undefined : row.availability.reason;
    const storageMode = row.storageMode ?? 'e2ee';
    if (previous && previous.id === row.id && previous.kind === row.kind
        && Object.hasOwn(previous, 'kindHint') === Object.hasOwn(row, 'kindHint') && previous.kindHint === row.kindHint
        && previous.isDecrypted === row.isDecrypted && previous.lockedReason === lockedReason
        && previous.storageMode === storageMode && previous.access === row.access
        && previous.ownerAccountId === row.ownerAccountId && previous.headerVersion === row.headerVersion
        && previous.bodyVersion === row.bodyVersion && previous.seq === row.seq
        && previous.createdAt === row.createdAt && previous.updatedAt === row.updatedAt
        && sameStrictJsonValue(previous.rawHeader, rawHeader)) return previous;
    return { id: row.id, kind: row.kind, ...(Object.hasOwn(row, 'kindHint') ? { kindHint: row.kindHint } : {}),
        rawHeader, isDecrypted: row.isDecrypted,
        ...(row.isDecrypted ? {} : { lockedReason }),
        storageMode, access: row.access, ownerAccountId: row.ownerAccountId,
        headerVersion: row.headerVersion, bodyVersion: row.bodyVersion, seq: row.seq,
        createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function restoreInventoryHeader(row: ArtifactInventoryWarmCache['artifacts'][number]): DecryptedArtifact {
    const { lockedReason, ...base } = row;
    if (!row.isDecrypted || !row.rawHeader) return { ...base, isDecrypted: false, rawHeader: null, header: null,
        title: null, availability: { kind: 'locked', reason: lockedReason ?? 'decryption_failed' } };
    const header = projectArtifactHeaderForDisplay(row.rawHeader);
    return { ...base, isDecrypted: true, rawHeader: row.rawHeader, header, title: header.title,
        sessions: header.sessions, draft: header.draft };
}

/** The shared batched body read for background indexes and demanded content. */
export async function fetchAndApplyArtifactBodies(params: Readonly<{
    credentials: AuthCredentials;
    artifactIds: readonly string[];
    request?: ArtifactApiOptions['request'];
    readTransport?: ArtifactApiOptions['readTransport'];
    signal?: AbortSignal;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
    shouldContinue?: () => boolean;
}>): Promise<PromiseSettledResult<void>[]> {
    const shouldContinue = params.shouldContinue ?? (() => !params.signal?.aborted);
    if (params.artifactIds.length === 0 || !shouldContinue()) return [];
    const details = await fetchArtifactsWithBodiesFromApi(params);
    if (!shouldContinue()) return [];
    const hydrated: DecryptedArtifact[] = [];
    for (const detail of details) {
        if (detail.status === 'fulfilled' && detail.value) hydrated.push(detail.value);
    }
    if (hydrated.length > 0 && !params.signal?.aborted && shouldContinue()) params.applyArtifacts(hydrated);
    return details.map(detail => detail.status === 'rejected' ? detail : { status: 'fulfilled', value: undefined });
}

/** Exact reads share transport; each borrower opens with its own keys and keeps per-id refusals. */
export async function fetchArtifactsWithBodiesFromApi(params: Readonly<{
    credentials: AuthCredentials;
    artifactIds: readonly string[];
    request?: ArtifactApiOptions['request'];
    readTransport?: ArtifactApiOptions['readTransport'];
    fresh?: boolean;
    signal?: AbortSignal;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    prepareRecipientKeys?: boolean;
    shouldContinue?: () => boolean;
}>): Promise<PromiseSettledResult<DecryptedArtifact | null>[]> {
    throwIfAborted(params.signal);
    const shouldContinue = params.shouldContinue ?? (() => !params.signal?.aborted);
    if (params.artifactIds.length === 0 || !shouldContinue()) return [];
    const { credentials, encryption, artifactDataKeys } = params;
    const detailReads = await fetchArtifactReadBatch(credentials, params.artifactIds, params);
    if (!shouldContinue()) return [];
    const artifacts = detailReads.flatMap(item => item.ok ? [item.artifact] : []);
    await resolveArtifactDataKeys({ artifacts, encryption, artifactDataKeys });
    throwIfAborted(params.signal);
    if (!shouldContinue()) return [];
    return Promise.allSettled(detailReads.map(async item => {
        if (!shouldContinue()) return null;
        if (!item.ok) {
            if (item.error === 'artifact_not_found') return null;
            throw new HappyError(item.error, item.retryable, { code: item.error, status: item.status });
        }
        return openArtifactWithRecipientKeyPreparation({ ...params, artifact: item.artifact,
            recipientCensus: item.recipientCensus });
    }));
}

export async function fetchArtifactWithBodyFromApi(params: {
    credentials: AuthCredentials;
    request?: ArtifactApiOptions['request'];
    readTransport?: ArtifactApiOptions['readTransport'];
    fresh?: boolean;
    artifactId: string;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    signal?: AbortSignal;
    /** Signed decision preparation may read current content, never repair its audience. */
    prepareRecipientKeys?: boolean;
}): Promise<DecryptedArtifact | null> {
    // Keyless/inspection reads have no recipient preparation demand. Keep the
    // opaque detail path so retained locked rows remain representable even
    // when their unusable envelope cannot form a keyholding census.
    if (!params.encryption || params.prepareRecipientKeys === false) {
        try {
            throwIfAborted(params.signal);
            const artifact = await fetchArtifactApi(params.credentials, params.artifactId, params);
            return await openArtifactWithRecipientKeyPreparation({ ...params, artifact });
        } catch (error) {
            if (error instanceof HappyError && error.status === 404) return null;
            throw error;
        }
    }
    // The authenticated batch owner returns the exact row and its matching
    // recipient census together, including for a one-row content demand.
    const [result] = await fetchArtifactsWithBodiesFromApi({ ...params, artifactIds: [params.artifactId] });
    throwIfAborted(params.signal);
    if (!result) return null;
    if (result.status === 'rejected') throw result.reason;
    return result.value;
}

/** Both authenticated read forms open content and prepare keys through the same owner. */
async function openArtifactWithRecipientKeyPreparation(params: Readonly<{
    credentials: AuthCredentials; request?: ArtifactApiOptions['request']; signal?: AbortSignal;
    serverId?: string; readTransport?: ArtifactApiOptions['readTransport'];
    artifact: Artifact; encryption: Encryption | null; artifactDataKeys: ArtifactDataKeyCache;
    recipientCensus?: ArtifactAccessRecipientCensusResponseV1 | null;
    prepareRecipientKeys?: boolean;
}>): Promise<DecryptedArtifact | null> {
    const { artifact, encryption, artifactDataKeys } = params;
    throwIfAborted(params.signal);
    const opened = await decryptArtifactWithBody({ artifact, encryption, artifactDataKeys });
    throwIfAborted(params.signal);
    if (opened?.isDecrypted && opened.storageMode === 'e2ee' && params.prepareRecipientKeys !== false) {
        const key = artifactDataKeys.get(artifact.id);
        const census = params.recipientCensus;
        // Keyholding reads obtain this matching census in the selected-read response.
        // The opaque inspection path cannot enter recipient preparation.
        if (!key || key.envelope !== artifact.dataEncryptionKey || !census) {
            throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
        }
        const accessApi = createArtifactAccessApi(params.credentials, params);
        await runArtifactRecipientKeyPreparationV1({ artifactId: artifact.id, dataKey: key.dataKey,
            provenanceDataKey: key.provenanceDataKey, openedProvenanceDataEncryptionKey: key.provenanceEnvelope,
            openedDataEncryptionKey: key.envelope, randomBytes: getRandomBytes, signal: params.signal,
            readCensus: () => Promise.resolve(census),
            commit: input => accessApi.commitKeyEnvelopes(input, params.signal),
        });
    }
    return opened;
}

export async function fetchArtifactBinaryFromApi(params: Readonly<{
    credentials: AuthCredentials; request?: ArtifactApiOptions['request']; artifactId: string;
    readTransport?: ArtifactApiOptions['readTransport'];
    reference: ArtifactBlobReferenceV1; encryption: Encryption | null; artifactDataKeys: ArtifactDataKeyCache; signal?: AbortSignal;
    /** A row already opened by the same captured keyholding operation, never a stored view row. */
    artifact?: DecryptedArtifact;
}>): Promise<Uint8Array> {
    const artifact = params.artifact ?? await fetchArtifactWithBodyFromApi(params);
    if (!artifact?.isDecrypted || !artifact.storageMode) {
        throw new HappyError('Artifact file changed or is unavailable', false, { code: 'artifact_content_unavailable' });
    }
    return openFetchedArtifactBinary(params, artifact.storageMode);
}

async function openFetchedArtifactBinary(params: Readonly<{
    credentials: AuthCredentials; request?: ArtifactApiOptions['request']; artifactId: string;
    reference: ArtifactBlobReferenceV1; artifactDataKeys: ArtifactDataKeyCache; signal?: AbortSignal;
}>, mode: 'plain' | 'e2ee'): Promise<Uint8Array> {
    const key = params.artifactDataKeys.get(params.artifactId);
    const stored = await fetchArtifactBlob(params.credentials, params.artifactId, params.reference.blobId, mode,
        { request: params.request, signal: params.signal });
    const dataKey = key?.dataKey;
    const bytes = await openArtifactBinaryContent({ reference: params.reference, content: stored.content, mode,
        encryption: dataKey ? new ArtifactEncryption(dataKey) : null });
    const currentKey = params.artifactDataKeys.get(params.artifactId);
    if (mode === 'e2ee' && (!key || !currentKey || currentKey.envelope !== key.envelope || currentKey.dataKey !== key.dataKey)) {
        throw new HappyError('Artifact file changed or is unavailable', false, { code: 'artifact_content_unavailable' });
    }
    throwIfAborted(params.signal);
    return bytes;
}

export async function fetchArtifactHtmlPreviewFromApi(params: Readonly<{
    credentials: AuthCredentials; request?: ArtifactApiOptions['request']; artifactId: string;
    readTransport?: ArtifactApiOptions['readTransport'];
    encryption: Encryption | null; artifactDataKeys: ArtifactDataKeyCache; signal?: AbortSignal;
    forbiddenOrigins?: readonly string[];
    /** A row already opened by the same captured keyholding operation. */
    artifact?: DecryptedArtifact;
}>): Promise<ArtifactHtmlPreview> {
    const artifact = params.artifact ?? await fetchArtifactWithBodyFromApi(params);
    if (!artifact?.isDecrypted || !artifact.storageMode || !isArtifactHtmlHeaderV1(artifact.rawHeader ?? artifact.header)
        || artifact.body === null || artifact.body === undefined)
        throw new HappyError('HTML preview is unavailable', false, { code: 'artifact_html_preview_unavailable' });
    const body = typeof artifact.body === 'string' ? artifact.body
        : await openFetchedArtifactBinary({ ...params, reference: artifact.body }, artifact.storageMode);
    const mime = typeof artifact.body === 'string'
        ? typeof artifact.rawHeader?.mime === 'string' ? artifact.rawHeader.mime : undefined
        : artifact.body.mime;
    const bundle = artifactHtmlBundleFromBodyV1(body, mime, 'stored');
    const url = await fetchArtifactHtmlPreviewLocation(params.credentials, params.artifactId, params);
    if (params.forbiddenOrigins?.some(origin => new URL(origin).origin === new URL(url).origin)) {
        throw new HappyError('HTML preview must use an isolated origin', false, { code: 'artifact_html_preview_unavailable' });
    }
    return Object.freeze({ url, bundle });
}

export type ArtifactViewRead = Readonly<{
    artifact: DecryptedArtifact;
    binaryBytes?: Uint8Array;
    htmlPreview?: ArtifactHtmlPreview;
}>;

function assertArtifactDocumentReadAllowed(artifact: DecryptedArtifact | null): void {
    if (artifact?.isDecrypted && getArtifactUseTargetV1({ artifactId: artifact.id,
        header: artifact.rawHeader ?? artifact.header ?? {}, body: null }).kind === 'approval') {
        throw Object.assign(new Error('artifact_kind_internal'), { code: 'artifact_kind_internal' });
    }
}

/** Open the head and its preview within one finite captured Account operation. */
export async function fetchArtifactForViewFromApi(params: Readonly<{
    credentials: AuthCredentials; request?: ArtifactApiOptions['request']; artifactId: string;
    readTransport?: ArtifactApiOptions['readTransport'];
    encryption: Encryption | null; artifactDataKeys: ArtifactDataKeyCache; signal?: AbortSignal;
    forbiddenOrigins?: readonly string[];
}>): Promise<ArtifactViewRead | null> {
    const artifact = await fetchArtifactWithBodyFromApi(params);
    if (!artifact) return null;
    // Replay readers retain private custody; the generic Document reader never publishes it.
    assertArtifactDocumentReadAllowed(artifact);
    if (!artifact.isDecrypted) return { artifact };
    if (isArtifactHtmlHeaderV1(artifact.rawHeader ?? artifact.header)) {
        return { artifact, htmlPreview: await fetchArtifactHtmlPreviewFromApi({ ...params, artifact }) };
    }
    const reference = artifact.body;
    if (reference !== null && reference !== undefined && typeof reference === 'object'
        && resolveFileViewerKind({ path: artifact.title ?? '', mimeType: reference.mime }).previewable) {
        return { artifact, binaryBytes: await fetchArtifactBinaryFromApi({ ...params, artifact, reference }) };
    }
    // Other files retain their explicit, later authenticated Download operation.
    return { artifact };
}

type ArtifactRevisionReadParams = Readonly<{
    credentials: AuthCredentials;
    request?: ArtifactApiOptions['request'];
    readTransport?: ArtifactApiOptions['readTransport'];
    artifactId: string;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    signal?: AbortSignal;
}>;

async function openRetainedArtifactBodies(params: ArtifactRevisionReadParams, artifact: Artifact) {
    assertArtifactDocumentReadAllowed(await decryptArtifactListItem({ ...params, artifact }));
    const inventory = await fetchArtifactRevisions(params.credentials, artifact.id, params);
    const key = artifact.encryptionMode === 'e2ee' ? await resolveArtifactDataKey({ ...params, artifact }) : null;
    if (artifact.encryptionMode === 'e2ee' && !key)
        throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
    const codec = key ? new ArtifactEncryption(key) : null;
    const provenanceDataKey = artifact.encryptionMode === 'e2ee' ? await resolveArtifactProvenanceDataKey({ ...params, artifact }) : null;
    const revisions = await Promise.all(inventory.revisions.map(async (revision) => {
        try {
            const opened = artifact.encryptionMode === 'plain'
                ? decodePlainArtifactBody(revision.body) : await codec!.decryptBody(revision.body);
            if (!opened) throw new Error('Invalid retained body');
            return { ...revision, ...opened, provenance: await openArtifactPrivateRevisionMetadata({
                mode: artifact.encryptionMode, artifactId: artifact.id, bodyVersion: revision.bodyVersion,
                provenance: revision.provenance, dataKey: provenanceDataKey }) };
        } catch {
            throw Object.assign(new Error('Artifact revision content is unavailable'), { code: 'content_unavailable' });
        }
    }));
    throwIfAborted(params.signal);
    return { artifactId: artifact.id, revisions, retentionCount: inventory.retentionCount };
}

export async function fetchArtifactBodyRevisionsFromApi(params: ArtifactRevisionReadParams) {
    const artifact = await fetchArtifactApi(params.credentials, params.artifactId, params);
    return openRetainedArtifactBodies(params, artifact);
}

export async function restoreArtifactBodyRevisionViaApi(params: ArtifactRevisionReadParams & Readonly<{
    bodyVersion: number;
    expectedRevision: ArtifactRevisionV1;
    savedBy?: ArtifactSavedByV1;
    updateArtifact: (artifact: DecryptedArtifact) => void;
}>) {
    const artifact = await fetchArtifactApi(params.credentials, params.artifactId, { ...params, fresh: true });
    if (artifact.headerVersion !== params.expectedRevision.headerVersion || artifact.bodyVersion !== params.expectedRevision.bodyVersion)
        throw Object.assign(new Error('Artifact was modified by another client'), { code: 'version_mismatch' });
    const current = await decryptArtifactWithBody({ ...params, artifact });
    if (!current?.isDecrypted || !current.rawHeader)
        throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
    const inventory = await openRetainedArtifactBodies(params, artifact);
    const selected = inventory.revisions.find(row => row.bodyVersion === params.bodyVersion);
    if (!selected) throw new HappyError('Artifact revision not found', false, { status: 404, code: 'not_found' });
    const rawHeader = withArtifactExcerptV1(prepareArtifactHeaderForRevisionV1({
        artifactId: artifact.id, header: current.rawHeader, body: selected.body, expectedRevision: params.expectedRevision,
        nextRevision: { headerVersion: params.expectedRevision.headerVersion + 1, bodyVersion: params.expectedRevision.bodyVersion + 1 },
        shared: (await sharedArtifactWriteContext({ ...params, current, header: current.rawHeader, candidateBody: selected.body }))?.shared,
    }), selected.body);
    const key = params.artifactDataKeys.get(artifact.id)?.dataKey;
    if (artifact.encryptionMode === 'e2ee' && !key)
        throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
    const header = artifact.encryptionMode === 'plain' ? encodePlainArtifactStoredContent(rawHeader)
        : await new ArtifactEncryption(key!).encryptHeader(rawHeader);
    const envelope = { body: selected.body };
    const body = artifact.encryptionMode === 'plain' ? encodePlainArtifactStoredContent(envelope)
        : await new ArtifactEncryption(key!).encryptBody(envelope);
    const privateMetadata = await prepareArtifactProvenanceWrite({ ...params, mode: artifact.encryptionMode,
        existingArtifact: current, bodyVersion: params.expectedRevision.bodyVersion + 1,
        provenance: artifactRevisionProvenance(params.credentials, params.savedBy, params.bodyVersion, selected.provenance?.source) });
    const kind = tryDeriveArtifactStoredKindV1(rawHeader);
    const revision = await restoreArtifactRevision(params.credentials, { artifactId: artifact.id,
        ...(kind === undefined ? {} : { kind }),
        bodyVersion: params.bodyVersion, expectedRevision: params.expectedRevision, header, body, ...privateMetadata.write }, params);
    await acknowledgeArtifactProvenanceWrite(params, privateMetadata);
    const restored = await fetchArtifactWithBodyFromApi({ ...params, fresh: true });
    throwIfAborted(params.signal);
    if (!restored?.isDecrypted) throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
    params.updateArtifact(restored);
    return { artifactId: artifact.id, revision };
}

export async function createArtifactViaApi(params: {
    credentials: AuthCredentials;
    request?: ArtifactApiOptions['request'];
    readTransport?: ArtifactApiOptions['readTransport'];
    serverId?: string;
    title: string | null;
    body: ArtifactBodyInput;
    sessions?: string[];
    draft?: boolean;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    addArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<string> {
    const { credentials, title, body, sessions, draft, encryption, artifactDataKeys, addArtifact } = params;

    return await createArtifactWithHeaderViaApi({
        credentials,
        request: params.request,
        readTransport: params.readTransport,
        serverId: params.serverId,
        header: {
            title,
            ...(sessions ? { sessions } : {}),
            ...(typeof draft === 'boolean' ? { draft } : {}),
        },
        body,
        encryption,
        artifactDataKeys,
        addArtifact,
    });
}

export async function createArtifactWithHeaderViaApi(params: {
    memoryDecisionSource?: CoordinationMessageRefV1;
    credentials: AuthCredentials;
    request?: ArtifactApiOptions['request'];
    readTransport?: ArtifactApiOptions['readTransport'];
    serverId?: string;
    artifactId?: string;
    signal?: AbortSignal;
    header: Readonly<Record<string, unknown>>;
    body: ArtifactBodyInput;
    savedBy?: ArtifactSavedByV1;
    source?: ArtifactWorkspaceSourceV1;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    addArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<string> {
    const { credentials, header, encryption, artifactDataKeys, addArtifact } = params;
    // A retained reference belongs to an existing Artifact; only update/restore can reuse it.
    if (params.body !== null && typeof params.body === 'object' && !('bytes' in params.body)) {
        throw new HappyError('A new Artifact file requires its bytes', false, { code: 'artifact_invalid_body' });
    }
    const body = prepareArtifactBody(params.body);
    // A new Artifact has no retained blob to reference; creation must supply its bytes.
    if (params.body !== null && typeof params.body === 'object' && !('bytes' in params.body)) {
        throw new HappyError('Creating a binary Artifact requires file bytes', false, { code: 'artifact_invalid_body' });
    }
    requireArtifactBodyKind(header, body);
    await requireArtifactHtmlWriteContent(params);
    const rawHeader = withArtifactExcerptV1(prepareArtifactHeaderForBodyV1(header, body), body);
    const envelope = { body };
    const provenance = artifactRevisionProvenance(credentials, params.savedBy, undefined, params.source);

    try {
        // Generate unique artifact ID
        const artifactId = params.artifactId ?? randomUUID();
        const active = params.request ? undefined : getActiveServerSnapshot();
        const sourceServerId = params.serverId ?? active?.serverId;
        const capturedTransport = params.request ?? createServerFetchForActiveServer(active);
        const capturedRequest: ServerFetch = params.request ?? ((path, init, options) =>
            capturedTransport(path, init, { includeAuth: false, ...options }));
        const accountMode = (await fetchAccountEncryptionMode(credentials, { request: params.request, usage: 'identity' })).mode;

        let storedDataEncryptionKey: string;
        let storedHeader: string;
        let storedBody: string;
        let artifactEncryption: ArtifactEncryption | null = null;

        if (accountMode === 'plain') {
            storedDataEncryptionKey = ARTIFACT_PLAIN_DATA_KEY_MARKER;
            storedHeader = encodePlainArtifactStoredContent(rawHeader);
            storedBody = encodePlainArtifactStoredContent(envelope);
        } else {
            const accountEncryption = requireArtifactEncryption(encryption);
            // Generate data encryption key
            const dataEncryptionKey = ArtifactEncryption.generateDataEncryptionKey();

            // Encrypt the data encryption key with user's key
            const encryptedKey = await accountEncryption.encryptEncryptionKey(dataEncryptionKey);

            // Remember the key against the envelope the server will report back, so the
            // next list refresh recognises it as unchanged instead of re-opening it.
            artifactDataKeys.set(artifactId, {
                envelope: encodeBase64(encryptedKey, 'base64'),
                dataKey: dataEncryptionKey,
            });

            // Create artifact encryption instance
            artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

            // Encrypt header and body
            storedHeader = await artifactEncryption.encryptHeader(rawHeader);
            storedBody = await artifactEncryption.encryptBody(envelope);
            storedDataEncryptionKey = encodeBase64(encryptedKey, 'base64');
        }

        // Create the request
        const privateMetadata = await prepareArtifactProvenanceWrite({ ...params, artifactId, bodyVersion: 1, mode: accountMode, provenance });
        const kind = tryDeriveArtifactStoredKindV1(rawHeader);
        const request: ArtifactCreateRequest = {
            ...(kind === undefined ? {} : { kind }),
            id: artifactId,
            header: storedHeader,
            body: storedBody,
            dataEncryptionKey: storedDataEncryptionKey,
            ...privateMetadata.write,
            ...(params.memoryDecisionSource ? { memoryDecisionSource: params.memoryDecisionSource } : {}),
        };
        if (params.body !== null && typeof params.body === 'object' && 'bytes' in params.body && typeof body === 'object' && body !== null) {
            request.blob = { blobId: body.blobId, content: await sealArtifactBinaryContent(params.body.bytes, accountMode, artifactEncryption) };
        }

        // Send to server
        throwIfAborted(params.signal);
        // The create API owns retries and binary framing. Admit the prepared
        // encoding at its physical send port on every attempt, not before crypto.
        const createRequest: ServerFetch = async (path, init, options) => {
            const currentMode = (await fetchAccountEncryptionMode(credentials, {
                request: capturedRequest, usage: 'fresh-authority',
            })).mode;
            if (currentMode !== accountMode) {
                throw new HappyError('Artifact content does not match its Account mode', false, {
                    code: 'artifact_account_mode_mismatch',
                });
            }
            throwIfAborted(params.signal);
            return capturedRequest(path, init, options);
        };
        const artifact = await createArtifactApi(credentials, request, { request: createRequest, readTransport: params.readTransport,
            signal: params.signal, serverId: sourceServerId });
        if (artifact.dataEncryptionKey === request.dataEncryptionKey
            && artifact.provenanceDataEncryptionKey === request.provenanceDataEncryptionKey)
            await acknowledgeArtifactProvenanceWrite({ ...params, artifactId }, privateMetadata);

        // Exact-id create can return a pre-existing row after a same-id race. Its
        // content and key are authoritative, not the plaintext we attempted to save.
        if (params.artifactId !== undefined) {
            const returnedArtifact = await decryptArtifactWithBody({ artifact, encryption, artifactDataKeys });
            if (!returnedArtifact?.isDecrypted) {
                throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
            }
            addArtifact(returnedArtifact);
            return artifact.id;
        }

        // Add to local storage
        const normalizedHeader = projectArtifactHeaderForDisplay(rawHeader);
        const decryptedArtifact: DecryptedArtifact = {
            id: artifact.id,
            header: normalizedHeader,
            rawHeader,
            title: normalizedHeader.title,
            sessions: normalizedHeader.sessions,
            draft: normalizedHeader.draft,
            body,
            provenance,
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: true,
            storageMode: accountMode,
            ...artifactAccessProjection(artifact),
        };

        addArtifact(decryptedArtifact);

        return artifactId;
    } catch (error) {
        console.error('Failed to create artifact:', error);
        throw error;
    }
}

function stableStringifyJsonValue(value: unknown): string {
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string') return JSON.stringify(value);
    if (t === 'number') return Number.isFinite(value as number) ? String(value) : '"__non_finite__"';
    if (t === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) return `[${value.map(stableStringifyJsonValue).join(',')}]`;
    if (t !== 'object') return JSON.stringify(null);

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringifyJsonValue(obj[k])}`).join(',')}}`;
}

export async function updateArtifactWithHeaderViaApi(params: {
    memoryDecisionSource?: CoordinationMessageRefV1;
    credentials: AuthCredentials;
    request?: ArtifactApiOptions['request'];
    readTransport?: ArtifactApiOptions['readTransport'];
    serverId?: string;
    artifactId: string;
    expectedRevision?: Readonly<{ headerVersion: number; bodyVersion: number }>;
    signal?: AbortSignal;
    header: Readonly<Record<string, unknown>>;
    body: ArtifactBodyInput;
    savedBy?: ArtifactSavedByV1;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    getArtifact: (artifactId: string) => DecryptedArtifact | undefined;
    updateArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<void> {
    const { credentials, artifactId, header, encryption, artifactDataKeys, getArtifact, updateArtifact } = params;
    const body = prepareArtifactBody(params.body);
    requireArtifactBodyKind(header, body);
    const envelope = { body };

    // Get current artifact from storage
    const currentArtifact = getArtifact(artifactId);
    if (!currentArtifact) {
        throw new Error(`Artifact ${artifactId} not found`);
    }
    if (currentArtifact.isDecrypted === false) {
        throw new Error(`Artifact ${artifactId} is locked`);
    }
    const context = await sharedArtifactWriteContext({ ...params, current: currentArtifact, candidateBody: body });
    const rawHeader = withArtifactExcerptV1(prepareArtifactHeaderForBodyV1(header, body, context), body);
    const provenance = artifactRevisionProvenance(credentials, params.savedBy, undefined, currentArtifact.provenance?.source);

    // Get the data encryption key from memory for encrypted artifacts only.
    let dataEncryptionKey = artifactDataKeys.get(artifactId)?.dataKey;
    let storageMode = currentArtifact.storageMode ?? (dataEncryptionKey ? 'e2ee' : undefined);

    // Determine current versions
    let headerVersion = params.expectedRevision?.headerVersion ?? currentArtifact.headerVersion;
    let bodyVersion = params.expectedRevision?.bodyVersion ?? currentArtifact.bodyVersion;

    if (
        headerVersion === undefined
        || bodyVersion === undefined
        || storageMode === undefined
        || (storageMode === 'e2ee' && !dataEncryptionKey)
    ) {
        const fullArtifact = await fetchArtifactApi(credentials, artifactId, { request: params.request,
            readTransport: params.readTransport, signal: params.signal, fresh: true });
        // Key recovery must never rebase the full CAS token supplied by the caller.
        if (!params.expectedRevision) {
            headerVersion = fullArtifact.headerVersion;
            bodyVersion = fullArtifact.bodyVersion;
        }
        storageMode = isPlainArtifactDataKeyMarker(fullArtifact.dataEncryptionKey) ? 'plain' : 'e2ee';

        // Decrypt and store the data encryption key if we don't have it
        if (storageMode === 'e2ee' && !dataEncryptionKey) {
            const decryptedKey = await resolveArtifactDataKey({
                artifact: fullArtifact,
                encryption: requireArtifactEncryption(encryption),
                artifactDataKeys,
            });
            if (!decryptedKey) {
                throw new Error('Failed to decrypt encryption key');
            }
            dataEncryptionKey = decryptedKey;
        }
    }

    if (!storageMode) {
        throw new Error('Artifact storage mode is unavailable');
    }
    const currentStorageMode = storageMode;
    await requireArtifactHtmlWriteContent({ ...params,
        readReference: reference => openFetchedArtifactBinary({ ...params, reference }, currentStorageMode),
    });
    const artifactEncryption = storageMode === 'e2ee'
        ? new ArtifactEncryption(dataEncryptionKey!)
        : null;

    // Prepare update request
    const updateRequest: ArtifactUpdateRequest = {};
    let privateMetadata: Awaited<ReturnType<typeof prepareArtifactProvenanceWrite>> | undefined;

    const normalizedHeader = projectArtifactHeaderForDisplay(rawHeader);
    // A complete caller-supplied replacement is authoritative even when an old
    // cache lacks raw metadata. Presentation normalization cannot prove a no-op.
    const shouldUpdateHeader = !currentArtifact.rawHeader
        || stableStringifyJsonValue(rawHeader) !== stableStringifyJsonValue(currentArtifact.rawHeader);

    if (params.expectedRevision || shouldUpdateHeader) {
        updateRequest.header = storageMode === 'plain'
            ? encodePlainArtifactStoredContent(rawHeader)
            : await artifactEncryption!.encryptHeader(rawHeader);
        updateRequest.expectedHeaderVersion = headerVersion;
    }

    // Strict refs are schema-cloned on input; equal file metadata is not a body edit.
    const bodyChanged = body !== null && typeof body === 'object'
        ? stableStringifyJsonValue(body) !== stableStringifyJsonValue(currentArtifact.body)
        : body !== currentArtifact.body;
    if (params.expectedRevision || bodyChanged) {
        // Recover the private custody before a write; legacy rows initialize it in this same CAS.
        if (provenance && storageMode === 'e2ee' && !artifactDataKeys.get(artifactId)?.provenanceDataKey) {
            const stored = await fetchArtifactApi(credentials, artifactId, { request: params.request,
                readTransport: params.readTransport, signal: params.signal, fresh: true });
            await resolveArtifactProvenanceDataKey({ ...params, artifact: stored });
        }
        updateRequest.body = storageMode === 'plain'
            ? encodePlainArtifactStoredContent(envelope)
            : await artifactEncryption!.encryptBody(envelope);
        updateRequest.expectedBodyVersion = bodyVersion;
        privateMetadata = await prepareArtifactProvenanceWrite({ ...params, mode: storageMode,
            existingArtifact: currentArtifact, bodyVersion: bodyVersion! + 1, provenance });
        Object.assign(updateRequest, privateMetadata.write);
        if (body !== null && typeof body === 'object') {
            updateRequest.blob = { blobId: body.blobId,
                ...(params.body !== null && typeof params.body === 'object' && 'bytes' in params.body
                    ? { content: await sealArtifactBinaryContent(params.body.bytes, storageMode, artifactEncryption) } : {}),
            };
        } else if (currentArtifact.body !== null && typeof currentArtifact.body === 'object') {
            updateRequest.blob = null;
        }
    }

    // Skip if no changes
    if (Object.keys(updateRequest).length === 0) {
        return;
    }

    // Send update to server
    const kind = tryDeriveArtifactStoredKindV1(rawHeader);
    if (kind !== undefined) updateRequest.kind = kind;
    if (params.memoryDecisionSource) updateRequest.memoryDecisionSource = params.memoryDecisionSource;
    throwIfAborted(params.signal);
    const response = await updateArtifactApi(credentials, artifactId, updateRequest, { request: params.request, readTransport: params.readTransport,
        signal: params.signal, serverId: params.serverId });

    if (!response.success) {
        // Handle version mismatch
        if (response.error === 'version-mismatch') {
            throw Object.assign(new Error('Artifact was modified by another client. Please refresh and try again.'), { code: 'version_mismatch' });
        }
        throw new Error('Failed to update artifact');
    }
    if (privateMetadata) await acknowledgeArtifactProvenanceWrite(params, privateMetadata);

    // Update local storage
    const updatedArtifact: DecryptedArtifact = {
        ...currentArtifact,
        ...deriveArtifactKindV1(rawHeader),
        header: normalizedHeader,
        rawHeader,
        title: normalizedHeader.title,
        sessions: normalizedHeader.sessions,
        draft: normalizedHeader.draft,
        body,
        provenance: updateRequest.body === undefined ? currentArtifact.provenance : provenance,
        headerVersion: response.headerVersion !== undefined ? response.headerVersion : headerVersion,
        bodyVersion: response.bodyVersion !== undefined ? response.bodyVersion : bodyVersion,
        updatedAt: Date.now(),
        isDecrypted: true,
        availability: { kind: 'available' },
        storageMode,
    };

    updateArtifact(updatedArtifact);
}

export async function decryptSocketNewArtifactUpdate(params: {
    artifactId: string;
    dataEncryptionKey: string;
    provenance?: string | null;
    provenanceDataEncryptionKey?: string | null;
    header: string;
    headerVersion: number;
    body?: string | null;
    bodyVersion?: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
}): Promise<DecryptedArtifact | null> {
    const {
        artifactId,
        dataEncryptionKey,
        header,
        headerVersion,
        body,
        bodyVersion,
        seq,
        createdAt,
        updatedAt,
        encryption,
        artifactDataKeys,
    } = params;

    if (isPlainArtifactDataKeyMarker(dataEncryptionKey)) {
        try {
            const rawHeader = decodePlainArtifactHeaderRaw(header);
            const decryptedHeader = projectArtifactHeaderForDisplay(rawHeader);
            const openedBody = body && bodyVersion !== undefined
                ? decodePlainArtifactBody(body)
                : undefined;
            const decryptedBody = openedBody?.body;
            requireArtifactBodyKind(rawHeader, decryptedBody ?? null);
            return {
                id: artifactId,
                header: decryptedHeader,
                rawHeader,
                title: decryptedHeader.title,
                sessions: decryptedHeader.sessions,
                draft: decryptedHeader.draft,
                body: decryptedBody,
                provenance: await openArtifactProvenance({ ...params, mode: 'plain', artifact: {
                    id: artifactId, bodyVersion, provenance: params.provenance, provenanceDataEncryptionKey: params.provenanceDataEncryptionKey } }),
                headerVersion,
                bodyVersion,
                seq,
                createdAt,
                updatedAt,
                isDecrypted: true,
                storageMode: 'plain',
                storageIdentity: artifactStorageIdentity(params),
            };
        } catch {
            return createLockedArtifactView({
                artifact: {
                    id: artifactId,
                    dataEncryptionKey,
                    header,
                    headerVersion,
                    body: body ?? undefined,
                    bodyVersion,
                    seq,
                    createdAt,
                    updatedAt,
                },
                reason: 'invalid_stored_content',
                storageMode: 'plain',
            });
        }
    }

    const artifact: ArtifactContentProjection = {
        id: artifactId,
        dataEncryptionKey,
        header,
        headerVersion,
        body: body ?? undefined,
        bodyVersion,
        seq,
        createdAt,
        updatedAt,
    };
    if (!encryption) {
        return createLockedArtifactView({
            artifact,
            reason: 'encryption_material_unavailable',
        });
    }

    // A failed worker dispatch is repaired by the socket handler's normal
    // artifact invalidation, rather than becoming a permanent locked fact.
    const decryptedKey = await resolveArtifactDataKey({ artifact: { id: artifactId, dataEncryptionKey }, encryption, artifactDataKeys });
    const provenanceArtifact = { id: artifactId, bodyVersion, provenance: params.provenance,
        provenanceDataEncryptionKey: params.provenanceDataEncryptionKey };
    const resolvedProvenanceDataKey = decryptedKey
        ? await resolveArtifactProvenanceDataKey({ ...params, artifact: provenanceArtifact }) : null;
    try {
        if (!decryptedKey) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        // Create artifact encryption instance
        const artifactEncryption = new ArtifactEncryption(decryptedKey);

        // Decrypt header
        const rawHeader = await artifactEncryption.decryptHeaderRaw(header);
        const decryptedHeader = rawHeader ? projectArtifactHeaderForDisplay(rawHeader) : null;
        if (!decryptedHeader) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        // Decrypt body if provided
        let decryptedBody: ArtifactBodyV1 | null | undefined = undefined;
        if (body && bodyVersion !== undefined) {
            const decrypted = await artifactEncryption.decryptBody(body);
            if (!decrypted) {
                return createLockedArtifactView({
                    artifact,
                    reason: 'decryption_failed',
                });
            }
            decryptedBody = decrypted.body;
            requireArtifactBodyKind(rawHeader!, decryptedBody);
        }

        return {
            id: artifactId,
            header: decryptedHeader,
            title: decryptedHeader.title || null,
            rawHeader,
            sessions: decryptedHeader.sessions,
            draft: decryptedHeader.draft,
            body: decryptedBody,
            provenance: await openArtifactProvenance({ ...params, mode: 'e2ee', artifact: provenanceArtifact, resolvedProvenanceDataKey }),
            headerVersion,
            bodyVersion,
            seq,
            createdAt,
            updatedAt,
            isDecrypted: true,
            storageMode: 'e2ee',
            storageIdentity: artifactStorageIdentity(params),
        };
    } catch (error) {
        log.log(`Failed to decrypt new artifact ${artifactId}: ${error}`);
        return createLockedArtifactView({
            artifact,
            reason: 'decryption_failed',
        });
    }
}

export async function applySocketArtifactUpdate(params: {
    existingArtifact: DecryptedArtifact;
    createdAt: number;
    dataEncryptionKey: Uint8Array | null;
    provenanceDataKey?: Uint8Array | null;
    provenance?: string | null;
    header?: { version: number; value: string } | null;
    body?: { version: number; value: string } | null;
}): Promise<DecryptedArtifact> {
    const { existingArtifact, createdAt, dataEncryptionKey, header, body } = params;

    const artifactEncryption = existingArtifact.storageMode === 'plain'
        ? null
        : new ArtifactEncryption(dataEncryptionKey ?? (() => {
            throw new Error('Artifact encryption key is unavailable');
        })());

    const existingHeaderVersion = existingArtifact.headerVersion ?? 0;
    const existingBodyVersion = existingArtifact.bodyVersion ?? 0;

    const shouldApplyHeader = !!header && header.version > existingHeaderVersion;
    const shouldApplyBody = !!body && body.version > existingBodyVersion;

    if (!shouldApplyHeader && !shouldApplyBody) {
        return existingArtifact;
    }

    if (existingArtifact.storageMode === 'plain') {
        try {
            if (shouldApplyHeader && header) decodePlainArtifactHeader(header.value);
            if (shouldApplyBody && body) decodePlainArtifactBody(body.value);
        } catch {
            return {
                id: existingArtifact.id,
                header: null,
                title: null,
                body: undefined,
                headerVersion: shouldApplyHeader && header
                    ? header.version
                    : existingArtifact.headerVersion,
                bodyVersion: shouldApplyBody && body
                    ? body.version
                    : existingArtifact.bodyVersion,
                seq: existingArtifact.seq,
                createdAt: existingArtifact.createdAt,
                updatedAt: createdAt,
                isDecrypted: false,
                storageMode: 'plain',
                availability: {
                    kind: 'locked',
                    reason: 'invalid_stored_content',
                },
            };
        }
    }

    // Update artifact with new data
    const updatedArtifact: DecryptedArtifact = {
        ...existingArtifact,
        updatedAt: createdAt,
    };
    const lockedUpdate = (reason: ArtifactLockedReason): DecryptedArtifact => ({
        ...updatedArtifact, isDecrypted: false, storageMode: existingArtifact.storageMode ?? 'e2ee',
        header: null, rawHeader: null, title: null, sessions: undefined, draft: undefined, body: undefined, provenance: undefined,
        availability: { kind: 'locked', reason },
    });

    // Decrypt and update header if provided
    if (shouldApplyHeader && header) {
        const rawHeader = existingArtifact.storageMode === 'plain'
            ? decodePlainArtifactHeaderRaw(header.value)
            : await artifactEncryption!.decryptHeaderRaw(header.value);
        const decryptedHeader = rawHeader ? projectArtifactHeaderForDisplay(rawHeader) : null;
        if (!decryptedHeader) return lockedUpdate('decryption_failed');
        updatedArtifact.header = decryptedHeader;
        updatedArtifact.rawHeader = rawHeader;
        updatedArtifact.title = decryptedHeader?.title || null;
        updatedArtifact.sessions = decryptedHeader?.sessions;
        updatedArtifact.draft = decryptedHeader?.draft;
        updatedArtifact.headerVersion = header.version;
    }

    // Decrypt and update body if provided
    if (shouldApplyBody && body) {
        const decryptedBody = existingArtifact.storageMode === 'plain'
            ? decodePlainArtifactBody(body.value)
            : await artifactEncryption!.decryptBody(body.value);
        if (!decryptedBody) return lockedUpdate('decryption_failed');
        updatedArtifact.body = decryptedBody.body;
        if (params.provenance != null) {
            try {
                updatedArtifact.provenance = await openArtifactPrivateRevisionMetadata({ mode: existingArtifact.storageMode ?? 'e2ee',
                    artifactId: existingArtifact.id, bodyVersion: body.version, provenance: params.provenance, dataKey: params.provenanceDataKey });
            } catch { return lockedUpdate('decryption_failed'); }
        }
        updatedArtifact.bodyVersion = body.version;
    }

    try {
        requireArtifactBodyKind(updatedArtifact.rawHeader ?? {}, updatedArtifact.body ?? null);
    } catch {
        return lockedUpdate('invalid_stored_content');
    }

    return updatedArtifact;
}

export async function handleNewArtifactSocketUpdate(params: {
    artifactId: string;
    dataEncryptionKey: string;
    provenance?: string | null;
    provenanceDataEncryptionKey?: string | null;
    header: string;
    headerVersion: number;
    body?: string | null;
    bodyVersion?: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    addArtifact: (artifact: DecryptedArtifact) => void;
    invalidateArtifactsSync: () => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        artifactId,
        dataEncryptionKey,
        header,
        headerVersion,
        body,
        bodyVersion,
        seq,
        createdAt,
        updatedAt,
        encryption,
        artifactDataKeys,
        addArtifact,
        log,
    } = params;

    try {
        const decrypted = await decryptSocketNewArtifactUpdate({
            provenance: params.provenance, provenanceDataEncryptionKey: params.provenanceDataEncryptionKey,
            artifactId,
            dataEncryptionKey,
            header,
            headerVersion,
            body,
            bodyVersion,
            seq,
            createdAt,
            updatedAt,
            encryption,
            artifactDataKeys,
        });
        if (!decrypted) {
            return;
        }

        addArtifact(decrypted);
        log.log(`📦 Added new artifact ${artifactId} to storage`);
    } catch (error) {
        log.log(`Failed to process new artifact ${artifactId}: ${error}`);
        params.invalidateArtifactsSync();
    }
}

export async function handleUpdateArtifactSocketUpdate(params: {
    artifactId: string;
    createdAt: number;
    provenance?: string | null;
    provenanceDataEncryptionKey?: string | null;
    encryption?: Encryption | null;
    header?: { version: number; value: string } | null;
    body?: { version: number; value: string } | null;
    artifactDataKeys: ArtifactDataKeyCache;
    getExistingArtifact: (artifactId: string) => DecryptedArtifact | undefined;
    updateArtifact: (artifact: DecryptedArtifact) => void;
    invalidateArtifactsSync: () => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        artifactId,
        createdAt,
        header,
        body,
        artifactDataKeys,
        getExistingArtifact,
        updateArtifact,
        invalidateArtifactsSync,
        log,
    } = params;

    const existingArtifact = getExistingArtifact(artifactId);
    if (!existingArtifact) {
        // Expected while the list has not caught up (a new Artifact's first update): the resync below repairs it,
        // so it is a diagnostic, not an error (a dev error overlay showed the raw id to the person).
        log.log(`Artifact ${artifactId} not in storage yet; resyncing`);
        // Fetch all artifacts to sync
        invalidateArtifactsSync();
        return;
    }

    try {
        // Get the data encryption key from memory
        const dataEncryptionKey = existingArtifact.storageMode === 'plain'
            ? null
            : artifactDataKeys.get(artifactId)?.dataKey ?? null;
        if (existingArtifact.storageMode !== 'plain' && !dataEncryptionKey) {
            log.log(`Encryption key not found for artifact ${artifactId}, fetching artifacts`);
            invalidateArtifactsSync();
            return;
        }

        const updatedArtifact = await applySocketArtifactUpdate({
            provenance: params.provenance,
            provenanceDataKey: params.provenance == null ? null : await resolveArtifactProvenanceDataKey({
                artifact: { id: artifactId, provenanceDataEncryptionKey: params.provenanceDataEncryptionKey
                    ?? artifactDataKeys.get(artifactId)?.provenanceEnvelope },
                encryption: params.encryption ?? null, artifactDataKeys }),
            existingArtifact,
            createdAt,
            dataEncryptionKey,
            header,
            body,
        });

        updateArtifact(updatedArtifact);
        log.log(`📦 Updated artifact ${artifactId} in storage`);
    } catch (error) {
        log.log(`Failed to process artifact update ${artifactId}: ${error}`);
        invalidateArtifactsSync();
    }
}

export function handleDeleteArtifactSocketUpdate(params: {
    artifactId: string;
    deleteArtifact: (artifactId: string) => void;
    artifactDataKeys: ArtifactDataKeyCache;
}): void {
    const { artifactId, deleteArtifact, artifactDataKeys } = params;

    // Remove from storage
    deleteArtifact(artifactId);

    // Remove encryption key from memory
    artifactDataKeys.delete(artifactId);
}
