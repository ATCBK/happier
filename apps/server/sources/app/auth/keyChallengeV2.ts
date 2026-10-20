import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod/mini";
import { canonicalizeKeyChallengeV2AudienceOrigin, type KeyChallengeV2IssueResponse } from '@happier-dev/protocol/auth/keyChallenge';
import { decodePasswordCredentialFieldV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { createPasswordCredentialMutationDigestV1, createPasswordMutationChallengeSigningInputV1, PasswordMutationChallengeV1Schema, PASSWORD_CREDENTIAL_MUTATION_OPERATION_V1, type PasswordCredentialMutationV1, type PasswordMutationChallengeProofV1, type PasswordMutationChallengeV1 } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';
import { resolveConfiguredCanonicalServerUrl } from "@/app/serverUrls/effectiveServerUrls";
import { getOrCreateServerIdentityId, readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";

const KEY_CHALLENGE_V2_TTL_MS = 5 * 60_000;
const ACCOUNT_DIRECTORY_CHALLENGE_ID_PREFIX = "account_directory:";

export type KeyChallengeV2LoginPurpose = "account" | "account_directory";

export interface IssuedKeyChallengeV2 extends KeyChallengeV2IssueResponse {
    audience: { origin: string; serverIdentityId: string };
}

/** Request hosts and ephemeral ingress origins never establish the proof audience. */
export function resolveStableKeyChallengeV2AudienceOrigin(env: NodeJS.ProcessEnv): string | null {
    return canonicalizeKeyChallengeV2AudienceOrigin(resolveConfiguredCanonicalServerUrl(env));
}

function isChallengeIdForPurpose(challengeId: string, purpose: KeyChallengeV2LoginPurpose): boolean {
    const directory = challengeId.startsWith(ACCOUNT_DIRECTORY_CHALLENGE_ID_PREFIX);
    return purpose === "account_directory" ? directory : !directory;
}

/**
 * The only native method whose verifier runs before the challenge is issued.
 * Widening this is a product decision, not a mechanical one: every value here
 * becomes credential provenance the Team policy owner trusts.
 */
export type KeyChallengeV2VerifiedNativeMethodId = "email_password";
const VERIFIED_NATIVE_PASSWORD_EVIDENCE_PREFIX = "email_password:v1:";

// Native identities are generated CUIDs by AccountIdentityLifecycle (25 characters).
// Together with the maximum credential revision this encodes to 98 characters,
// within the existing MySQL VARCHAR(191) challenge evidence column.
const VerifiedNativePasswordEvidenceV1Schema = z.strictObject({
    nativeIdentityId: z.string().check(z.minLength(1), z.maxLength(256)),
    credentialRevision: z.number().check(z.int(), z.minimum(1), z.maximum(2_147_483_647)),
});
export type VerifiedNativePasswordEvidenceV1 = z.infer<typeof VerifiedNativePasswordEvidenceV1Schema>;

export function encodeVerifiedNativePasswordEvidenceV1(evidence: VerifiedNativePasswordEvidenceV1): string {
    return `${VERIFIED_NATIVE_PASSWORD_EVIDENCE_PREFIX}${JSON.stringify(VerifiedNativePasswordEvidenceV1Schema.parse(evidence))}`;
}

export function decodeVerifiedNativePasswordEvidenceV1(value: string | null): VerifiedNativePasswordEvidenceV1 | null {
    if (!value?.startsWith(VERIFIED_NATIVE_PASSWORD_EVIDENCE_PREFIX)) return null;
    try {
        const parsed = VerifiedNativePasswordEvidenceV1Schema.safeParse(JSON.parse(value.slice(VERIFIED_NATIVE_PASSWORD_EVIDENCE_PREFIX.length)));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Issues the incumbent five-minute challenge through its sole persistence owner. */
export async function issueKeyChallengeV2(params: Readonly<{
    purpose: KeyChallengeV2LoginPurpose;
    expectedAccountId?: string;
    env: NodeJS.ProcessEnv;
    passwordMutation?: PasswordCredentialMutationV1;
    /**
     * Set only by a server-side verifier that has already proven this exact
     * Account's native factor. It is never derived from request input.
     */
    verifiedNativeMethodId?: KeyChallengeV2VerifiedNativeMethodId;
    verifiedNativePasswordEvidence?: VerifiedNativePasswordEvidenceV1;
    /** Keep verified-factor issuance in the caller's Account-fenced transaction. */
    writer?: Pick<Tx, "keyChallengeV2" | "simpleCache">;
}>): Promise<IssuedKeyChallengeV2 | null> {
    if (params.passwordMutation && (params.purpose !== "account"
        || params.expectedAccountId !== params.passwordMutation.accountId)) {
        throw new Error("Password mutation challenge Account/purpose mismatch");
    }
    if ((params.verifiedNativeMethodId || params.verifiedNativePasswordEvidence !== undefined)
        && (params.purpose !== "account" || !params.expectedAccountId || params.passwordMutation)) {
        // Native evidence only makes sense on an ordinary Account-bound login
        // challenge. A mutation challenge mints no token, and a challenge with
        // no expected Account could be redeemed for a different one.
        throw new Error("Verified native method evidence requires an Account-bound login challenge");
    }
    if (params.verifiedNativeMethodId === "email_password"
        && params.verifiedNativePasswordEvidence === undefined) {
        throw new Error("Verified native password evidence requires its identity lifetime and credential revision");
    }
    const audienceOrigin = resolveStableKeyChallengeV2AudienceOrigin(params.env);
    if (!audienceOrigin) return null;
    const issuedAt = new Date();
    const writer = params.writer ?? db;
    await writer.keyChallengeV2.deleteMany({ where: { expiresAt: { lte: issuedAt } } }).catch(() => {
        // Expiry reclamation is opportunistic; issuance survives a cleanup race.
    });
    const audienceServerIdentityId = params.writer
        ? await readCurrentServerIdentityId(params.env, params.writer)
        : await getOrCreateServerIdentityId(params.env);
    if (!audienceServerIdentityId) return null;
    const challenge = await writer.keyChallengeV2.create({
        data: {
            ...(params.purpose === "account_directory"
                ? { id: `${ACCOUNT_DIRECTORY_CHALLENGE_ID_PREFIX}${randomUUID()}` } : {}),
            nonce: privacyKit.encodeBase64(new Uint8Array(randomBytes(32))),
            issuedAt,
            expiresAt: new Date(issuedAt.getTime() + KEY_CHALLENGE_V2_TTL_MS),
            audienceOrigin,
            audienceServerIdentityId,
            expectedAccountId: params.expectedAccountId ?? null,
            operationKind: params.passwordMutation ? PASSWORD_CREDENTIAL_MUTATION_OPERATION_V1 : null,
            operationDigest: params.passwordMutation
                ? createPasswordCredentialMutationDigestV1(params.passwordMutation) : null,
            verifiedNativeMethodId: params.verifiedNativeMethodId === "email_password"
                ? encodeVerifiedNativePasswordEvidenceV1(params.verifiedNativePasswordEvidence!)
                : null,
        },
    });
    if (!challenge.audienceServerIdentityId) return null;
    return {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt.toISOString(),
        expiresAt: challenge.expiresAt.toISOString(),
        audience: {
            origin: challenge.audienceOrigin,
            serverIdentityId: challenge.audienceServerIdentityId,
        },
    };
}

/** Loads only the exact current operation, Home and Account-bound challenge. */
async function readCurrentKeyChallengeV2(reader: Pick<Tx, "keyChallengeV2" | "simpleCache">, params: Readonly<{
    challengeId: string;
    expectedAccountId?: string;
    purpose: KeyChallengeV2LoginPurpose;
    env: NodeJS.ProcessEnv;
    operationDigest?: string;
}>) {
    if (!isChallengeIdForPurpose(params.challengeId, params.purpose)) return null;
    const challenge = await reader.keyChallengeV2.findUnique({ where: { id: params.challengeId } });
    const configuredAudienceOrigin = resolveStableKeyChallengeV2AudienceOrigin(params.env);
    const currentServerIdentityId = configuredAudienceOrigin
        ? await readCurrentServerIdentityId(params.env, reader) : null;
    if (!challenge
        || challenge.consumedAt
        || challenge.operationKind !== (params.operationDigest ? PASSWORD_CREDENTIAL_MUTATION_OPERATION_V1 : null)
        || challenge.operationDigest !== (params.operationDigest ?? null)
        || challenge.expiresAt.getTime() <= Date.now()
        || !configuredAudienceOrigin
        || challenge.audienceOrigin !== configuredAudienceOrigin
        || !currentServerIdentityId
        || challenge.audienceServerIdentityId !== currentServerIdentityId
        || (challenge.expectedAccountId ?? undefined) !== params.expectedAccountId
    ) return null;
    return { ...challenge, audienceServerIdentityId: currentServerIdentityId };
}

export function readKeyChallengeV2ForLogin(params: Readonly<{
    challengeId: string;
    expectedAccountId?: string;
    purpose: KeyChallengeV2LoginPurpose;
    env: NodeJS.ProcessEnv;
}>) {
    return readCurrentKeyChallengeV2(db, params);
}

/** A guarded claim rejects replays and purpose substitution even after the read. */
async function consumeKeyChallengeV2(
    reader: Pick<Tx, "keyChallengeV2">,
    challengeId: string,
    operationDigest: string | null,
): Promise<boolean> {
    const now = new Date();
    const result = await reader.keyChallengeV2.updateMany({
        where: {
            id: challengeId,
            consumedAt: null,
            operationKind: operationDigest ? PASSWORD_CREDENTIAL_MUTATION_OPERATION_V1 : null,
            operationDigest,
            expiresAt: { gt: now },
        },
        data: { consumedAt: now },
    });
    return result.count === 1;
}

export function consumeLoginKeyChallengeV2(reader: Pick<Tx, "keyChallengeV2">, challengeId: string): Promise<boolean> {
    return consumeKeyChallengeV2(reader, challengeId, null);
}

/** Issues a password-only proof over the same challenge row, with no login authority. */
export async function issuePasswordMutationKeyChallengeV1(params: Readonly<{
    mutation: PasswordCredentialMutationV1;
    env: NodeJS.ProcessEnv;
}>): Promise<PasswordMutationChallengeV1 | null> {
    const challenge = await issueKeyChallengeV2({
        purpose: "account",
        expectedAccountId: params.mutation.accountId,
        passwordMutation: params.mutation,
        env: params.env,
    });
    return challenge ? PasswordMutationChallengeV1Schema.parse({
        ...challenge,
        v: 1,
        expectedAccountId: params.mutation.accountId,
        operationKind: PASSWORD_CREDENTIAL_MUTATION_OPERATION_V1,
        operationDigest: createPasswordCredentialMutationDigestV1(params.mutation),
    }) : null;
}

/**
 * Verifies and claims only the exact password mutation in its caller's Account-fenced
 * transaction. The caller must commit the revision-conditional credential write in
 * this same transaction, or throw so proof consumption rolls back with it.
 */
export async function consumePasswordMutationKeyChallengeInTx(tx: Tx, params: Readonly<{
    mutation: PasswordCredentialMutationV1;
    proof: PasswordMutationChallengeProofV1;
    env: NodeJS.ProcessEnv;
}>): Promise<boolean> {
    const operationDigest = createPasswordCredentialMutationDigestV1(params.mutation);
    const challenge = await readCurrentKeyChallengeV2(tx, {
        challengeId: params.proof.challengeId,
        expectedAccountId: params.mutation.accountId,
        purpose: "account",
        operationDigest,
        env: params.env,
    });
    if (!challenge) return false;
    const account = await tx.account.findUnique({
        where: { id: params.mutation.accountId },
        select: { publicKey: true, encryptionMode: true, status: true },
    });
    if (!account?.publicKey || account.encryptionMode !== "e2ee") return false;
    let publicKey: Uint8Array;
    let signature: Uint8Array;
    try {
        publicKey = decodePasswordCredentialFieldV1(params.proof.publicKey);
        signature = decodePasswordCredentialFieldV1(params.proof.signature);
    } catch {
        return false;
    }
    if (publicKey.length !== 32 || signature.length !== 64
        || privacyKit.encodeHex(new Uint8Array(publicKey)) !== account.publicKey) return false;
    const signingInput = createPasswordMutationChallengeSigningInputV1({
        v: 1,
        challengeId: challenge.id,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt.toISOString(),
        expiresAt: challenge.expiresAt.toISOString(),
        audience: { origin: challenge.audienceOrigin, serverIdentityId: challenge.audienceServerIdentityId },
        expectedAccountId: params.mutation.accountId,
        operationKind: PASSWORD_CREDENTIAL_MUTATION_OPERATION_V1,
        operationDigest,
    });
    if (!await verifyKeyChallengeSignature(signingInput, signature, publicKey)) return false;
    if (!isActiveHomeAccountStatus(account.status)) return false;
    return consumeKeyChallengeV2(tx, challenge.id, operationDigest);
}

/** One Ed25519 verification boundary serves incumbent login and password proofs. */
export async function verifyKeyChallengeSignature(
    signingInput: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
): Promise<boolean> {
    if (signature.length !== tweetnacl.sign.signatureLength || publicKey.length !== tweetnacl.sign.publicKeyLength) return false;
    return tweetnacl.sign.detached.verify(signingInput, signature, publicKey);
}
