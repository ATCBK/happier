import { createHash, randomBytes } from "node:crypto";
import { type AccountEncryptionMigrateExternalAuthBindingDigestV1 } from '@happier-dev/protocol/account/encryptionMigrate';
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { isEffectiveHomeAuthMethodActionEnabledInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { findNativePasswordAccount } from "./nativePasswordAuthentication";
import { performDummyPasswordWork } from "./passwordMaterialVerifier";
import { verifyPlainAccountPasswordCredentialV1 } from "./accountPasswordCredentialPreparation";

/** Verify outside locks, then mint the existing first-key pending proof against current Account facts. */
export async function createNativePasswordFirstKeyStepUp(params: Readonly<{
    accountId: string; password: string; requestDigest: AccountEncryptionMigrateExternalAuthBindingDigestV1;
}>) {
    const identity = await db.accountIdentity.findFirst({ where: { accountId: params.accountId, provider: "email" }, select: { providerUserId: true } });
    const candidate = identity ? await findNativePasswordAccount(identity.providerUserId) : null;
    if (!candidate || candidate.account.id !== params.accountId || candidate.parsed.mode !== "plain") {
        await performDummyPasswordWork();
        return null;
    }
    if (!await verifyPlainAccountPasswordCredentialV1(candidate.parsed.credential, params.password)) return null;
    return await inTx(async tx => {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.accountId, "content");
        const current = await findNativePasswordAccount(candidate.normalizedEmail, tx);
        if (!current || current.account.id !== params.accountId || current.account.status !== "active"
            || current.parsed.mode !== "plain" || current.nativeIdentityId !== candidate.nativeIdentityId
            || current.revision !== candidate.revision) return null;
        if (!await isEffectiveHomeAuthMethodActionEnabledInTx(tx, { env: process.env, methodId: "email_password", actionId: "login" })) return null;
        const pending = `oauth_pending_${randomBytes(24).toString("hex")}`;
        const proof = randomBytes(32).toString("hex");
        await tx.repeatKey.create({ data: {
            key: pending, expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            value: JSON.stringify({ v: 3, flow: "auth", purpose: "account_encryption_first_key", provider: "email_password",
                userId: params.accountId, providerUserId: current.normalizedEmail,
                nativeIdentityId: current.nativeIdentityId, credentialRevision: current.revision,
                proofHash: createHash("sha256").update(proof, "utf8").digest("hex"), requestDigest: params.requestDigest }),
        } });
        return { provider: "email_password", pending, proof };
    }, { isolationLevel: "Serializable" /* Native credential proof and current Home login policy must agree when issuing first-key evidence. */ });
}
