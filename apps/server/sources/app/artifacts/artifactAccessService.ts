import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import * as privacyKit from "privacy-kit";
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { type ArtifactAccessErrorCodeV1, type ArtifactAccessGrantSetStorageInputV1, type ArtifactAccessGrantRemoveInputV1, type ArtifactAccessGrantsListResponseV1, type ArtifactAccessGrantMutationResponseV1, type ArtifactAccessRecipientCensusResponseV1, type ArtifactCallerAccessV1, type ArtifactRecipientKeyEnvelopeCommitInputV1, type ArtifactRecipientKeyEnvelopeCommitResponseV1, type ArtifactRecipientKeyEnvelopeInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import type { Tx } from "@/storage/inTx";
import { readSnapshotWithCurrentAdmission } from "@/storage/readSnapshotWithCurrentAdmission";
import { artifactVisibleWhere } from "./artifactClassification";
import { openArtifactStoredContentBytes, openArtifactProvenanceBytes, artifactProvenanceMatchesAccountMode } from "./artifactStoredContent";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { projectRecipientContentKey, RECIPIENT_READINESS_SELECT } from "@/app/session/encryption/sessionDataKeyRecipientProjection";
import { isEffectiveTeamMembership } from "@/app/teams/memberships/effectiveMembership";
import { isEffectiveTeamGroupMembership } from "@/app/teams/groups/effectiveGroupMembership";
import { markAccountsChanged } from "@/app/changes/markAccountChanged";
import { ACCOUNT_DISPLAY_PROFILE_SELECT, resolveAccountDisplayLabelV1 } from "@/app/account/profile/accountDisplayProfile";
import { isPublicSessionShareActive } from "@/app/share/publicSessionSharePublication";
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

export interface ArtifactAccess {
    ownerAccountId: string;
    level: ArtifactCallerAccessV1;
    encryptionMode: "plain" | "e2ee" | null;
}

const accessRank = { view: 1, edit: 2, admin: 3, owner: 4 } as const;
const artifactAddress = (artifactId: string) => ({ id: artifactId, ...artifactVisibleWhere });

function artifactAccessFactsSelect(actorAccountId?: string) {
    const accountFilter = actorAccountId === undefined ? {} : { accountId: actorAccountId };
    return {
        accountId: true, account: { select: { encryptionMode: true } },
        accountGrants: { where: accountFilter, select: { accountId: true, accessLevel: true, account: { select: { status: true } } } },
        teamGrants: { select: { accessLevel: true, team: { select: {
            archivedAt: true, memberships: { where: accountFilter, select: { accountId: true, status: true, account: { select: { status: true } } } },
        } } } },
        groupGrants: { select: { accessLevel: true, teamGroup: { select: {
            archivedAt: true, team: { select: { archivedAt: true } },
            memberships: { where: { teamMembership: accountFilter }, select: { teamMembership: {
                select: { accountId: true, status: true, account: { select: { status: true } } },
            } } },
        } } } },
    } as const;
}

async function readArtifactAccessFactsInTx(tx: Tx, artifactId: string, actorAccountId?: string) {
    return tx.artifact.findFirst({ where: artifactAddress(artifactId), select: artifactAccessFactsSelect(actorAccountId) });
}

type ArtifactAccessFacts = NonNullable<Awaited<ReturnType<typeof readArtifactAccessFactsInTx>>>;

function resolveArtifactAccessFromFacts(row: ArtifactAccessFacts, actorAccountId: string): ArtifactAccess | null {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    const encryptionMode = mode.status === "ready" ? mode.mode : null;
    if (row.accountId === actorAccountId) return { ownerAccountId: row.accountId, level: "owner", encryptionMode };
    let level: ArtifactCallerAccessV1 | null = null;
    const include = (candidate: "view" | "edit" | "admin") => {
        if (level === null || accessRank[candidate] > accessRank[level]) level = candidate;
    };
    for (const grant of row.accountGrants) {
        if (grant.accountId === actorAccountId && grant.account.status === "active") include(grant.accessLevel);
    }
    for (const grant of row.teamGrants) {
        if (grant.team.memberships.some(member => member.accountId === actorAccountId && isEffectiveTeamMembership({
            accountStatus: member.account.status, membershipStatus: member.status, teamArchivedAt: grant.team.archivedAt,
        }))) include(grant.accessLevel);
    }
    for (const grant of row.groupGrants) {
        if (grant.teamGroup.memberships.some(({ teamMembership: member }) => member.accountId === actorAccountId && isEffectiveTeamGroupMembership({
            accountStatus: member.account.status, membershipStatus: member.status,
            teamArchivedAt: grant.teamGroup.team.archivedAt, groupArchivedAt: grant.teamGroup.archivedAt,
        }))) include(grant.accessLevel);
    }
    return level === null ? null : { ownerAccountId: row.accountId, level, encryptionMode };
}

/** The sole document access decision: ownership or the highest live grant. */
export async function resolveArtifactAccessInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactId: string;
}>): Promise<ArtifactAccess | null> {
    const row = await readArtifactAccessFactsInTx(tx, input.artifactId, input.actorAccountId);
    return row ? resolveArtifactAccessFromFacts(row, input.actorAccountId) : null;
}

/** Candidate discovery starts at grant relations, then the access owner decides. */
export async function listArtifactCandidatesInTx(tx: Tx, actorAccountId: string): Promise<string[]> {
    const [owned, direct, memberships, groupMemberships] = await Promise.all([
        tx.artifact.findMany({ where: { accountId: actorAccountId, ...artifactVisibleWhere }, select: { id: true } }),
        tx.artifactAccountGrant.findMany({ where: { accountId: actorAccountId }, select: { artifactId: true } }),
        tx.teamMembership.findMany({ where: { accountId: actorAccountId }, select: { teamId: true } }),
        tx.teamGroupMembership.findMany({ where: { teamMembership: { accountId: actorAccountId } }, select: { teamGroupId: true } }),
    ]);
    const [teams, groups] = await Promise.all([
        tx.artifactTeamGrant.findMany({ where: { teamId: { in: memberships.map(row => row.teamId) } }, select: { artifactId: true } }),
        tx.artifactGroupGrant.findMany({ where: { teamGroupId: { in: groupMemberships.map(row => row.teamGroupId) } }, select: { artifactId: true } }),
    ]);
    return [...new Set([...owned.map(row => row.id), ...direct.map(row => row.artifactId),
        ...teams.map(row => row.artifactId), ...groups.map(row => row.artifactId)])];
}

/** Fan-out and recipient preparation consume the same live access decision. */
export async function resolveArtifactAudienceInTx(tx: Tx, artifactId: string): Promise<string[]> {
    const row = await readArtifactAccessFactsInTx(tx, artifactId);
    if (!row) return [];
    const candidates = new Set([row.accountId, ...row.accountGrants.map(grant => grant.accountId),
        ...row.teamGrants.flatMap(grant => grant.team.memberships.map(member => member.accountId)),
        ...row.groupGrants.flatMap(grant => grant.teamGroup.memberships.map(member => member.teamMembership.accountId))]);
    return [...candidates].filter(actorAccountId => resolveArtifactAccessFromFacts(row, actorAccountId) !== null).sort();
}

export interface ArtifactForCaller {
    id: string;
    ownerAccountId: string;
    access: ArtifactCallerAccessV1;
    encryptionMode: "plain" | "e2ee";
    header: Uint8Array<ArrayBuffer>;
    body: Uint8Array<ArrayBuffer>;
    headerVersion: number;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array<ArrayBuffer>;
    provenance: Uint8Array<ArrayBuffer> | null;
    provenanceDataEncryptionKey: Uint8Array<ArrayBuffer> | null;
    seq: number;
    createdAt: Date;
    updatedAt: Date;
}

type ArtifactReadFailure = Readonly<{ ok: false; error: "artifact_not_found" | "artifact_content_unavailable"; ownerAccountId?: string }>;
export type ArtifactReadResult = Readonly<{ ok: true; artifact: ArtifactForCaller }> | ArtifactReadFailure;
export type ArtifactHeaderForCaller = Omit<ArtifactForCaller, "body" | "bodyVersion" | "provenance">;
export type ArtifactListItemForCaller = ArtifactHeaderForCaller & Pick<ArtifactForCaller, "bodyVersion" | "provenance"> & Partial<Pick<ArtifactForCaller, "body">>;
export type ArtifactHeaderReadResult = Readonly<{ ok: true; artifact: ArtifactHeaderForCaller }> | ArtifactReadFailure;

/** Project already-authorized Plain bytes once; E2EE remains client-opened. */
export function projectPlainArtifactSharingResourceV1(artifact: ArtifactForCaller): ArtifactSharingResourceV1 | null {
    if (artifact.encryptionMode !== 'plain') return null;
    const header = ArtifactHeaderMetadataV1Schema.safeParse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(artifact.header)));
    const body = ArtifactBodyEnvelopeV1StoredSchema.safeParse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(artifact.body)));
    if (!header.success || !body.success) return null;
    return { artifactId: artifact.id, header: header.data, body: body.data.body,
        ownerAccountId: artifact.ownerAccountId, access: artifact.access,
        revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
}

type StoredRecipientEnvelope = Readonly<{ encryptedDataKey: Uint8Array; recipientContentPublicKeyFingerprint: string }>;
function projectRecipientEnvelope(account: Parameters<typeof deriveAccountRecipientEnvelopeReadinessFromRow>[0], envelope: StoredRecipientEnvelope): Uint8Array<ArrayBuffer> | null {
    const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
    return readiness.status === "available"
        && readiness.binding.contentPublicKeyFingerprint === envelope.recipientContentPublicKeyFingerprint
        && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) !== null
        ? new Uint8Array(envelope.encryptedDataKey) : null;
}

const headerContentSelect = {
    id: true, header: true, headerVersion: true, dataEncryptionKey: true, seq: true, createdAt: true, updatedAt: true,
    provenanceDataEncryptionKey: true,
} as const;
type StoredArtifactHeader = Readonly<{
    id: string; header: Uint8Array; headerVersion: number; dataEncryptionKey: Uint8Array;
    provenanceDataEncryptionKey: Uint8Array | null;
    seq: number; createdAt: Date; updatedAt: Date;
}>;

function projectArtifactHeader(row: StoredArtifactHeader, access: ArtifactAccess, key: Uint8Array<ArrayBuffer> | null,
    provenanceKey: Uint8Array<ArrayBuffer> | null): ArtifactHeaderReadResult {
    if (!access.encryptionMode || !key) return { ok: false, error: "artifact_content_unavailable", ownerAccountId: access.ownerAccountId };
    if (!artifactProvenanceMatchesAccountMode({ mode: access.encryptionMode, artifactId: row.id, bodyVersion: 0,
        provenance: null, provenanceDataEncryptionKey: row.provenanceDataEncryptionKey })) return { ok: false, error: 'artifact_content_unavailable', ownerAccountId: access.ownerAccountId };
    const header = openArtifactStoredContentBytes({ accountId: access.ownerAccountId, artifactId: row.id,
        mode: access.encryptionMode, dataEncryptionKey: row.dataEncryptionKey, content: row.header, field: "header" });
    if (!header) return { ok: false, error: "artifact_content_unavailable", ownerAccountId: access.ownerAccountId };
    return { ok: true, artifact: { id: row.id, ownerAccountId: access.ownerAccountId,
        access: access.level, encryptionMode: access.encryptionMode, header,
        headerVersion: row.headerVersion, dataEncryptionKey: key,
        provenanceDataEncryptionKey: provenanceKey,
        seq: row.seq, createdAt: row.createdAt, updatedAt: row.updatedAt } };
}

/** Revision-bound private metadata is available in header inventories without loading document bodies. */
function projectArtifactRevisionMetadata(header: ArtifactHeaderForCaller,
    row: Readonly<{ bodyVersion: number; dataEncryptionKey: Uint8Array; provenance: Uint8Array | null }>):
    Readonly<{ ok: true; artifact: ArtifactListItemForCaller }> | ArtifactReadFailure {
    const provenance = row.provenance && (header.encryptionMode === 'plain' || header.provenanceDataEncryptionKey)
        ? openArtifactProvenanceBytes({ accountId: header.ownerAccountId, artifactId: header.id, mode: header.encryptionMode,
            dataEncryptionKey: row.dataEncryptionKey, content: row.provenance, bodyVersion: row.bodyVersion,
            provenanceDataEncryptionKey: header.provenanceDataEncryptionKey }) : null;
    if (row.provenance && (header.encryptionMode === 'plain' || header.provenanceDataEncryptionKey) && !provenance) {
        return { ok: false, error: 'artifact_content_unavailable', ownerAccountId: header.ownerAccountId };
    }
    if (row.provenance && header.encryptionMode === 'e2ee' && header.access === 'owner' && !header.provenanceDataEncryptionKey) {
        return { ok: false, error: 'artifact_content_unavailable', ownerAccountId: header.ownerAccountId };
    }
    return { ok: true, artifact: { ...header, bodyVersion: row.bodyVersion, provenance } };
}

function projectArtifactBody(header: ArtifactHeaderForCaller,
    row: Readonly<{ body: Uint8Array; bodyVersion: number; dataEncryptionKey: Uint8Array; provenance: Uint8Array | null }>): ArtifactReadResult {
    const metadata = projectArtifactRevisionMetadata(header, row);
    if (!metadata.ok) return metadata;
    const body = openArtifactStoredContentBytes({ accountId: header.ownerAccountId, artifactId: header.id,
        mode: header.encryptionMode, dataEncryptionKey: row.dataEncryptionKey, content: row.body, field: "body" });
    return body ? { ok: true, artifact: { ...metadata.artifact, body } }
        : { ok: false, error: "artifact_content_unavailable", ownerAccountId: header.ownerAccountId };
}

async function recipientEnvelopesInTx(tx: Tx, artifactId: string, actorAccountId: string) {
    const [account, envelope] = await Promise.all([
        tx.account.findUnique({ where: { id: actorAccountId }, select: RECIPIENT_READINESS_SELECT }),
        tx.artifactKeyEnvelope.findUnique({ where: { artifactId_recipientAccountId: { artifactId, recipientAccountId: actorAccountId } } }),
    ]);
    if (!account || !envelope) return { content: null, provenance: null };
    return { content: projectRecipientEnvelope(account, envelope), provenance: envelope.encryptedProvenanceDataKey
        ? projectRecipientEnvelope(account, { ...envelope, encryptedDataKey: envelope.encryptedProvenanceDataKey }) : null };
}

/** Header lists and exact reads share access, mode and the caller's envelope projection. */
export async function readArtifactHeaderForCallerInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactId: string;
}>): Promise<ArtifactHeaderReadResult> {
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId),
        select: artifactReadAdmissionSelect(input.actorAccountId) });
    return row ? projectArtifactAdmittedHeader(row, input.actorAccountId)
        : { ok: false, error: "artifact_not_found" };
}

/** Open only server at-rest Plain content; E2EE stays opaque with the caller's envelope. */
export async function readArtifactForCallerInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactId: string;
}>): Promise<Readonly<{ ok: true; artifact: ArtifactForCaller & { publicAudience: "retained" | "none" } }> | ArtifactReadFailure> {
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId), select: {
        ...artifactReadAdmissionSelect(input.actorAccountId), body: true, bodyVersion: true, provenance: true,
    } });
    if (!row) return { ok: false, error: "artifact_not_found" };
    const header = projectArtifactAdmittedHeader(row, input.actorAccountId);
    if (!header.ok) return header;
    const read = projectArtifactBody(header.artifact, row);
    if (!read.ok) return read;
    const publication = await tx.publicSessionShare.findUnique({ where: { artifactId: input.artifactId }, select: { expiresAt: true } });
    return { ok: true, artifact: { ...read.artifact, publicAudience: isPublicSessionShareActive(publication) ? "retained" : "none" } };
}

/** Re-admit captured content through the same mode and recipient-key owner. */
export async function readmitArtifactContentInTx(tx: Tx, input: Readonly<{ actorAccountId: string; artifactId: string }>,
    captured: Pick<ArtifactHeaderForCaller, "ownerAccountId" | "encryptionMode" | "dataEncryptionKey" | "provenanceDataEncryptionKey">): Promise<ArtifactHeaderReadResult> {
    const current = await readArtifactHeaderForCallerInTx(tx, input);
    if (!current.ok) return current;
    if (!artifactContentAdmissionMatches(current.artifact, captured)) {
        return { ok: false, error: "artifact_content_unavailable", ownerAccountId: current.artifact.ownerAccountId };
    }
    return current;
}

export async function readArtifactForCaller(input: Readonly<{ actorAccountId: string; artifactId: string }>): Promise<Awaited<ReturnType<typeof readArtifactForCallerInTx>>> {
    return await readSnapshotWithCurrentAdmission<Awaited<ReturnType<typeof readArtifactForCallerInTx>>>(
        tx => readArtifactForCallerInTx(tx, input), async (tx, captured) => {
            if (!captured.ok) return captured;
            const current = await readmitArtifactContentInTx(tx, input, captured.artifact);
            if (!current.ok) return current;
            return { ...captured, artifact: { ...captured.artifact, access: current.artifact.access } };
        });
}

function artifactReadAdmissionSelect(actorAccountId: string) {
    return { ...artifactAccessFactsSelect(actorAccountId), ...headerContentSelect,
        keyEnvelopes: { where: { recipientAccountId: actorAccountId }, select: {
            encryptedDataKey: true, recipientContentPublicKeyFingerprint: true, recipient: { select: RECIPIENT_READINESS_SELECT },
            encryptedProvenanceDataKey: true,
        } } } as const;
}

function projectArtifactAdmittedHeader(row: Prisma.ArtifactGetPayload<{ select: ReturnType<typeof artifactReadAdmissionSelect> }>, actorAccountId: string): ArtifactHeaderReadResult {
    const access = resolveArtifactAccessFromFacts(row, actorAccountId);
    if (!access) return { ok: false, error: "artifact_not_found" };
    const envelope = row.keyEnvelopes[0];
    const key = access.level === "owner" || access.encryptionMode === "plain" ? new Uint8Array(row.dataEncryptionKey)
        : envelope ? projectRecipientEnvelope(envelope.recipient, envelope) : null;
    const privateKey = access.encryptionMode === "plain" ? null : access.level === "owner"
        ? row.provenanceDataEncryptionKey ? new Uint8Array(row.provenanceDataEncryptionKey) : null
        : envelope?.encryptedProvenanceDataKey ? projectRecipientEnvelope(envelope.recipient, { ...envelope, encryptedDataKey: envelope.encryptedProvenanceDataKey }) : null;
    return projectArtifactHeader(row, access, key, privateKey);
}

function artifactContentAdmissionMatches(current: ArtifactHeaderForCaller, captured: Pick<ArtifactHeaderForCaller,
    "ownerAccountId" | "encryptionMode" | "dataEncryptionKey" | "provenanceDataEncryptionKey">): boolean {
    return current.ownerAccountId === captured.ownerAccountId && current.encryptionMode === captured.encryptionMode
        && isDeepStrictEqual(current.dataEncryptionKey, captured.dataEncryptionKey)
        && isDeepStrictEqual(current.provenanceDataEncryptionKey, captured.provenanceDataEncryptionKey);
}

/** Batch list projection preserves the endpoint's existing keyset and page size without per-row queries. */
export async function listArtifactHeadersForCallerInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; limit: number; cursor: Readonly<{ updatedAt: Date; id: string }> | null;
    includeBody?: boolean;
}>): Promise<ArtifactListItemForCaller[]> {
    const candidates = await listArtifactCandidatesInTx(tx, input.actorAccountId);
    const result: ArtifactListItemForCaller[] = [];
    let cursor = input.cursor;
    while (result.length < input.limit) {
        const rows = await tx.artifact.findMany({ where: {
            id: { in: candidates }, ...artifactVisibleWhere,
            ...(cursor ? { OR: [
                { updatedAt: { lt: cursor.updatedAt } },
                { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
            ] } : {}),
        }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: input.limit, select: {
            ...artifactReadAdmissionSelect(input.actorAccountId),
            body: input.includeBody === true, bodyVersion: true, provenance: true,
        } });
        for (const row of rows) {
            const access = resolveArtifactAccessFromFacts(row, input.actorAccountId);
            if (!access) continue;
            const read = projectArtifactAdmittedHeader(row, input.actorAccountId);
            if (!read.ok) {
                if (access.level === "owner") throw new Error("Artifact content is unavailable");
                continue;
            }
            const content = input.includeBody ? projectArtifactBody(read.artifact, row) : projectArtifactRevisionMetadata(read.artifact, row);
            if (!content.ok) {
                if (access.level === "owner") throw new Error("Artifact content is unavailable");
                continue;
            }
            result.push(content.artifact);
            if (result.length === input.limit) return result;
        }
        if (rows.length < input.limit) break;
        const last = rows[rows.length - 1];
        cursor = { updatedAt: last.updatedAt, id: last.id };
    }
    return result;
}

export async function listArtifactHeadersForCaller(input: Parameters<typeof listArtifactHeadersForCallerInTx>[1]): Promise<ArtifactListItemForCaller[]> {
    return await readSnapshotWithCurrentAdmission(tx => listArtifactHeadersForCallerInTx(tx, input), async (tx, captured) => {
        if (captured.length === 0) return captured;
        const rows = await tx.artifact.findMany({ where: { id: { in: captured.map(row => row.id) }, ...artifactVisibleWhere },
            select: artifactReadAdmissionSelect(input.actorAccountId) });
        const currentById = new Map(rows.map(row => [row.id, projectArtifactAdmittedHeader(row, input.actorAccountId)]));
        return captured.flatMap(artifact => {
            const current = currentById.get(artifact.id);
            return current?.ok && artifactContentAdmissionMatches(current.artifact, artifact)
                ? [{ ...artifact, access: current.artifact.access }] : [];
        });
    });
}

export async function listArtifactAccessGrants(input: Parameters<typeof listArtifactAccessGrantsInTx>[1]): Promise<Awaited<ReturnType<typeof listArtifactAccessGrantsInTx>>> {
    return await readSnapshotWithCurrentAdmission<Awaited<ReturnType<typeof listArtifactAccessGrantsInTx>>>(
        tx => listArtifactAccessGrantsInTx(tx, input), async (tx, captured) => {
            if (!captured.ok) return captured;
            const current = await resolveArtifactAccessInTx(tx, input);
            if (!current) return { ok: false, error: "artifact_not_found" };
            return { ...captured, value: { ...captured.value, access: current.level } };
        });
}

export async function readArtifactRecipientCensus(input: Parameters<typeof readArtifactRecipientCensusInTx>[1]): Promise<Awaited<ReturnType<typeof readArtifactRecipientCensusInTx>>> {
    return await readSnapshotWithCurrentAdmission<Awaited<ReturnType<typeof readArtifactRecipientCensusInTx>>>(
        tx => readArtifactRecipientCensusInTx(tx, input), async (tx, captured) => {
            if (!captured.ok) return captured;
            const current = await readArtifactRecipientCensusInTx(tx, input);
            if (!current.ok) return current;
            return isDeepStrictEqual(current.value, captured.value) ? captured : { ok: false, error: "artifact_content_unavailable" };
        });
}

type ArtifactBatchReadItem = Readonly<{
    artifactId: string;
    read: Awaited<ReturnType<typeof readArtifactForCallerInTx>>;
    census: Awaited<ReturnType<typeof readArtifactRecipientCensusInTx>> | null;
}>;

export async function readArtifactBatchForCaller(input: Readonly<{ actorAccountId: string; artifactIds: readonly string[] }>): Promise<ArtifactBatchReadItem[]> {
    return await readSnapshotWithCurrentAdmission<ArtifactBatchReadItem[]>(async tx => {
        const items: ArtifactBatchReadItem[] = [];
        for (const artifactId of input.artifactIds) {
            const address = { actorAccountId: input.actorAccountId, artifactId };
            const read = await readArtifactForCallerInTx(tx, address);
            const census = read.ok && read.artifact.encryptionMode === "e2ee" ? await readArtifactRecipientCensusInTx(tx, address) : null;
            items.push({ artifactId, read, census });
        }
        return items;
    }, async (tx, captured) => {
        const items: ArtifactBatchReadItem[] = [];
        for (const item of captured) {
            if (!item.read.ok) { items.push(item); continue; }
            const address = { actorAccountId: input.actorAccountId, artifactId: item.artifactId };
            const current = await readmitArtifactContentInTx(tx, address, item.read.artifact);
            if (!current.ok) { items.push({ ...item, read: current, census: null }); continue; }
            let census = item.census;
            if (census?.ok) {
                const admittedCensus = await readArtifactRecipientCensusInTx(tx, address);
                census = !admittedCensus.ok ? admittedCensus : isDeepStrictEqual(admittedCensus.value, census.value)
                    ? census : { ok: false, error: "artifact_content_unavailable" };
            }
            items.push({ ...item, read: { ...item.read, artifact: { ...item.read.artifact, access: current.artifact.access } }, census });
        }
        return items;
    });
}

type AccessResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: ArtifactAccessErrorCodeV1 }>;

/** Grant inspection is visible to every grantee; owner and admin may manage access. */
export async function listArtifactAccessGrantsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactId: string;
}>): Promise<AccessResult<ArtifactAccessGrantsListResponseV1>> {
    const access = await resolveArtifactAccessInTx(tx, input);
    if (!access) return { ok: false, error: "artifact_not_found" };
    const [accounts, teams, groups] = await Promise.all([
        tx.artifactAccountGrant.findMany({ where: { artifactId: input.artifactId }, include: { account: { select: ACCOUNT_DISPLAY_PROFILE_SELECT } } }),
        tx.artifactTeamGrant.findMany({ where: { artifactId: input.artifactId }, include: { team: { select: { name: true } } } }),
        tx.artifactGroupGrant.findMany({ where: { artifactId: input.artifactId }, include: { teamGroup: { select: { name: true, teamId: true } } } }),
    ]);
    return { ok: true, value: { artifactId: input.artifactId, ownerAccountId: access.ownerAccountId, access: access.level,
        grants: [
            ...accounts.map(row => ({ principal: { kind: "account" as const, accountId: row.accountId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), display: { name: resolveAccountDisplayLabelV1(row.account), username: row.account.username } })),
            ...teams.map(row => ({ principal: { kind: "team" as const, teamId: row.teamId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), display: { name: row.team.name } })),
            ...groups.map(row => ({ principal: { kind: "group" as const, teamId: row.teamGroup.teamId, groupId: row.teamGroupId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), display: { name: row.teamGroup.name } })),
        ] } };
}

/** Owner/admin idempotent grant writes; only the owner may assign admin. */
export async function setArtifactAccessGrantInTx(tx: Tx, input: ArtifactAccessGrantSetStorageInputV1 & { actorAccountId: string }): Promise<AccessResult<ArtifactAccessGrantMutationResponseV1>> {
    const access = await resolveArtifactAccessInTx(tx, input);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if ((access.level !== "owner" && access.level !== "admin")
        || (access.level !== "owner" && input.accessLevel === "admin")) return { ok: false, error: "artifact_access_forbidden" };
    const principal = input.principal;
    const data = { accessLevel: input.accessLevel, createdByAccountId: input.actorAccountId };
    let changed = false;
    if (principal.kind === "account") {
        if (principal.accountId === access.ownerAccountId) return { ok: false, error: "artifact_owner_grant_invalid" };
        const subject = await tx.account.findUnique({ where: { id: principal.accountId }, select: { status: true } });
        if (!subject) return { ok: false, error: "artifact_subject_not_found" };
        if (subject.status !== "active") return { ok: false, error: "artifact_subject_ineligible" };
        const where = { artifactId_accountId: { artifactId: input.artifactId, accountId: principal.accountId } };
        const previous = await tx.artifactAccountGrant.findUnique({ where });
        changed = previous?.accessLevel !== input.accessLevel;
        if (changed) await tx.artifactAccountGrant.upsert({ where, create: { artifactId: input.artifactId, accountId: principal.accountId, ...data }, update: data });
    } else if (principal.kind === "team") {
        const subject = await tx.team.findUnique({ where: { id: principal.teamId }, select: { archivedAt: true } });
        if (!subject) return { ok: false, error: "artifact_subject_not_found" };
        if (subject.archivedAt) return { ok: false, error: "artifact_subject_ineligible" };
        const where = { artifactId_teamId: { artifactId: input.artifactId, teamId: principal.teamId } };
        const previous = await tx.artifactTeamGrant.findUnique({ where });
        changed = previous?.accessLevel !== input.accessLevel;
        if (changed) await tx.artifactTeamGrant.upsert({ where, create: { artifactId: input.artifactId, teamId: principal.teamId, ...data }, update: data });
    } else {
        const subject = await tx.teamGroup.findUnique({ where: { id: principal.groupId }, select: { teamId: true, archivedAt: true, team: { select: { archivedAt: true } } } });
        if (!subject || subject.teamId !== principal.teamId) return { ok: false, error: "artifact_subject_not_found" };
        if (subject.archivedAt || subject.team.archivedAt) return { ok: false, error: "artifact_subject_ineligible" };
        const where = { artifactId_teamGroupId: { artifactId: input.artifactId, teamGroupId: principal.groupId } };
        const previous = await tx.artifactGroupGrant.findUnique({ where });
        changed = previous?.accessLevel !== input.accessLevel;
        if (changed) await tx.artifactGroupGrant.upsert({ where, create: { artifactId: input.artifactId, teamGroupId: principal.groupId, ...data }, update: data });
    }
    if (changed) {
        await markAccountsChanged(tx, { accountIds: await resolveArtifactAudienceInTx(tx, input.artifactId), kind: "artifact", entityId: input.artifactId });
    }
    const listed = await listArtifactAccessGrantsInTx(tx, input);
    return listed.ok ? { ok: true, value: { ...listed.value, changed } } : listed;
}

/** Revocation removes unreachable envelopes and reports success without a roster when the caller loses access. */
export async function removeArtifactAccessGrantInTx(tx: Tx, input: ArtifactAccessGrantRemoveInputV1 & { actorAccountId: string }): Promise<AccessResult<ArtifactAccessGrantMutationResponseV1>> {
    const access = await resolveArtifactAccessInTx(tx, input);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if (access.level !== "owner" && access.level !== "admin") return { ok: false, error: "artifact_access_forbidden" };
    const previousAudience = await resolveArtifactAudienceInTx(tx, input.artifactId);
    const principal = input.principal;
    if (principal.kind === "group") {
        const group = await tx.teamGroup.findUnique({ where: { id: principal.groupId }, select: { teamId: true } });
        if (!group || group.teamId !== principal.teamId) return { ok: false, error: "artifact_subject_not_found" };
    }
    const deleted = principal.kind === "account"
        ? await tx.artifactAccountGrant.deleteMany({ where: { artifactId: input.artifactId, accountId: principal.accountId } })
        : principal.kind === "team"
            ? await tx.artifactTeamGrant.deleteMany({ where: { artifactId: input.artifactId, teamId: principal.teamId } })
            : await tx.artifactGroupGrant.deleteMany({ where: { artifactId: input.artifactId, teamGroupId: principal.groupId } });
    const audience = await resolveArtifactAudienceInTx(tx, input.artifactId);
    await tx.artifactKeyEnvelope.deleteMany({ where: { artifactId: input.artifactId, recipientAccountId: { notIn: audience } } });
    if (deleted.count > 0) {
        await markAccountsChanged(tx, { accountIds: previousAudience, kind: "artifact", entityId: input.artifactId });
    }
    const listed = await listArtifactAccessGrantsInTx(tx, input);
    return { ok: true, value: listed.ok
        ? { ...listed.value, changed: deleted.count > 0 }
        : { artifactId: input.artifactId, ownerAccountId: access.ownerAccountId,
            access: null, grants: [], changed: deleted.count > 0 } };
}

/** Current audience plus verified binding and envelope state for a key-holding host. */
export async function readArtifactRecipientCensusInTx(tx: Tx, input: Readonly<{ actorAccountId: string; artifactId: string }>): Promise<AccessResult<ArtifactAccessRecipientCensusResponseV1>> {
    const access = await resolveArtifactAccessInTx(tx, input);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if (!access.encryptionMode) return { ok: false, error: "artifact_content_unavailable" };
    const row = await tx.artifact.findUniqueOrThrow({ where: { id: input.artifactId }, select: { dataEncryptionKey: true, provenanceDataEncryptionKey: true } });
    if (!artifactProvenanceMatchesAccountMode({ mode: access.encryptionMode, artifactId: input.artifactId, bodyVersion: 0,
        provenance: null, provenanceDataEncryptionKey: row.provenanceDataEncryptionKey })) return { ok: false, error: 'artifact_content_unavailable' };
    const audience = await resolveArtifactAudienceInTx(tx, input.artifactId);
    const [accounts, envelopes] = await Promise.all([
        tx.account.findMany({ where: { id: { in: audience } }, select: RECIPIENT_READINESS_SELECT, orderBy: { id: "asc" } }),
        tx.artifactKeyEnvelope.findMany({ where: { artifactId: input.artifactId } }),
    ]);
    const byAccount = new Map(envelopes.map(envelope => [envelope.recipientAccountId, envelope]));
    const plain = access.encryptionMode === "plain";
    const callerEnvelopes = !plain && access.level !== 'owner' ? await recipientEnvelopesInTx(tx, input.artifactId, input.actorAccountId) : null;
    const callerKey = plain ? null : access.level === "owner" ? new Uint8Array(row.dataEncryptionKey) : callerEnvelopes?.content ?? null;
    const callerPrivateKey = plain ? null : access.level === 'owner'
        ? row.provenanceDataEncryptionKey ? new Uint8Array(row.provenanceDataEncryptionKey) : null : callerEnvelopes?.provenance ?? null;
    if (!plain && !callerKey) return { ok: false, error: "artifact_content_unavailable" };
    return { ok: true, value: { artifactId: input.artifactId, ownerAccountId: access.ownerAccountId,
        access: access.level, encryptionMode: access.encryptionMode,
        dataEncryptionKey: plain ? null : privacyKit.encodeBase64(new Uint8Array(row.dataEncryptionKey)),
        callerDataEncryptionKey: callerKey ? privacyKit.encodeBase64(callerKey) : null,
        provenanceDataEncryptionKey: !plain && row.provenanceDataEncryptionKey ? privacyKit.encodeBase64(new Uint8Array(row.provenanceDataEncryptionKey)) : null,
        callerProvenanceDataEncryptionKey: callerPrivateKey ? privacyKit.encodeBase64(callerPrivateKey) : null,
        recipients: accounts.map(account => {
            const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
            const envelope = byAccount.get(account.id);
            const fingerprint = readiness.status === "available" ? readiness.binding.contentPublicKeyFingerprint : null;
            const ownerEnvelope = !plain && account.id === access.ownerAccountId && fingerprint !== null
                && parseEncryptedDataKeyEnvelopeV1(row.dataEncryptionKey) !== null;
            const current = !plain && envelope && fingerprint === envelope.recipientContentPublicKeyFingerprint
                && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) !== null;
            return { recipientAccountId: account.id, contentKey: projectRecipientContentKey(account, readiness),
                contentPublicKeyFingerprint: fingerprint,
                encryptedDataKey: ownerEnvelope ? privacyKit.encodeBase64(new Uint8Array(row.dataEncryptionKey))
                    : current ? privacyKit.encodeBase64(new Uint8Array(envelope.encryptedDataKey)) : null,
                encryptedProvenanceDataKey: ownerEnvelope && row.provenanceDataEncryptionKey ? privacyKit.encodeBase64(new Uint8Array(row.provenanceDataEncryptionKey))
                    : current && envelope.encryptedProvenanceDataKey && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedProvenanceDataKey)
                        ? privacyKit.encodeBase64(new Uint8Array(envelope.encryptedProvenanceDataKey)) : null,
                recipientContentPublicKeyFingerprint: ownerEnvelope ? fingerprint : envelope?.recipientContentPublicKeyFingerprint ?? null };
        }) } };
}

/** Commit opaque client-prepared tuples only while owner key, caller and recipient remain current. */
export async function commitArtifactRecipientKeyEnvelopesInTx(tx: Tx, input: ArtifactRecipientKeyEnvelopeCommitInputV1 & { actorAccountId: string }): Promise<AccessResult<ArtifactRecipientKeyEnvelopeCommitResponseV1>> {
    const access = await resolveArtifactAccessInTx(tx, input);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if (access.encryptionMode === "plain") return { ok: false, error: "data_key_not_required" };
    if (access.encryptionMode !== "e2ee") return { ok: false, error: "artifact_content_unavailable" };
    const caller = await readArtifactForCallerInTx(tx, input);
    if (!caller.ok) return caller;
    const row = await tx.artifact.findUniqueOrThrow({ where: { id: input.artifactId }, select: { dataEncryptionKey: true, provenanceDataEncryptionKey: true } });
    if (!isDeepStrictEqual(new Uint8Array(row.dataEncryptionKey), privacyKit.decodeBase64(input.expectedDataEncryptionKey))) {
        return { ok: false, error: "artifact_data_key_changed" };
    }
    const expectedPrivate = input.expectedProvenanceDataEncryptionKey == null ? null : privacyKit.decodeBase64(input.expectedProvenanceDataEncryptionKey);
    if ((input.expectedProvenanceDataEncryptionKey !== undefined || input.recipientKeyEnvelopes.some(envelope => envelope.encryptedProvenanceDataKey !== undefined))
        && !isDeepStrictEqual(row.provenanceDataEncryptionKey ? new Uint8Array(row.provenanceDataEncryptionKey) : null, expectedPrivate)) {
        return { ok: false, error: 'artifact_data_key_changed' };
    }
    for (const envelope of input.recipientKeyEnvelopes) {
        if (!parseEncryptedDataKeyEnvelopeV1(privacyKit.decodeBase64(envelope.encryptedDataKey))) {
            return { ok: false, error: "artifact_invalid_recipient_envelope" };
        }
        if (envelope.encryptedProvenanceDataKey !== undefined && (!row.provenanceDataEncryptionKey
            || !parseEncryptedDataKeyEnvelopeV1(privacyKit.decodeBase64(envelope.encryptedProvenanceDataKey)))) {
            return { ok: false, error: 'artifact_invalid_recipient_envelope' };
        }
    }
    return { ok: true, value: await applyArtifactRecipientKeyEnvelopesInTx(tx, input) };
}

/** Both fenced commits and Account transitions revalidate recipients through this owner. */
export async function applyArtifactRecipientKeyEnvelopesInTx(tx: Tx, input: Readonly<{
    artifactId: string;
    recipientKeyEnvelopes: readonly ArtifactRecipientKeyEnvelopeInputV1[];
}>): Promise<ArtifactRecipientKeyEnvelopeCommitResponseV1> {
    const appliedRecipientAccountIds: string[] = [];
    const skippedRecipientAccountIds: string[] = [];
    for (const envelope of input.recipientKeyEnvelopes) {
        const account = await tx.account.findUnique({ where: { id: envelope.recipientAccountId }, select: RECIPIENT_READINESS_SELECT });
        const recipientAccess = await resolveArtifactAccessInTx(tx, { artifactId: input.artifactId, actorAccountId: envelope.recipientAccountId });
        const readiness = account ? deriveAccountRecipientEnvelopeReadinessFromRow(account) : null;
        if (!recipientAccess || recipientAccess.level === "owner" || readiness?.status !== "available"
            || readiness.binding.contentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint) {
            skippedRecipientAccountIds.push(envelope.recipientAccountId);
            continue;
        }
        const bytes = privacyKit.decodeBase64(envelope.encryptedDataKey);
        const previous = await tx.artifactKeyEnvelope.findUnique({ where: { artifactId_recipientAccountId: {
            artifactId: input.artifactId, recipientAccountId: envelope.recipientAccountId } },
            select: { recipientContentPublicKeyFingerprint: true } });
        const data = { encryptedDataKey: bytes, recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint,
            ...(envelope.encryptedProvenanceDataKey === undefined
                ? previous && previous.recipientContentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint
                    ? { encryptedProvenanceDataKey: null } : {}
                : { encryptedProvenanceDataKey: privacyKit.decodeBase64(envelope.encryptedProvenanceDataKey) }) };
        await tx.artifactKeyEnvelope.upsert({ where: { artifactId_recipientAccountId: {
            artifactId: input.artifactId, recipientAccountId: envelope.recipientAccountId } },
            create: { artifactId: input.artifactId, recipientAccountId: envelope.recipientAccountId, ...data }, update: data });
        appliedRecipientAccountIds.push(envelope.recipientAccountId);
    }
    await markAccountsChanged(tx, { accountIds: appliedRecipientAccountIds, kind: "artifact", entityId: input.artifactId });
    return { appliedRecipientAccountIds, skippedRecipientAccountIds };
}
