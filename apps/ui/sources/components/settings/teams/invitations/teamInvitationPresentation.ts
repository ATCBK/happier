import {
    deriveTeamInvitationStateV1,
    type TeamInvitationRowV1,
    type TeamInvitationStateV1,
} from '@happier-dev/protocol/teams';

import { t } from '@/text';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';

import { teamRoleLabel } from '../teamLabels';

/**
 * How one invitation row is presented, and what may still be done to it.
 *
 * The Home's terminal answers are authoritative and are never recomputed here:
 * the row publishes `state` and, when available, its terminal instant. That
 * instant is presentation provenance, never a second state decision.
 *
 * Expiry is the one transition that can happen while this list is on screen, and
 * `expiresAt` is a real published fact, so it is the only state derived here.
 * It goes through the protocol's shared deriver so the rule is literally the
 * same code the Home applies.
 */
function resolveState(row: TeamInvitationRowV1, now: number): TeamInvitationStateV1 {
    if (row.state !== 'active') return row.state;
    return deriveTeamInvitationStateV1(
        { acceptedAt: null, revokedAt: null, expiresAt: row.expiresAt },
        now,
    );
}
export type TeamInvitationPresentation = Readonly<{
    state: TeamInvitationStateV1;
    stateLabel: string;
    finishedLabel: string | null;
    finishedAt: number | null;
    /** Only a live invitation can be revoked. */
    canRevoke: boolean;
    /**
     * A replacement is useful for anything that is no longer usable, and also
     * for a live one whose link was lost — the bearer is never recoverable.
     */
    canReissue: boolean;
    /**
     * Which replacement intents this row actually has.
     *
     * The reissue input owns the rule: `recipientEmail: null` is **Retry** — the
     * same offer to the same person, preserving whatever recipient constraint
     * the invitation already carries — and a value is **Change email**. Retry
     * cannot widen an email-bound invitation into a transferable link, so this
     * never has to reproduce the address behind the mask to stay safe.
     *
     * `link` therefore offers Retry alone; `email` offers Retry and Change
     * email; `none` is a spent invitation with no replacement at all.
     */
    reissueMode: 'none' | 'link' | 'email';
    /**
     * Who the row is about: the person who joined, else the masked recipient, else the role the
     * link grants. Seven links must not read as seven identical rows.
     */
    title: string;
    /** The masked recipient, or null for a link invitation. */
    recipientLabel: string | null;
    deliveryLabel: string | null;
    /**
     * A waiting invitation whose last email was refused by the mail boundary. The one state that
     * asks for attention on its own row; a finished invitation has nothing left to deliver.
     */
    emailUndelivered: boolean;
    /**
     * What this invitation actually offers, in the manager's words.
     *
     * A reviewer deciding whether to revoke an outstanding invitation needs the
     * role and history horizon it would grant; without them one live link is
     * indistinguishable from another that admits an admin to every past Session. A link's title
     * already names its role, so only the history horizon remains to say (`null` when ordinary).
     */
    offerLabel: string | null;
}>;

export function resolveTeamInvitationPresentation(
    row: TeamInvitationRowV1,
    now: number,
    viewerAccountId?: string,
): TeamInvitationPresentation {
    const state = resolveState(row, now);

    const stateLabel = state === 'active'
        ? t('teams.invitations.stateActive')
        : state === 'accepted'
            ? t('teams.invitations.stateAccepted')
            : state === 'revoked'
                ? t('teams.invitations.stateRevoked')
                : t('teams.invitations.stateExpired');

    const deliveryLabel = row.lastEmailDelivery === null
        ? null
        : row.lastEmailDelivery.status === 'sent'
            ? t('teams.invitations.deliverySent')
            : t('teams.invitations.deliveryFailed');

    // Expiry is passive: offering a fresh replacement is the useful recovery.
    // Revocation is an explicit manager decision and acceptance is already
    // fulfilled, so both retained rows remain provenance-only. This mirrors the
    // canonical reissue writer, which refuses both terminal transitions instead
    // of silently minting access again from either one.
    const canReissue = state === 'active' || state === 'expired';
    const person = state === 'accepted' && row.acceptedByAccountId
        ? resolveAccountDisplayName({ profile: row.finishedByAccount, accountId: row.acceptedByAccountId, viewerAccountId })
        : null;

    const recipientLabel = row.recipientEmailMask === null
        ? null
        : t('teams.invitations.maskedRecipient', { email: row.recipientEmailMask });
    const historyLabel = row.historyAccess === 'all_existing' ? t('teams.history.allExisting') : null;
    const titlesRole = person === null && recipientLabel === null;

    return Object.freeze({
        state,
        stateLabel,
        finishedLabel: state === 'active' ? null
            // The person is the title; the hint only tells apart Accounts that share a name.
            : [stateLabel, person?.hint].filter(Boolean).join(' · '),
        finishedAt: state === 'active' ? null : state === 'expired' ? row.expiresAt : row.finishedAt ?? null,
        canRevoke: state === 'active',
        canReissue,
        reissueMode: !canReissue
            ? 'none' as const
            : row.recipientEmailMask === null
                ? 'link' as const
                : 'email' as const,
        title: person?.name ?? recipientLabel ?? t('teams.invitations.linkTitle', { role: teamRoleLabel(row.role) }),
        recipientLabel,
        deliveryLabel,
        emailUndelivered: state === 'active' && row.lastEmailDelivery?.status === 'failed',
        // From when they join is the ordinary horizon and stays unsaid; only a link that opens the
        // Team's earlier sessions says so, which is what sets it apart from the others.
        offerLabel: titlesRole
            ? historyLabel
            : [teamRoleLabel(row.role), historyLabel].filter(Boolean).join(' · '),
    });
}

/**
 * The list's two groups (lab `tsInvites-A`): invitations still waiting to be accepted, and the ones
 * that are finished — accepted, revoked or expired. The state is the presenter's, so a row whose
 * expiry passed on screen moves to finished with the rest of what it shows.
 */
export function partitionTeamInvitations(
    rows: readonly TeamInvitationRowV1[],
    now: number,
): Readonly<{ waiting: readonly TeamInvitationRowV1[]; finished: readonly TeamInvitationRowV1[] }> {
    const waiting: TeamInvitationRowV1[] = [];
    const finished: TeamInvitationRowV1[] = [];
    for (const row of rows) {
        (resolveState(row, now) === 'active' ? waiting : finished).push(row);
    }
    return { waiting, finished };
}
