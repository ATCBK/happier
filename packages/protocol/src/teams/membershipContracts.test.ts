import { describe, expect, it } from 'vitest';

import {
  decodeTeamGroupMembersCursorV1,
  decodeTeamGroupsCursorV1,
  decodeTeamMembersCursorV1,
  encodeTeamGroupMembersCursorV1,
  encodeTeamGroupsCursorV1,
  encodeTeamMembersCursorV1,
  teamGroupMembersQueryKeyV1,
  teamGroupNameKeyV1,
  teamGroupsQueryKeyV1,
  teamMembersQueryKeyV1,
  validateTeamGroupNameV1,
  TeamAdmissibleRoleV1Schema,
  TeamGroupCreateInputV1Schema,
  TeamGroupMemberAddInputV1Schema,
  TeamGroupMemberV1Schema,
  TeamGroupUpdateInputV1Schema,
  TeamGroupV1Schema,
  TeamMemberAddInputV1Schema,
  TeamMemberManagementSetInputV1Schema,
  TeamMemberRoleSetInputV1Schema,
  TeamMembersListInputV1Schema,
  TeamMembershipV1Schema,
  teamErrorHttpStatusV1,
} from './index.js';

const PROFILE = { name: 'Alice Martin', firstName: 'Alice Martin', lastName: null, username: 'alice', avatarUrl: null };

const MEMBER = {
  v: 1 as const,
  id: 'mem_1',
  teamId: 'team_1',
  accountId: 'acc_1',
  account: PROFILE,
  role: 'member' as const,
  status: 'active' as const,
  historyAccess: 'from_membership' as const,
  management: { kind: 'native' as const },
  capabilities: {
    setRole: true,
    assignableRoles: ['admin', 'member', 'guest'],
    suspend: true,
    reactivate: false,
    remove: true,
    setManagement: false,
  },
  joinedAt: 1_700_000_000_000,
};

describe('Team membership projection', () => {
  it('accepts the canonical member row', () => {
    expect(TeamMembershipV1Schema.parse(MEMBER)).toMatchObject({ id: 'mem_1', role: 'member' });
  });

  it('never carries the raw history cutoff', () => {
    // The cutoff is a server-owned access input. Publishing it would invite a
    // client to compare timestamps, which is Lane 04's exclusive decision.
    const leaked = { ...MEMBER, sessionAccessStartsAt: 1_700_000_000_000 };
    expect(TeamMembershipV1Schema.safeParse(leaked).success).toBe(false);
  });

  it('projects a directory-managed row with its label and no external identifiers', () => {
    const managed = {
      ...MEMBER,
      management: { kind: 'directory_source' as const, directorySourceId: 'src_1', label: 'Acme Entra ID' },
    };
    expect(TeamMembershipV1Schema.parse(managed).management).toEqual({
      kind: 'directory_source',
      directorySourceId: 'src_1',
      label: 'Acme Entra ID',
    });
    const withoutSourceId = { ...MEMBER, management: { kind: 'directory_source', label: 'Acme' } };
    expect(TeamMembershipV1Schema.safeParse(withoutSourceId).success).toBe(false);
  });

  it('requires the exact identity connection for JIT-managed membership navigation', () => {
    const managed = {
      ...MEMBER,
      management: {
        kind: 'identity_connection' as const,
        identityConnectionId: 'connection_1',
        label: 'Acme SSO',
      },
    };
    expect(TeamMembershipV1Schema.parse(managed).management).toEqual({
      kind: 'identity_connection',
      identityConnectionId: 'connection_1',
      label: 'Acme SSO',
    });
    expect(TeamMembershipV1Schema.safeParse({
      ...MEMBER,
      management: { kind: 'identity_connection', label: 'Acme SSO' },
    }).success).toBe(false);
  });
});

describe('Team member admission inputs', () => {
  it('excludes owner from direct add, which is a post-membership governance step', () => {
    expect(TeamAdmissibleRoleV1Schema.safeParse('owner').success).toBe(false);
    expect(TeamMemberAddInputV1Schema.safeParse({
      v: 1, teamId: 't', accountId: 'a', role: 'owner', historyAccess: 'from_membership',
    }).success).toBe(false);
    expect(TeamMemberAddInputV1Schema.parse({
      v: 1, teamId: 't', accountId: 'a', role: 'guest', historyAccess: 'all_existing',
    }).role).toBe('guest');
  });

  it('admits owner only through the explicit role mutation', () => {
    expect(TeamMemberRoleSetInputV1Schema.parse({
      v: 1, teamId: 't', membershipId: 'm', role: 'owner',
    }).role).toBe('owner');
  });

  it('requires an exact source for directory management and none for native', () => {
    expect(TeamMemberManagementSetInputV1Schema.parse({
      v: 1, teamId: 't', membershipId: 'm', management: { kind: 'native' },
    }).management.kind).toBe('native');
    expect(TeamMemberManagementSetInputV1Schema.parse({
      v: 1, teamId: 't', membershipId: 'm', management: { kind: 'directory_source', directorySourceId: 's' },
    }).management).toEqual({ kind: 'directory_source', directorySourceId: 's' });
    expect(TeamMemberManagementSetInputV1Schema.safeParse({
      v: 1, teamId: 't', membershipId: 'm', management: { kind: 'directory_source' },
    }).success).toBe(false);
  });

  it('offers only the current-purpose roster filters', () => {
    expect(TeamMembersListInputV1Schema.parse({ v: 1, teamId: 't', filter: 'suspended' }).filter)
      .toBe('suspended');
    expect(TeamMembersListInputV1Schema.safeParse({ v: 1, teamId: 't', filter: 'role:owner' }).success)
      .toBe(false);
    // One bounded lookup, in the shape the Team directory contract ships; it is
    // a person's name, never a filter expression, and it is capped.
    expect(TeamMembersListInputV1Schema.parse({ v: 1, teamId: 't', filter: 'all', query: 'ali' }).query)
      .toBe('ali');
    expect(TeamMembersListInputV1Schema.safeParse({
      v: 1, teamId: 't', filter: 'all', query: 'x'.repeat(257),
    }).success).toBe(false);
  });
});

describe('Team Group contracts', () => {
  it('normalizes a Group name through the shared Team name owner and folds case for its key', () => {
    expect(validateTeamGroupNameV1('  Platform   Design ')).toEqual({ status: 'ok', name: 'Platform Design' });
    expect(teamGroupNameKeyV1('Platform   Design')).toBe(teamGroupNameKeyV1('platform design'));
    expect(teamGroupNameKeyV1('Design')).not.toBe(teamGroupNameKeyV1('Designers'));
    expect(validateTeamGroupNameV1('   ')).toEqual({ status: 'invalid', reason: 'empty' });
  });

  it('projects contribution provenance as native plus exact source contributions', () => {
    const row = {
      accountId: 'acc_1',
      membershipId: 'mem_1',
      account: PROFILE,
      historyAccess: 'all_existing' as const,
      contributions: {
        native: false,
        external: [{
          bindingId: 'bind_1',
          label: 'Okta',
          owner: { kind: 'directory_source' as const, directorySourceId: 'source_1' },
        }],
      },
    };
    expect(TeamGroupMemberV1Schema.parse(row).contributions.external[0]?.label).toBe('Okta');
    expect(TeamGroupMemberV1Schema.parse(row).contributions.external[0]?.owner).toEqual({
      kind: 'directory_source',
      directorySourceId: 'source_1',
    });
    expect(TeamGroupMemberV1Schema.safeParse({
      ...row,
      contributions: { native: false, external: [{ bindingId: 'bind_1', label: 'Okta' }] },
    }).success).toBe(false);
    // No surrogate Group-membership identity is ever minted or published.
    expect(TeamGroupMemberV1Schema.safeParse({ ...row, groupMembershipId: 'gm_1' }).success).toBe(false);
  });

  it('projects a Group with its member count and metadata ownership', () => {
    const group = {
      v: 1 as const,
      id: 'grp_1',
      teamId: 'team_1',
      name: 'Developers',
      description: null,
      archivedAt: null,
      memberCount: 42,
      management: {
        kind: 'directory_created' as const,
        bindingId: 'bind_1',
        label: 'Okta',
        owner: { kind: 'directory_source' as const, directorySourceId: 'source_1' },
      },
      capabilities: { updateMetadata: false, archive: false, restore: false, manageNativeMembers: true },
    };
    expect(TeamGroupV1Schema.parse(group).memberCount).toBe(42);
    expect(TeamGroupV1Schema.parse(group).management).toMatchObject({
      owner: { kind: 'directory_source', directorySourceId: 'source_1' },
    });
    expect(TeamGroupV1Schema.safeParse({ ...group, nameKey: 'developers' }).success).toBe(false);
  });

  it('rejects a metadata patch that changes nothing', () => {
    expect(TeamGroupUpdateInputV1Schema.safeParse({ v: 1, teamId: 't', groupId: 'g' }).success).toBe(false);
    expect(TeamGroupUpdateInputV1Schema.parse({ v: 1, teamId: 't', groupId: 'g', description: null }).description)
      .toBeNull();
  });

  it('requires a retry key on create and a history intent on Group admission', () => {
    expect(TeamGroupCreateInputV1Schema.safeParse({ v: 1, teamId: 't', name: 'Design' }).success).toBe(false);
    expect(TeamGroupMemberAddInputV1Schema.safeParse({ v: 1, teamId: 't', groupId: 'g', accountId: 'a' }).success)
      .toBe(false);
    expect(TeamGroupMemberAddInputV1Schema.parse({
      v: 1, teamId: 't', groupId: 'g', accountId: 'a', historyAccess: 'from_membership',
    }).historyAccess).toBe('from_membership');
  });
});

describe('Team page cursors', () => {
  it('round-trips a roster position and rejects one minted for another filter', () => {
    const key = teamMembersQueryKeyV1({ v: 1, teamId: 't', filter: 'all' });
    const cursor = encodeTeamMembersCursorV1({ queryKey: key, createdAt: 12, id: 'mem_1' });
    expect(decodeTeamMembersCursorV1(cursor, key)).toEqual({
      status: 'ok',
      cursor: { createdAt: 12, id: 'mem_1' },
    });
    const otherKey = teamMembersQueryKeyV1({ v: 1, teamId: 't', filter: 'guests' });
    expect(decodeTeamMembersCursorV1(cursor, otherKey)).toEqual({ status: 'invalid' });
    const otherTeam = teamMembersQueryKeyV1({ v: 1, teamId: 'other', filter: 'all' });
    expect(decodeTeamMembersCursorV1(cursor, otherTeam)).toEqual({ status: 'invalid' });
    // A lookup selects different rows, so it names its own sequence; a blank
    // one is no lookup and keeps the roster's existing positions valid.
    const queried = teamMembersQueryKeyV1({ v: 1, teamId: 't', filter: 'all', query: 'ada' });
    expect(decodeTeamMembersCursorV1(cursor, queried)).toEqual({ status: 'invalid' });
    expect(teamMembersQueryKeyV1({ v: 1, teamId: 't', filter: 'all', query: '   ' })).toBe(key);
  });

  it('orders Group members by immutable creation order plus the membership lifetime', () => {
    const key = teamGroupMembersQueryKeyV1({ v: 1, teamId: 't', groupId: 'g' });
    const cursor = encodeTeamGroupMembersCursorV1({ queryKey: key, createdAt: 7, teamMembershipId: 'mem_9' });
    expect(decodeTeamGroupMembersCursorV1(cursor, key)).toEqual({
      status: 'ok',
      cursor: { createdAt: 7, teamMembershipId: 'mem_9' },
    });
    expect(decodeTeamGroupMembersCursorV1('not-a-cursor', key)).toEqual({ status: 'invalid' });
  });

  it('orders Groups by their normalized key and then id', () => {
    const key = teamGroupsQueryKeyV1({ v: 1, teamId: 't', archived: 'active' });
    const cursor = encodeTeamGroupsCursorV1({ queryKey: key, nameKey: 'design', id: 'grp_1' });
    expect(decodeTeamGroupsCursorV1(cursor, key)).toEqual({
      status: 'ok',
      cursor: { nameKey: 'design', id: 'grp_1' },
    });
    const archivedKey = teamGroupsQueryKeyV1({ v: 1, teamId: 't', archived: 'archived' });
    expect(decodeTeamGroupsCursorV1(cursor, archivedKey)).toEqual({ status: 'invalid' });
  });
});

describe('Team membership and Group error statuses', () => {
  it('maps each child-04 domain result to one wire status', () => {
    expect(teamErrorHttpStatusV1('membership_not_found')).toBe(404);
    expect(teamErrorHttpStatusV1('not_team_member')).toBe(403);
    expect(teamErrorHttpStatusV1('group_not_found')).toBe(404);
    expect(teamErrorHttpStatusV1('group_archived')).toBe(409);
    expect(teamErrorHttpStatusV1('group_name_taken')).toBe(409);
    expect(teamErrorHttpStatusV1('management_conflict')).toBe(409);
    expect(teamErrorHttpStatusV1('managed_by_directory')).toBe(409);
    expect(teamErrorHttpStatusV1('team_owner_transfer_required')).toBe(409);
  });
});
