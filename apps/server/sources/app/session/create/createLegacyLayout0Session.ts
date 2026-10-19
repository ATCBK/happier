import { initializeSessionOwnerReadStateInTx } from "@/app/session/personal/readState";
import type { Tx } from "@/storage/inTx";
import { assertAccountActive } from "@/app/auth/accountStatus";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { writeSessionDataKeyEnvelopeInTx } from "@/app/session/encryption/sessionDataKeyEnvelopePersistence";
import { SessionOwnerEnvelopeError } from "./layout1SessionRowWrite";
import { publishSessionCreationInTx } from "./publishSessionCreationInTx";
import type { SessionCreationExecutionAuthorization } from './apiTokenSessionCreationAuthorization';
import { readSessionCreationApiTokenIdInTx } from "./apiTokenSessionCreationAuthorization";

/**
 * Writes the released pre-Layout-1 Session row.
 *
 * Layout-0 creation remains a compatibility path for clients that predate the
 * owner-metadata envelope: it carries no owner envelope and no Account
 * owner-metadata fence. It lives beside the Layout-1 constructor so every
 * Session insert stays with one owner, not so the two paths merge.
 */
export async function createLegacyLayout0SessionInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        tag: string;
        metadata: string;
        agentState: string | null;
        encryptionMode: "e2ee" | "plain";
        requestedStorageState: "machine_only" | undefined;
        dataEncryptionKey: Uint8Array<ArrayBuffer> | null;
        sessionCreationAuthorization?: SessionCreationExecutionAuthorization;
    }>,
) {
    const account = await tx.account.findUniqueOrThrow({
        where: { id: params.accountId },
        select: { status: true, encryptionMode: true },
    });
    assertAccountActive(account.status);
    const accountMode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
    if (accountMode.status !== "ready") throw new Error("Invalid persisted Account encryption mode");
    const createdAt = new Date();
    const createdByApiTokenId = await readSessionCreationApiTokenIdInTx(tx, params.accountId, params.sessionCreationAuthorization);
    const session = await tx.session.create({
        data: {
            accountId: params.accountId,
            createdByApiTokenId,
            tag: params.tag,
            encryptionMode: params.encryptionMode,
            metadata: params.metadata,
            agentState: params.agentState,
            createdAt,
            lastActiveAt: createdAt,
            meaningfulActivityAt: createdAt,
            ...(params.requestedStorageState
                ? { currentStorageState: params.requestedStorageState }
                : {}),
        },
    });
    // Layout-0 owners are recipients of their own Session key through the same
    // canonical tuple. A released legacy-credential Session supplies no
    // per-Session key and correctly writes none.
    if (params.encryptionMode !== "plain" && params.dataEncryptionKey) {
        const owner = await writeSessionDataKeyEnvelopeInTx(tx, {
            sessionId: session.id,
            recipientAccountId: session.accountId,
            encryptedDataKey: params.dataEncryptionKey,
            markRecipientChanged: false,
        });
        if (!owner.ok) throw new SessionOwnerEnvelopeError();
    }
    await initializeSessionOwnerReadStateInTx(tx, { accountId: session.accountId, sessionId: session.id });
    await publishSessionCreationInTx(tx, { session, ownerAccountMode: accountMode.mode });
    return session;
}
