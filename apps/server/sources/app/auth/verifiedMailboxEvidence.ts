import type { NormalizedVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import type { Tx } from '@/storage/inTx';

/**
 * Consuming admission, invitation or sign-in-email-change transactions call
 * this leaf only after proving the supplied mailbox. Parsing is not proof.
 */
export async function upsertVerifiedMailboxEvidenceInTx(tx: Tx, params: Readonly<{
    accountId: string;
    email: NormalizedVerifiedEmail;
}>): Promise<void> {
    await tx.accountEmail.upsert({
        where: {
            accountId_normalizedEmail: {
                accountId: params.accountId,
                normalizedEmail: params.email.normalizedEmail,
            },
        },
        create: { accountId: params.accountId, ...params.email },
        update: { address: params.email.address },
    });
}

/**
 * The one verified-mailbox ownership question, answered inside the caller's
 * transaction.
 *
 * Email-bound admission — a Team invitation constrained to a recipient today,
 * any later email-bound path — needs exactly this and nothing more: does this
 * Account own this exact normalized address? Keeping the reader beside the
 * writer is what stops a consuming domain from growing a second email truth
 * with its own comparison rules.
 *
 * The comparison is exact against the stored normalized value. The caller
 * supplies an address the normalization owner produced; a display address, a
 * differently cased submission, or padded input is not evidence of ownership
 * and is answered `false` rather than matched loosely.
 */
export async function accountOwnsVerifiedMailboxInTx(tx: Tx, params: Readonly<{
    accountId: string;
    normalizedEmail: string;
}>): Promise<boolean> {
    if (params.normalizedEmail.length === 0) return false;
    const evidence = await tx.accountEmail.findUnique({
        where: {
            accountId_normalizedEmail: {
                accountId: params.accountId,
                normalizedEmail: params.normalizedEmail,
            },
        },
        select: { accountId: true },
    });
    return evidence !== null;
}
