import type { TeamMembershipV1, TeamSummaryV1 } from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

/**
 * The contract a contributed member-detail section receives.
 *
 * This is the mount contract for sections owned outside this child — Lane 06's
 * recipient key preparation is the first — so a contributor does not resolve its
 * own Home, Account, Team or membership and cannot end up addressing a different
 * one than the screen the person is looking at.
 *
 * `mutationsAvailable` is the host's single decision about whether a write may be
 * offered at all: it is false while the Team projection is stale or its Home is
 * unreachable, and while the Team is archived. A contributed section consumes it
 * rather than re-deriving readiness, so one screen cannot offer a live control in
 * one section and a disabled one in another.
 */
export type TeamMemberSectionContext = Readonly<{
    /** The exact Home and Account this screen was opened for. */
    scope: ServerAccountScope;
    /** The exact Home-qualified Team. */
    address: TeamAddress;
    team: TeamSummaryV1;
    /** The membership currently shown, including its own server capabilities. */
    membership: TeamMembershipV1;
    /** False while the shown state is stale, unreachable, or the Team archived. */
    mutationsAvailable: boolean;
    /** Re-reads this membership and its Team after an accepted change. */
    refresh: () => void;
    requestApproval?: (registration: ActionApprovalRegistration) => void;
}>;

/**
 * How the host mounts a contributed section. Returning `null` renders nothing:
 * a contributor whose own producer is absent must render no row rather than a
 * control that cannot work.
 */
export type TeamMemberSectionRenderer = (context: TeamMemberSectionContext) => React.ReactNode;
