import {
    deriveAccountEncryptionCurrentnessFromRow,
    type AccountEncryptionCurrentness,
    type AccountEncryptionInconsistencyReason,
    type VerifiedAccountContentKeyBinding,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    resolveEffectiveAccountEncryptionModeFromAccountRow,
} from "@/app/encryption/accountEncryptionMode";
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { parseAccountPasswordCredentialV1, type AccountPasswordCredentialV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { isE2eePasswordCredentialBoundToAccount } from "@/app/auth/password/e2eePasswordCredentialAccountBinding";
import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
    type AccountAdmissionIntent,
} from "@/app/encryption/accountSessionOwnerMetadataFence";
import type { Tx } from "@/storage/inTx";
import { publishAccountEncryptionCurrentnessAfterTx } from './accountEncryptionCurrentness';

export type AccountEncryptionTransitionFenceResult =
    | Readonly<{ status: "account_not_found" }>
    | Readonly<{
        status: "account_inconsistent";
        reason: AccountEncryptionInconsistencyReason;
    }>
    | Readonly<{
        status: "ready";
        account: Readonly<{
            version: number;
            publicKey: string | null;
            signingKeyFingerprint: string | null;
            contentKeyFingerprint: string | null;
            settings: string | null;
            settingsVersion: number;
            currentness: Readonly<AccountEncryptionCurrentness>;
        }>;
    }>;

export async function acquireAccountEncryptionTransitionFenceInTx(
    tx: Tx,
    accountId: string,
    intent: AccountAdmissionIntent,
): Promise<AccountEncryptionTransitionFenceResult> {
    try {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId, intent);
    } catch (error) {
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) {
            return { status: "account_not_found" };
        }
        throw error;
    }
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: {
            publicKey: true,
            seq: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
            settings: true,
            settingsVersion: true,
        },
    });
    if (!account) {
        return { status: "account_not_found" };
    }
    const currentness =
        deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status === "inconsistent") {
        return {
            status: "account_inconsistent",
            reason: currentness.reason,
        };
    }

    return {
        status: "ready",
        account: {
            version: account.seq,
            publicKey: account.publicKey,
            ...deriveAccountEncryptionMigrationKeyFingerprints(account),
            settings: account.settings,
            settingsVersion: account.settingsVersion,
            currentness: currentness.currentness,
        },
    };
}

export function deriveAccountEncryptionMigrationKeyFingerprints(
    account: Readonly<{
        publicKey: string | null;
        contentPublicKey: Uint8Array | null;
    }>,
): Readonly<{
    signingKeyFingerprint: string | null;
    contentKeyFingerprint: string | null;
}> {
    const signingPublicKey =
        typeof account.publicKey === "string"
        && account.publicKey.length === 64
        && /^[0-9a-f]+$/iu.test(account.publicKey)
            ? new Uint8Array(Buffer.from(account.publicKey, "hex"))
            : null;
    return {
        signingKeyFingerprint:
            signingPublicKey
                ? computeAccountEncryptionMigrateKeyFingerprintV1(
                    signingPublicKey,
                )
                : null,
        contentKeyFingerprint:
            account.contentPublicKey
                ? computeAccountEncryptionMigrateKeyFingerprintV1(
                    account.contentPublicKey,
                )
                : null,
    };
}

export async function applyAccountEncryptionTransitionInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        expectedVersion: number;
        toMode: "plain" | "e2ee";
        accountPublicKeyHex?: string;
        passwordCredential?: Readonly<{
            expectedRevision: number;
            credential: AccountPasswordCredentialV1;
        }>;
        contentKey:
            | Readonly<{ kind: "preserve" }>
            | Readonly<{
                kind: "migration_replace";
                binding: VerifiedAccountContentKeyBinding;
            }>;
    }>,
): Promise<Readonly<{
    mode: "plain" | "e2ee";
    version: number;
    updatedAt: number;
}>> {
    const source = await tx.account.findUniqueOrThrow({
        where: { id: params.accountId },
        select: { encryptionMode: true, publicKey: true, AccountPasswordCredential: true },
    });
    const sourceMode = resolveEffectiveAccountEncryptionModeFromAccountRow(source);
    if (sourceMode.status === "inconsistent") {
        throw new Error("account_encryption_inconsistent");
    }
    // Every ingress, including the empty-only and staged paths, must leave
    // independently owned resources in the target mode before the Account flips.
    if (await tx.discussion.count({ where: { ownerAccountId: params.accountId, encryptionMode: { not: params.toMode } } }) > 0) {
        throw new Error("discussion_encryption_transition_incomplete");
    }
    const currentCredential = source.AccountPasswordCredential;
    const replacement = params.passwordCredential;
    if (currentCredential) {
        const parsedCurrent = parseAccountPasswordCredentialV1(sourceMode.mode, currentCredential.credential);
        if (!parsedCurrent.ok || (parsedCurrent.mode === "e2ee"
            && !isE2eePasswordCredentialBoundToAccount(parsedCurrent.credential, source.publicKey))) {
            throw new Error("password_credential_inconsistent");
        }
        if (sourceMode.mode !== params.toMode && !replacement) {
            throw new Error("password_credential_transition_required");
        }
    }
    if (replacement) {
        if (!currentCredential || currentCredential.revision !== replacement.expectedRevision) {
            throw new Error("password_credential_revision_conflict");
        }
        const target = parseAccountPasswordCredentialV1(params.toMode, replacement.credential);
        if (!target.ok) throw new Error("password_credential_inconsistent");
        if (target.mode === "e2ee"
            && !isE2eePasswordCredentialBoundToAccount(
                target.credential,
                params.accountPublicKeyHex ?? source.publicKey,
            )) {
            throw new Error("password_credential_signing_key_mismatch");
        }
        const credentialMutation = await tx.accountPasswordCredential.updateMany({
            where: { accountId: params.accountId, revision: replacement.expectedRevision },
            data: { credential: target.credential, revision: { increment: 1 } },
        });
        if (credentialMutation.count !== 1) throw new Error("password_credential_revision_conflict");
    }
    const mutation = await tx.account.updateMany({
        where: {
            id: params.accountId,
            seq: params.expectedVersion,
            status: "active",
        },
        data: {
            encryptionMode: params.toMode,
            encryptionModeUpdatedAt: new Date(),
            updatedAt: new Date(),
            ...(params.accountPublicKeyHex
                ? { publicKey: params.accountPublicKeyHex }
                : {}),
            ...(params.contentKey.kind === "migration_replace"
                ? {
                    contentPublicKey:
                        params.contentKey.binding.contentPublicKey,
                    contentPublicKeySig:
                        params.contentKey.binding
                            .contentPublicKeySignature,
                }
                : {}),
        },
    });
    if (mutation.count !== 1) {
        throw new Error(
            "Account encryption transition lost its Account currentness fence",
        );
    }
    const updated = await tx.account.findUniqueOrThrow({
        where: { id: params.accountId },
        select: {
            seq: true,
            encryptionMode: true,
            encryptionModeUpdatedAt: true,
        },
    });
    const mode =
        resolveEffectiveAccountEncryptionModeFromAccountRow(updated);
    if (mode.status === "inconsistent") {
        throw new Error(
            "Account encryption transition wrote an invalid persisted mode",
        );
    }
    await publishAccountEncryptionCurrentnessAfterTx(tx, params.accountId);
    return {
        mode: mode.mode,
        version: updated.seq,
        updatedAt: updated.encryptionModeUpdatedAt.getTime(),
    };
}
