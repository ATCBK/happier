import {
    deriveAccountEncryptionCurrentnessFromRow,
    type AccountEncryptionCurrentnessResult,
} from "@/app/encryption/accountContentKeyAdmission";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import type { Tx } from "@/storage/inTx";
import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';

import {
    resolveEffectiveLayout1SessionEncryptionMode,
    validateLayout1SessionStoredContentForMode,
    type Layout1SessionCreateRejection,
    type PreparedLayout1SessionCreate,
} from "./prepareLayout1SessionCreate";

const ACCOUNT_ENCRYPTION_CURRENTNESS_SELECTION = {
    status: true,
    publicKey: true,
    encryptionMode: true,
    contentPublicKey: true,
    contentPublicKeySig: true,
} as const;

export type SessionCreatorCurrentnessResult =
    | AccountEncryptionCurrentnessResult
    | Readonly<{ status: "inactive" }>;

export type Layout1SessionCreateInvariants =
    | Readonly<{
        ok: true;
        accountEncryptionMode: "e2ee" | "plain";
        effectiveEncryptionMode: "e2ee" | "plain";
    }>
    | Readonly<{ ok: false; rejection: Layout1SessionCreateRejection }>;

/**
 * Reads the Account row every Session creation path admits against.
 *
 * Callers pass `db` for the request-time read and the transaction client for the
 * authoritative read taken behind the owner-metadata fence.
 */
export async function readSessionCreatorCurrentness(
    client: Tx,
    accountId: string,
): Promise<SessionCreatorCurrentnessResult | null> {
    const account = await client.account.findUnique({
        where: { id: accountId },
        select: ACCOUNT_ENCRYPTION_CURRENTNESS_SELECTION,
    });
    if (!account) return null;
    if (!isActiveHomeAccountStatus(account.status)) return { status: "inactive" };
    return deriveAccountEncryptionCurrentnessFromRow(account);
}

/**
 * Establishes the durable Layout-1 creation invariants inside the transaction:
 * the Account owner-metadata fence, an active Account with current content-key
 * material, the persisted Account mode as the sole mode authority, and strict
 * stored content for the resolved Session mode.
 */
export async function ensureLayout1SessionCreateInvariantsInTx(
    tx: Tx,
    prepared: PreparedLayout1SessionCreate,
): Promise<Layout1SessionCreateInvariants> {
    await acquireAccountSessionOwnerMetadataFenceInTx(tx, prepared.accountId, "content");
    const currentness = await readSessionCreatorCurrentness(tx, prepared.accountId);
    if (currentness?.status === "inactive") {
        return { ok: false, rejection: { reason: "account-disabled" } };
    }
    if (currentness === null || currentness.status !== "ready") {
        return { ok: false, rejection: { reason: "invalid-params" } };
    }

    const accountEncryptionMode = currentness.currentness.encryptionMode;
    const effectiveEncryptionMode = resolveEffectiveLayout1SessionEncryptionMode({
        storagePolicy: prepared.storagePolicy,
        defaultAccountMode: prepared.defaultAccountMode,
        requestedEncryptionMode: prepared.requestedEncryptionMode,
        accountEncryptionMode,
    });

    if (!validateLayout1SessionStoredContentForMode({
        accountEncryptionMode,
        effectiveEncryptionMode,
        ownerMetadata: prepared.ownerMetadata,
        metadata: prepared.metadata,
        agentState: prepared.agentState,
    })) {
        return { ok: false, rejection: { reason: "invalid-params" } };
    }

    return { ok: true, accountEncryptionMode, effectiveEncryptionMode };
}
