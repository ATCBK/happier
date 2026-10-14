import { createHash, timingSafeEqual } from "node:crypto";
import type { AccountEncryptionMigrateExternalAuthBindingDigestV1 } from '@happier-dev/protocol/account/encryptionMigrate';

import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import {
    accountEncryptionFirstKeyStepUpPendingSchema,
    accountPasswordEnrollmentStepUpPendingSchema,
    authPendingSchema,
    hasInvalidOAuthSecurityBinding,
} from "./oauthExternal/oauthExternalSchemas";
import { resolveOAuthSecurityBindingInTx } from "./oauthExternal/oauthSecurityBinding";
import { findNativePasswordAccount } from "@/app/auth/password/nativePasswordAuthentication";
import { isEffectiveHomeAuthMethodActionEnabledInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";

function isSafeOAuthPendingKey(key: string): boolean {
    const pendingKey = key.toString().trim();
    if (!pendingKey) return false;
    // Bound key shape to avoid accidental deletes/reads of unrelated repeatKey entries.
    // Pending keys are generated server-side as `oauth_pending_${randomKeyNaked(24)}`.
    return /^oauth_pending_[A-Za-z0-9]{8,128}$/.test(pendingKey);
}

export async function deleteOAuthPendingBestEffort(key: string): Promise<void> {
    const pendingKey = key.toString().trim();
    if (!isSafeOAuthPendingKey(pendingKey)) return;
    await db.repeatKey.delete({ where: { key: pendingKey } }).catch(() => {});
}

export async function loadValidOAuthPending(key: string): Promise<{ key: string; value: string } | null> {
    const pendingKey = key.toString().trim();
    if (!isSafeOAuthPendingKey(pendingKey)) return null;

    const pending = await db.repeatKey.findUnique({ where: { key: pendingKey } });
    if (!pending) return null;
    if (pending.expiresAt.getTime() <= Date.now()) {
        await deleteOAuthPendingBestEffort(pendingKey);
        return null;
    }

    return { key: pending.key, value: pending.value };
}

/**
 * Resolve the existing server-authored pending reference that an ordinary
 * fresh-Account mailbox verification may resume. Purpose-qualified pending
 * records (Team admission, Account Directory, password enrollment, and other
 * step-up flows) retain their own consumers and cannot be relabelled as a
 * fresh-Account continuation.
 */
export async function loadValidFreshAccountAuthContinuation(
    key: string,
): Promise<{ key: string; value: string } | null> {
    const pending = await loadValidOAuthPending(key);
    if (!pending) return null;
    let decoded: unknown;
    try {
        decoded = JSON.parse(pending.value);
    } catch {
        return null;
    }
    const parsed = authPendingSchema.safeParse(decoded);
    if (!parsed.success) return null;
    if ("purpose" in parsed.data && parsed.data.purpose !== undefined) return null;
    if (parsed.data.securityBinding?.purpose !== null
        && parsed.data.securityBinding?.purpose !== undefined) return null;
    return pending;
}

export async function consumeValidOAuthPendingInTx(
    tx: Tx,
    pending: Readonly<{ key: string; value: string }>,
): Promise<boolean> {
    if (!isSafeOAuthPendingKey(pending.key)) return false;
    const consumed = await tx.repeatKey.deleteMany({
        where: {
            key: pending.key,
            value: pending.value,
            expiresAt: { gt: new Date() },
        },
    });
    return consumed.count === 1;
}

export type AccountEncryptionFirstKeyStepUpConsumeResult =
    | Readonly<{
        ok: true;
        provider: string;
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
    }>;

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

async function consumePurposeBoundStepUpPendingInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        provider: string;
        pending: string;
        proof: string;
        requestDigest: string;
    }>,
    purpose: "account_encryption_first_key" | "account_password_enrollment",
): Promise<AccountEncryptionFirstKeyStepUpConsumeResult> {
    const pending = params.pending.toString().trim();
    if (!isSafeOAuthPendingKey(pending)) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const row = await tx.repeatKey.findUnique({
        where: { key: pending },
        select: { value: true, expiresAt: true },
    });
    if (!row) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const now = new Date();
    if (row.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: "expired" };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(row.value);
    } catch {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const proof = purpose === "account_encryption_first_key"
        ? accountEncryptionFirstKeyStepUpPendingSchema.safeParse(parsed)
        : accountPasswordEnrollmentStepUpPendingSchema.safeParse(parsed);
    if (!proof.success) {
        if (hasInvalidOAuthSecurityBinding(parsed)) {
            await tx.repeatKey.deleteMany({ where: { key: pending, value: row.value } });
            return { ok: false, reason: "configuration_changed" };
        }
        return { ok: false, reason: "invalid_or_consumed" };
    }
    if (
        proof.data.userId !== params.accountId
        || proof.data.provider !== params.provider
        || proof.data.requestDigest !== params.requestDigest
        || !proofHashMatches(params.proof, proof.data.proofHash)
    ) {
        return { ok: false, reason: "binding_mismatch" };
    }
    if (proof.data.provider === "email_password") {
        if (purpose !== "account_encryption_first_key" || !("credentialRevision" in proof.data) || !("nativeIdentityId" in proof.data)) {
            return { ok: false, reason: "binding_mismatch" };
        }
        const current = await findNativePasswordAccount(proof.data.providerUserId, tx);
        if (!current || current.account.id !== params.accountId || current.account.status !== "active"
            || current.parsed.mode !== "plain" || current.nativeIdentityId !== proof.data.nativeIdentityId
            || current.revision !== proof.data.credentialRevision) {
            return { ok: false, reason: "identity_mismatch" };
        }
        if (!await isEffectiveHomeAuthMethodActionEnabledInTx(tx, { env: process.env, methodId: "email_password", actionId: "login" })) {
            return { ok: false, reason: "configuration_changed" };
        }
    } else if (!await resolveOAuthSecurityBindingInTx(tx, {
        env: process.env,
        providerId: params.provider,
        binding: proof.data.securityBinding,
        purpose,
        stage: "oauth_finalize",
    })) {
        await tx.repeatKey.deleteMany({ where: { key: pending, value: row.value } });
        return { ok: false, reason: "configuration_changed" };
    }
    const identity = await tx.accountIdentity.findFirst({
        where: {
            accountId: params.accountId,
            provider: proof.data.provider === "email_password" ? "email" : proof.data.provider,
            providerUserId: proof.data.providerUserId,
        },
        select: { id: true },
    });
    if (!identity) {
        return { ok: false, reason: "identity_mismatch" };
    }
    const deleted = await tx.repeatKey.deleteMany({
        where: {
            key: pending,
            expiresAt: { gt: now },
        },
    });
    if (deleted.count !== 1) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    return {
        ok: true,
        provider: proof.data.provider,
        providerUserId: proof.data.providerUserId,
    };
}

export async function consumeAccountEncryptionFirstKeyStepUpPendingInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        provider: string;
        pending: string;
        proof: string;
        requestDigest: AccountEncryptionMigrateExternalAuthBindingDigestV1;
    }>,
): Promise<AccountEncryptionFirstKeyStepUpConsumeResult> {
    return await consumePurposeBoundStepUpPendingInTx(tx, params, "account_encryption_first_key");
}

export async function consumeAccountPasswordEnrollmentStepUpPendingInTx(
    tx: Tx,
    params: Readonly<{ accountId: string; provider: string; pending: string; proof: string; requestDigest: string }>,
): Promise<AccountEncryptionFirstKeyStepUpConsumeResult> {
    return await consumePurposeBoundStepUpPendingInTx(tx, params, "account_password_enrollment");
}
