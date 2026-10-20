import type { TeamCapabilitiesV1 } from "@happier-dev/protocol/teams";

import type { Tx } from "@/storage/inTx";
import type { TeamRole } from "@/storage/enums.generated";

import { resolveTeamActorContextInTx, type TeamActorContext } from "./actorContext";
import type { TeamRecord } from "./projections";

/**
 * One viewer's current relationship to one Team.
 *
 * This is the read-oriented view of the canonical Team actor context: the same
 * single lookup and the same capability decision, narrowed to what a route that
 * may serve Team summaries (including a self-leave-only summary) needs. It carries
 * no denied context, because its whole contract is that an unreadable Team is indistinct
 * from an absent one.
 *
 * A leave-only summary does not confer `viewTeam`: every protected read and
 * mutation must still check its own capability.
 */
export type TeamViewer = Readonly<{
    team: TeamRecord;
    /** The viewer's own Team role, or `null` for a Home administrator who is not a member. */
    viewerRole: TeamRole | null;
    capabilities: TeamCapabilitiesV1;
    /** The Team condition the governance notice renders; see {@link TeamActorContext}. */
    ownerRequired: boolean;
}>;

/**
 * Collapse a resolved actor context to a viewer.
 *
 * Absent and unreadable deliberately produce the same `null`. A caller that
 * could distinguish them would let anyone probe whether a Team ID exists on this
 * Home, which the error contract exists to prevent. This is the one place that
 * translation happens, so a service that needs the richer denied context —
 * distinguishing "archived" from "forbidden", or finding the Home administrator
 * who may perform owner recovery without being a member — simply consumes the
 * context directly instead of re-deriving the collapse.
 */
export function toTeamViewer(context: TeamActorContext | null): TeamViewer | null {
    if (!context || (!context.capabilities.viewTeam && !context.capabilities.leave)) return null;
    return {
        team: context.team,
        viewerRole: context.membership?.role ?? null,
        capabilities: context.capabilities,
        ownerRequired: context.ownerRequired,
    };
}

/**
 * Resolves the viewer, or `null` when the Team does not exist or the viewer may
 * not see it.
 */
export async function resolveTeamViewerInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; actorAccountId: string }>,
): Promise<TeamViewer | null> {
    return toTeamViewer(await resolveTeamActorContextInTx(tx, input));
}
