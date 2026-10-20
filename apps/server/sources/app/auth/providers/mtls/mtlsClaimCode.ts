import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod/mini";
import { AccountEncryptionMigrateExternalAuthBindingDigestV1Schema, type AccountEncryptionMigrateExternalAuthBindingDigestV1 } from '@happier-dev/protocol/account/encryptionMigrate';
import { PasswordCredentialMutationDigestV1Schema } from '@happier-dev/protocol/auth/passwordMutationChallenge';

import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { readAuthMtlsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";

const MTLS_CLAIM_CODE_PREFIX = "mtls_claim_";
const MtlsSecurityBindingSchema = z.string().check(z.regex(/^[0-9a-f]{64}$/));

const MtlsTeamInvitationReferenceSchema = z.strictObject({
    invitationId: z.string().check(z.minLength(1)),
    tokenHash: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
    teamId: z.string().check(z.minLength(1)),
});

const MtlsTeamHandoffSchema = z.strictObject({
    purpose: z.literal("native_team_handoff"),
    stage: z.enum(["prepared", "browser_started"]),
    returnTo: z.string().check(z.minLength(1)),
    teamId: z.string().check(z.minLength(1)),
    securityBinding: MtlsSecurityBindingSchema,
    invitation: z.optional(MtlsTeamInvitationReferenceSchema),
});

const MtlsIdentityClaimSchema = z.strictObject({
    providerUserId: z.string().check(z.minLength(1)),
    providerLogin: z.nullable(z.string().check(z.minLength(1))),
    profile: z.strictObject({
        email: z.nullable(z.string()),
        upn: z.nullable(z.string()),
        subject: z.nullable(z.string()),
        fingerprint: z.nullable(z.string()),
        issuer: z.nullable(z.string()),
    }),
});

const MtlsAuthenticationClaimSchema = z.strictObject({
    purpose: z.literal("native_authentication_claim"),
    identity: MtlsIdentityClaimSchema,
    securityBinding: MtlsSecurityBindingSchema,
    team: z.optional(z.strictObject({
        teamId: z.string().check(z.minLength(1)),
        admissionReference: z.string().check(z.minLength(1)),
        invitation: z.optional(MtlsTeamInvitationReferenceSchema),
    })),
});

export type MtlsTeamInvitationReference = z.infer<typeof MtlsTeamInvitationReferenceSchema>;
export type MtlsTeamHandoff = Readonly<{
    returnTo: string;
    teamId: string;
    invitation?: MtlsTeamInvitationReference;
}>;
export type MtlsAuthenticationClaim = z.infer<typeof MtlsAuthenticationClaimSchema>;
export type AcquiredMtlsAuthenticationClaim = Readonly<{
    key: string;
    value: string;
    claim: MtlsAuthenticationClaim;
}>;

function resolveMtlsSecurityBinding(env: NodeJS.ProcessEnv): string {
    const policy = readAuthMtlsFeatureEnv(env);
    const canonicalSet = (values: readonly string[]) =>
        [...new Set(values)].sort();
    return createHash("sha256")
        .update(JSON.stringify({
            enabled: policy.enabled,
            mode: policy.mode,
            trustForwardedHeaders: policy.trustForwardedHeaders,
            identitySource: policy.identitySource,
            allowedEmailDomains: canonicalSet(policy.allowedEmailDomains),
            allowedIssuers: canonicalSet(policy.allowedIssuers),
            forwardedEmailHeader: policy.forwardedEmailHeader,
            forwardedUpnHeader: policy.forwardedUpnHeader,
            forwardedSubjectHeader: policy.forwardedSubjectHeader,
            forwardedFingerprintHeader: policy.forwardedFingerprintHeader,
            forwardedIssuerHeader: policy.forwardedIssuerHeader,
        }), "utf8")
        .digest("hex");
}

const MtlsFirstKeyStepUpClaimSchema = z.strictObject({
        userId: z.string().check(z.minLength(1)),
        purpose:
            z.literal("account_encryption_first_key"),
        providerUserId: z.string().check(z.minLength(1)),
        proofHash: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
        securityBinding: MtlsSecurityBindingSchema,
        requestDigest:
            AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
    });

const MtlsPasswordEnrollmentStepUpClaimSchema = z.strictObject({
    userId: z.string().check(z.minLength(1)),
    purpose: z.literal("account_password_enrollment"),
    providerUserId: z.string().check(z.minLength(1)),
    proofHash: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
    securityBinding: MtlsSecurityBindingSchema,
    requestDigest: PasswordCredentialMutationDigestV1Schema,
});

async function createMtlsClaimCodeWithStore(store: Pick<Tx, "repeatKey">, params: {
    userId: string;
    ttlMs: number;
    stepUp: Readonly<{
        purpose: "account_encryption_first_key" | "account_password_enrollment";
        providerUserId: string;
        proofHash: string;
        requestDigest: string;
    }>;
}): Promise<string> {
    const ttlMs =
        Number.isFinite(params.ttlMs) && params.ttlMs > 0
            ? params.ttlMs
            : 60_000;
    for (let i = 0; i < 3; i++) {
        const code = randomKeyNaked(32);
        const key = `${MTLS_CLAIM_CODE_PREFIX}${code}`;
        try {
            await store.repeatKey.create({
                data: {
                    key,
                    value: JSON.stringify({
                        userId: params.userId,
                        ...params.stepUp,
                        securityBinding: resolveMtlsSecurityBinding(process.env),
                    }),
                    expiresAt: new Date(Date.now() + ttlMs),
                },
            });
            return code;
        } catch {
            // Retry the existing claim allocation on a rare key collision.
        }
    }
    throw new Error("mtls-claim-code-unavailable");
}

export async function createMtlsClaimCode(params: {
    userId: string;
    ttlMs: number;
    stepUp: Readonly<{
        purpose: "account_encryption_first_key" | "account_password_enrollment";
        providerUserId: string;
        proofHash: string;
        requestDigest: string;
    }>;
}): Promise<string> {
    return await createMtlsClaimCodeWithStore(db, params);
}

async function createMtlsAuthenticationClaimCodeWithStore(
    store: Pick<Tx, "repeatKey">,
    params: Readonly<{
        identity: MtlsAuthenticationClaim["identity"];
        ttlMs: number;
        team?: NonNullable<MtlsAuthenticationClaim["team"]>;
    }>,
): Promise<string> {
    const ttlMs = Number.isFinite(params.ttlMs) && params.ttlMs > 0 ? params.ttlMs : 60_000;
    const value = JSON.stringify(MtlsAuthenticationClaimSchema.parse({
        purpose: "native_authentication_claim",
        identity: params.identity,
        securityBinding: resolveMtlsSecurityBinding(process.env),
        ...(params.team ? { team: params.team } : {}),
    }));
    for (let i = 0; i < 3; i++) {
        const code = randomKeyNaked(32);
        try {
            await store.repeatKey.create({
                data: {
                    key: `${MTLS_CLAIM_CODE_PREFIX}${code}`,
                    value,
                    expiresAt: new Date(Date.now() + ttlMs),
                },
            });
            return code;
        } catch {
            // Retry the existing RepeatKey allocation on a rare collision.
        }
    }
    throw new Error("mtls-claim-code-unavailable");
}

export async function createMtlsAuthenticationClaimCode(params: Parameters<typeof createMtlsAuthenticationClaimCodeWithStore>[1]): Promise<string> {
    return await createMtlsAuthenticationClaimCodeWithStore(db, params);
}

export async function createMtlsTeamHandoff(params: MtlsTeamHandoff & { ttlMs: number }): Promise<string> {
    const ttlMs = Number.isFinite(params.ttlMs) && params.ttlMs > 0 ? params.ttlMs : 60_000;
    for (let i = 0; i < 3; i++) {
        const reference = randomKeyNaked(32);
        try {
            await db.repeatKey.create({
                data: {
                    key: `${MTLS_CLAIM_CODE_PREFIX}${reference}`,
                    value: JSON.stringify({
                        purpose: "native_team_handoff",
                        stage: "prepared",
                        returnTo: params.returnTo,
                        teamId: params.teamId,
                        securityBinding: resolveMtlsSecurityBinding(process.env),
                        ...(params.invitation ? { invitation: params.invitation } : {}),
                    }),
                    expiresAt: new Date(Date.now() + ttlMs),
                },
            });
            return reference;
        } catch {
            // Retry the existing RepeatKey allocation on a rare collision.
        }
    }
    throw new Error("mtls-team-handoff-unavailable");
}

export async function beginMtlsTeamHandoff(params: { admissionReference: string; returnTo: string }): Promise<boolean> {
    const key = `${MTLS_CLAIM_CODE_PREFIX}${params.admissionReference.trim()}`;
    return await inTx(async (tx) => {
        const row = await tx.repeatKey.findUnique({ where: { key }, select: { value: true, expiresAt: true } });
        if (!row || row.expiresAt.getTime() <= Date.now()) return false;
        const parsed = (() => {
            try { return MtlsTeamHandoffSchema.safeParse(JSON.parse(row.value)); } catch { return null; }
        })();
        if (!parsed?.success
            || parsed.data.stage !== "prepared"
            || parsed.data.returnTo !== params.returnTo
            || parsed.data.securityBinding !== resolveMtlsSecurityBinding(process.env)) return false;
        const updated = await tx.repeatKey.updateMany({
            where: { key, value: row.value, expiresAt: { gt: new Date() } },
            data: { value: JSON.stringify({ ...parsed.data, stage: "browser_started" }) },
        });
        return updated.count === 1;
    });
}

export async function completeMtlsTeamHandoffInTx(
    tx: Tx,
    params: {
        admissionReference: string;
        returnTo: string;
        identity: MtlsAuthenticationClaim["identity"];
    },
): Promise<{ code: string; teamId: string } | null> {
    const key = `${MTLS_CLAIM_CODE_PREFIX}${params.admissionReference.trim()}`;
    const row = await tx.repeatKey.findUnique({ where: { key }, select: { value: true, expiresAt: true } });
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    const parsed = (() => {
        try { return MtlsTeamHandoffSchema.safeParse(JSON.parse(row.value)); } catch { return null; }
    })();
    if (!parsed?.success
        || parsed.data.stage !== "browser_started"
        || parsed.data.returnTo !== params.returnTo
        || parsed.data.securityBinding !== resolveMtlsSecurityBinding(process.env)) return null;
    const claimValue = JSON.stringify(MtlsAuthenticationClaimSchema.parse({
        purpose: "native_authentication_claim",
        identity: params.identity,
        securityBinding: resolveMtlsSecurityBinding(process.env),
        team: {
            teamId: parsed.data.teamId,
            admissionReference: params.admissionReference.trim(),
            ...(parsed.data.invitation ? { invitation: parsed.data.invitation } : {}),
        },
    }));
    const updated = await tx.repeatKey.updateMany({
        where: { key, value: row.value, expiresAt: { gt: new Date() } },
        data: { value: claimValue },
    });
    if (updated.count !== 1) return null;
    return { code: params.admissionReference.trim(), teamId: parsed.data.teamId };
}

/**
 * Acquire an exact certificate-authentication claim without consuming it.
 * The caller must consume or transition the returned row in the same transaction
 * as the successful authentication outcome; throwing rolls the claim back intact.
 */
export async function acquireMtlsAuthenticationClaimInTx(
    tx: Tx,
    params: Readonly<{ code: string; admissionReference?: string }>,
): Promise<AcquiredMtlsAuthenticationClaim | null> {
    const code = params.code.toString().trim();
    if (!code) return null;
    const key = `${MTLS_CLAIM_CODE_PREFIX}${code}`;
    const row = await tx.repeatKey.findUnique({
        where: { key },
        select: { value: true, expiresAt: true },
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    let decoded: unknown;
    try {
        decoded = JSON.parse(row.value);
    } catch {
        return null;
    }
    const parsed = MtlsAuthenticationClaimSchema.safeParse(decoded);
    if (!parsed.success
        || parsed.data.securityBinding !== resolveMtlsSecurityBinding(process.env)) return null;
    const team = parsed.data.team;
    if ((team?.admissionReference ?? undefined) !== params.admissionReference) return null;
    return { key, value: row.value, claim: parsed.data };
}

export async function consumeAcquiredMtlsAuthenticationClaimInTx(
    tx: Tx,
    acquired: AcquiredMtlsAuthenticationClaim,
): Promise<boolean> {
    const deleted = await tx.repeatKey.deleteMany({
        where: {
            key: acquired.key,
            value: acquired.value,
            expiresAt: { gt: new Date() },
        },
    });
    return deleted.count === 1;
}

function proofHashMatches(
    proof: string,
    expectedHex: string,
): boolean {
    const actual = createHash("sha256")
        .update(proof, "utf8")
        .digest();
    const expected = Buffer.from(expectedHex, "hex");
    return expected.length === actual.length
        && timingSafeEqual(actual, expected);
}

async function consumeMtlsPurposeBoundStepUpClaimInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        pending: string;
        proof: string;
        requestDigest: string;
        methodCurrent: boolean;
    }>,
    purpose: "account_encryption_first_key" | "account_password_enrollment",
): Promise<
    | Readonly<{
        ok: true;
        provider: "mtls";
        providerUserId: string;
    }>
    | Readonly<{
        ok: false;
        reason:
            | "invalid_or_consumed"
            | "expired"
            | "binding_mismatch"
            | "configuration_changed"
            | "identity_mismatch";
    }>
> {
    const pending = params.pending.toString().trim();
    if (!/^[A-Za-z0-9]{8,128}$/.test(pending)) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const key = `${MTLS_CLAIM_CODE_PREFIX}${pending}`;
    const row = await tx.repeatKey.findUnique({
        where: { key },
        select: { value: true, expiresAt: true },
    });
    if (!row) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const now = new Date();
    if (row.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: "expired" };
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(row.value);
    } catch {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const claim = purpose === "account_encryption_first_key"
        ? MtlsFirstKeyStepUpClaimSchema.safeParse(decoded)
        : MtlsPasswordEnrollmentStepUpClaimSchema.safeParse(decoded);
    if (!claim.success) {
        if (
            typeof decoded === "object"
            && decoded !== null
            && "purpose" in decoded
            && decoded.purpose === purpose
            && (!("securityBinding" in decoded)
                || !MtlsSecurityBindingSchema.safeParse(
                    decoded.securityBinding,
                ).success)
        ) {
            await tx.repeatKey.deleteMany({
                where: { key, value: row.value },
            });
            return { ok: false, reason: "configuration_changed" };
        }
        return { ok: false, reason: "invalid_or_consumed" };
    }
    if (
        claim.data.userId !== params.accountId
        || claim.data.requestDigest !== params.requestDigest
        || !proofHashMatches(params.proof, claim.data.proofHash)
    ) {
        return { ok: false, reason: "binding_mismatch" };
    }
    if (
        !params.methodCurrent
        || claim.data.securityBinding
            !== resolveMtlsSecurityBinding(process.env)
    ) {
        await tx.repeatKey.deleteMany({
            where: { key, value: row.value },
        });
        return { ok: false, reason: "configuration_changed" };
    }
    const identity = await tx.accountIdentity.findFirst({
        where: {
            accountId: params.accountId,
            provider: "mtls",
            providerUserId: claim.data.providerUserId,
        },
        select: { id: true },
    });
    if (!identity) {
        return { ok: false, reason: "identity_mismatch" };
    }
    const deleted = await tx.repeatKey.deleteMany({
        where: {
            key,
            expiresAt: { gt: now },
        },
    });
    if (deleted.count !== 1) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    return {
        ok: true,
        provider: "mtls",
        providerUserId: claim.data.providerUserId,
    };
}

export async function consumeMtlsFirstKeyStepUpClaimInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        pending: string;
        proof: string;
        requestDigest: AccountEncryptionMigrateExternalAuthBindingDigestV1;
        methodCurrent: boolean;
    }>,
) {
    return await consumeMtlsPurposeBoundStepUpClaimInTx(tx, params, "account_encryption_first_key");
}

export async function consumeMtlsPasswordEnrollmentStepUpClaimInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        pending: string;
        proof: string;
        requestDigest: string;
        methodCurrent: boolean;
    }>,
) {
    return await consumeMtlsPurposeBoundStepUpClaimInTx(tx, params, "account_password_enrollment");
}
