import { TeamMembersPageV1Schema, type TeamMembersListFilterV1, type TeamMembersPageV1 } from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';

import { runTeamAction } from './teamActionClient';
import type { TeamMemberOutcome } from './teamMemberOperations';

/** The shared roster loader must not depend on mutations that invalidate it. */
export async function listTeamMembers(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    filter: TeamMembersListFilterV1;
    query?: string;
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
}>): Promise<TeamMemberOutcome<TeamMembersPageV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        signal: params.signal,
        actionId: 'teams.members.list',
        input: {
            v: 1,
            teamId: params.address.teamId,
            filter: params.filter,
            ...(params.query ? { query: params.query } : {}),
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
        },
        parse: (value) => TeamMembersPageV1Schema.parse(value),
    });
    return outcome.kind === 'succeeded'
        ? Object.freeze({ kind: 'succeeded', value: outcome.value })
        : Object.freeze({ kind: 'failed', failure: outcome.failure });
}
