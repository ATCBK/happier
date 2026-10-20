import { timingSafeEqual } from "node:crypto";

import { verifyAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { type ContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import tweetnacl from "tweetnacl";

import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import type { Tx } from "@/storage/inTx";
import { publishAccountEncryptionCurrentnessAfterTx } from './accountEncryptionCurrentness';
import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} from "./accountSessionOwnerMetadataFence";

type AccountContentKeyClient = Tx;

export type VerifiedAccountContentKeyBinding = Readonly<{
    contentPublicKey: Uint8Array<ArrayBuffer>;
    contentPublicKeySignature: Uint8Array<ArrayBuffer>;
    contentPublicKeyFingerprint: ContentPublicKeyFingerprint;
}>;

export type AccountContentKeyAdmissionResult =
    | Readonly<{
        status: "initialized" | "unchanged" | "signature_filled";
        binding: VerifiedAccountContentKeyBinding;
    }>
    | Readonly<{
        status: "account_not_found" | "invalid_binding" | "key_mismatch";
    }>;

export type AccountEncryptionCurrentness = Readonly<{
    encryptionMode: "plain" | "e2ee";
    contentPublicKey: Uint8Array<ArrayBuffer> | null;
    contentPublicKeySignature: Uint8Array<ArrayBuffer> | null;
    contentPublicKeyFingerprint: ContentPublicKeyFingerprint | null;
}>;

export type AccountEncryptionInconsistencyReason =
    | "invalid_encryption_mode"
    | "missing_or_invalid_signing_key"
    | "missing_content_key_binding"
    | "invalid_content_key_binding";

export type AccountEncryptionCurrentnessResult =
    | Readonly<{
        status: "ready";
        currentness: Readonly<AccountEncryptionCurrentness>;
    }>
    | Readonly<{
        status: "inconsistent";
        reason: AccountEncryptionInconsistencyReason;
    }>;

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function bytesEqual(
    left: Uint8Array | null,
    right: Uint8Array | null,
): boolean {
    if (left === null || right === null) return left === right;
    if (left.byteLength !== right.byteLength) return false;
    return timingSafeEqual(
        Buffer.from(left.buffer, left.byteOffset, left.byteLength),
        Buffer.from(right.buffer, right.byteOffset, right.byteLength),
    );
}

function decodeAccountSigningPublicKey(
    publicKeyHex: string | null,
): Uint8Array<ArrayBuffer> | null {
    if (
        typeof publicKeyHex !== "string"
        || publicKeyHex.length !== tweetnacl.sign.publicKeyLength * 2
        || !/^[0-9a-f]+$/iu.test(publicKeyHex)
    ) {
        return null;
    }
    return copyBytes(Buffer.from(publicKeyHex, "hex"));
}

// Repeated admissions often carry the same public proof. Keep only the last
// successful tuple, with owned bytes: its cryptographic relationship cannot
// expire, while Account mode, current binding and access remain fresh decisions
// at their existing owners. A different tuple still uses the Protocol verifier.
let lastVerifiedBinding: Readonly<{
    accountSigningPublicKey: Uint8Array;
    binding: VerifiedAccountContentKeyBinding;
}> | null = null;

function copyVerifiedBinding(binding: VerifiedAccountContentKeyBinding): VerifiedAccountContentKeyBinding {
    return {
        contentPublicKey: copyBytes(binding.contentPublicKey),
        contentPublicKeySignature: copyBytes(binding.contentPublicKeySignature),
        contentPublicKeyFingerprint: binding.contentPublicKeyFingerprint,
    };
}

/**
 * Server-side adapter over the canonical Protocol binding verifier. Protocol
 * owns the binding bytes, key validation, and fingerprint; this module keeps
 * decoding, persistence, initialization, currentness, and `key_mismatch`
 * policy.
 */
export function verifyAccountContentKeyBinding(params: Readonly<{
    accountSigningPublicKey: Uint8Array;
    contentPublicKey: Uint8Array;
    contentPublicKeySignature: Uint8Array;
}>): VerifiedAccountContentKeyBinding | null {
    if (
        lastVerifiedBinding
        && bytesEqual(lastVerifiedBinding.accountSigningPublicKey, params.accountSigningPublicKey)
        && bytesEqual(lastVerifiedBinding.binding.contentPublicKey, params.contentPublicKey)
        && bytesEqual(lastVerifiedBinding.binding.contentPublicKeySignature, params.contentPublicKeySignature)
    ) {
        return copyVerifiedBinding(lastVerifiedBinding.binding);
    }
    const accountSigningPublicKey = copyBytes(params.accountSigningPublicKey);
    const verified = verifyAccountContentKeyBindingV1({
        accountSigningPublicKey,
        contentPublicKey: params.contentPublicKey,
        signature: params.contentPublicKeySignature,
    });
    if (!verified) return null;
    const binding = {
        contentPublicKey: verified.contentPublicKey,
        contentPublicKeySignature: verified.signature,
        contentPublicKeyFingerprint: verified.contentPublicKeyFingerprint,
    };
    lastVerifiedBinding = { accountSigningPublicKey, binding };
    return copyVerifiedBinding(binding);
}

export function verifyAccountContentKeyBindingForAccountPublicKey(
    params: Readonly<{
        accountPublicKeyHex: string | null;
        contentPublicKey: Uint8Array;
        contentPublicKeySignature: Uint8Array;
    }>,
): VerifiedAccountContentKeyBinding | null {
    const accountSigningPublicKey = decodeAccountSigningPublicKey(
        params.accountPublicKeyHex,
    );
    if (!accountSigningPublicKey) return null;
    return verifyAccountContentKeyBinding({
        accountSigningPublicKey,
        contentPublicKey: params.contentPublicKey,
        contentPublicKeySignature: params.contentPublicKeySignature,
    });
}

function verifyStoredAccountContentKeyBinding(account: Readonly<{
    publicKey: string | null;
    contentPublicKey: Uint8Array | null;
    contentPublicKeySig: Uint8Array | null;
}>): VerifiedAccountContentKeyBinding | null {
    if (
        account.contentPublicKey === null
        || account.contentPublicKeySig === null
    ) {
        return null;
    }
    return verifyAccountContentKeyBindingForAccountPublicKey({
        accountPublicKeyHex: account.publicKey,
        contentPublicKey: account.contentPublicKey,
        contentPublicKeySignature: account.contentPublicKeySig,
    });
}

export async function admitAccountContentKey(
    client: AccountContentKeyClient,
    params: Readonly<{
        accountId: string;
        contentPublicKey: Uint8Array;
        contentPublicKeySignature: Uint8Array;
    }>,
): Promise<AccountContentKeyAdmissionResult> {
    const readAccount = async () => await client.account.findUnique({
        where: { id: params.accountId },
        select: {
            publicKey: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    let account = await readAccount();
    if (!account) return { status: "account_not_found" };

    let binding = verifyAccountContentKeyBindingForAccountPublicKey({
        accountPublicKeyHex: account.publicKey,
        contentPublicKey: params.contentPublicKey,
        contentPublicKeySignature: params.contentPublicKeySignature,
    });
    if (!binding) return { status: "invalid_binding" };

    // A complete stored binding is a read-only rejoin, linearized at the
    // Account read. It neither initializes keys nor publishes currentness.
    if (account.contentPublicKey !== null && account.contentPublicKeySig !== null) {
        if (!bytesEqual(account.contentPublicKey, binding.contentPublicKey)) return { status: "key_mismatch" };
        const storedBinding = verifyStoredAccountContentKeyBinding(account);
        return storedBinding ? { status: "unchanged", binding: storedBinding } : { status: "invalid_binding" };
    }

    try {
        await acquireAccountSessionOwnerMetadataFenceInTx(client, params.accountId, "exclusive");
    } catch (error) {
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) {
            return { status: "account_not_found" };
        }
        throw error;
    }
    // A key/mode writer may have committed while admission waited. Mutation
    // always decides from the newly fenced Account, never the optimistic read.
    account = await readAccount();
    if (!account) return { status: "account_not_found" };
    binding = verifyAccountContentKeyBindingForAccountPublicKey({
        accountPublicKeyHex: account.publicKey,
        contentPublicKey: params.contentPublicKey,
        contentPublicKeySignature: params.contentPublicKeySignature,
    });
    if (!binding) return { status: "invalid_binding" };

    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (account.contentPublicKey === null) {
            const initialized = await client.account.updateMany({
                where: {
                    id: params.accountId,
                    contentPublicKey: null,
                },
                data: {
                    contentPublicKey: binding.contentPublicKey,
                    contentPublicKeySig:
                        binding.contentPublicKeySignature,
                },
            });
            if (initialized.count === 1) {
                await publishAccountEncryptionCurrentnessAfterTx(client, params.accountId);
                return { status: "initialized", binding };
            }
        } else if (!bytesEqual(
            account.contentPublicKey,
            binding.contentPublicKey,
        )) {
            return { status: "key_mismatch" };
        } else if (account.contentPublicKeySig === null) {
            const filled = await client.account.updateMany({
                where: {
                    id: params.accountId,
                    contentPublicKey: binding.contentPublicKey,
                    contentPublicKeySig: null,
                },
                data: {
                    contentPublicKeySig:
                        binding.contentPublicKeySignature,
                },
            });
            if (filled.count === 1) {
                await publishAccountEncryptionCurrentnessAfterTx(client, params.accountId);
                return { status: "signature_filled", binding };
            }
        } else {
            const storedBinding =
                verifyStoredAccountContentKeyBinding(account);
            return storedBinding
                ? { status: "unchanged", binding: storedBinding }
                : { status: "invalid_binding" };
        }

        account = await readAccount();
        if (!account) return { status: "account_not_found" };
    }
    if (!bytesEqual(
        account.contentPublicKey,
        binding.contentPublicKey,
    )) {
        return { status: "key_mismatch" };
    }
    const storedBinding = verifyStoredAccountContentKeyBinding(account);
    return storedBinding
        ? { status: "unchanged", binding: storedBinding }
        : { status: "invalid_binding" };
}

export function deriveAccountEncryptionCurrentnessFromRow(
    account: Readonly<{
        publicKey: string | null;
        encryptionMode: string | null;
        contentPublicKey: Uint8Array | null;
        contentPublicKeySig: Uint8Array | null;
    }>,
): AccountEncryptionCurrentnessResult {
    const mode =
        resolveEffectiveAccountEncryptionModeFromAccountRow(account);
    if (mode.status === "inconsistent") {
        return mode;
    }
    const contentPublicKey = account.contentPublicKey
        ? copyBytes(account.contentPublicKey)
        : null;
    const contentPublicKeySignature = account.contentPublicKeySig
        ? copyBytes(account.contentPublicKeySig)
        : null;
    const verifiedBinding =
        contentPublicKey && contentPublicKeySignature
            ? verifyAccountContentKeyBindingForAccountPublicKey({
                accountPublicKeyHex: account.publicKey,
                contentPublicKey,
                contentPublicKeySignature,
            })
            : null;

    if (mode.mode === "e2ee") {
        if (!decodeAccountSigningPublicKey(account.publicKey)) {
            return {
                status: "inconsistent",
                reason: "missing_or_invalid_signing_key",
            };
        }
        if (
            contentPublicKey === null
            || contentPublicKeySignature === null
        ) {
            return {
                status: "inconsistent",
                reason: "missing_content_key_binding",
            };
        }
        if (!verifiedBinding) {
            return {
                status: "inconsistent",
                reason: "invalid_content_key_binding",
            };
        }
    }

    return {
        status: "ready",
        currentness: {
            encryptionMode: mode.mode,
            contentPublicKey,
            contentPublicKeySignature,
            contentPublicKeyFingerprint:
                verifiedBinding?.contentPublicKeyFingerprint ?? null,
        },
    };
}

/**
 * The only E2EE inconsistency that an ordinary verified Secret Key login can
 * repair is a valid signing anchor with both content-key binding fields absent.
 * Every other inconsistency remains fail-closed and must not be advertised as
 * a recovery path.
 */
export function isAccountContentKeyBindingRecoveryRequired(
    account: Readonly<{
        publicKey: string | null;
        encryptionMode: string | null;
        contentPublicKey: Uint8Array | null;
        contentPublicKeySig: Uint8Array | null;
    }>,
    currentness: AccountEncryptionCurrentnessResult =
        deriveAccountEncryptionCurrentnessFromRow(account),
): boolean {
    return account.encryptionMode === "e2ee"
        && account.contentPublicKey === null
        && account.contentPublicKeySig === null
        && currentness.status === "inconsistent"
        && currentness.reason === "missing_content_key_binding";
}
