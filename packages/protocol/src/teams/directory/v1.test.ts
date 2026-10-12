import { describe, expect, it } from 'vitest';

import {
  TEAM_DIRECTORY_ACTION_IDS_V1,
  TEAM_DIRECTORY_ACTION_METHODS_V1,
  TEAM_DIRECTORY_ACTION_PATHS_V1,
  TeamDirectoryGroupPageV1Schema,
  TeamDirectoryPeoplePageV1Schema,
  TeamDirectorySourceCreateInputV1Schema,
  TeamDirectorySourceSetupListInputV1Schema,
  TeamDirectorySourceSetupOptionsV1Schema,
  TeamDirectorySourceSummaryV1Schema,
  TeamDirectorySourceSyncResultV1Schema,
} from './v1.js';

describe('Team directory V1 contracts', () => {
  const source = {
    v: 1 as const,
    id: 'source_1',
    teamId: 'team_1',
    kind: 'workos_directory' as const,
    displayName: 'Primary directory',
    workosAdminPortalConnectionId: 'connection_1',
    state: 'active' as const,
    allowedActions: [] as const,
    sync: {
      mode: 'events_and_full' as const,
      attempt: 'succeeded' as const,
      freshness: 'fresh' as const,
      lastAttemptAt: '2026-09-06T10:00:00.000Z',
      lastSuccessAt: '2026-09-06T10:00:00.000Z',
      lastFullReconcileAt: '2026-09-06T10:00:00.000Z',
      nextScheduledAt: '2026-09-07T10:00:00.000Z',
    },
    error: null,
  };

  it('keeps source summaries strict and the sync facets independent', () => {
    expect(TeamDirectorySourceSummaryV1Schema.parse(source)).toEqual(source);
    expect(TeamDirectorySourceSummaryV1Schema.parse({
      ...source,
      kind: 'github_organization',
      workosAdminPortalConnectionId: null,
    })).toMatchObject({ kind: 'github_organization', workosAdminPortalConnectionId: null });
    expect(TeamDirectorySourceSummaryV1Schema.safeParse({ ...source, rawProvider: {} }).success).toBe(false);
    expect(TeamDirectorySourceSummaryV1Schema.safeParse({
      ...source,
      sync: { ...source.sync, attempt: 'failed' },
      error: { code: 'directory_source_permission_lost', retryable: false },
    }).success).toBe(true);
    expect(TeamDirectorySourceSummaryV1Schema.safeParse({
      ...source,
      error: { code: 'upstream_body', retryable: true },
    }).success).toBe(false);
  });

  it('accepts only concrete source bindings and bounded pages', () => {
    expect(TeamDirectorySourceSetupOptionsV1Schema.parse({
      v: 1,
      items: [
        {
          kind: 'workos_directory',
          displayName: 'Okta directory',
          teamIdentityConnectionId: 'connection_1',
          workosDirectoryId: 'directory_1',
        },
        {
          kind: 'github_organization',
          displayName: 'happier-dev',
          githubAppInstallationId: 'installation_1',
        },
      ],
      nextCursor: 'cursor_2',
      complete: false,
    }).items).toHaveLength(2);
    expect(TeamDirectorySourceSetupListInputV1Schema.parse({
      v: 1,
      teamId: 'team_1',
      limit: 50,
      cursor: 'cursor_1',
      query: 'okta',
    })).toMatchObject({ limit: 50, cursor: 'cursor_1', query: 'okta' });
    expect(TeamDirectorySourceSetupOptionsV1Schema.safeParse({
      v: 1,
      items: [{
        kind: 'workos_directory',
        displayName: 'Unsafe',
        teamIdentityConnectionId: 'connection_1',
        workosDirectoryId: 'directory_1',
        organizationId: 'raw-organization-id',
      }],
      nextCursor: null,
      complete: true,
    }).success).toBe(false);
    expect(TeamDirectorySourceCreateInputV1Schema.safeParse({
      v: 1,
      teamId: 'team_1',
      kind: 'workos_directory',
      teamIdentityConnectionId: 'connection_1',
      workosDirectoryId: 'directory_1',
      displayName: 'Primary directory',
    }).success).toBe(true);
    expect(TeamDirectorySourceCreateInputV1Schema.safeParse({
      v: 1,
      teamId: 'team_1',
      kind: 'github_organization',
      githubAppInstallationId: 'installation_1',
      displayName: 'Acme',
      token: 'secret',
    }).success).toBe(false);

    expect(TeamDirectoryPeoplePageV1Schema.parse({
      items: [{
        v: 1,
        id: 'person_1',
        sourceId: 'source_1',
        externalUserId: 'user_1',
        displayName: 'Ada',
        email: 'ada@example.test',
        externalLogin: null,
        state: 'active',
        accountBinding: { state: 'bound', accountId: 'account_1', teamMembershipId: 'membership_1' },
        sourceLabel: 'Primary directory',
      }],
      nextCursor: null,
    }).items).toHaveLength(1);

    expect(TeamDirectoryGroupPageV1Schema.parse({
      items: [{
        v: 1,
        id: 'group_row_1',
        sourceId: 'source_1',
        externalGroupId: 'group_1',
        displayName: 'Engineering',
        state: 'active',
        memberCount: 3,
        boundAccountCount: 1,
        unboundPeopleCount: 1,
        mapping: { state: 'bound', bindingId: 'binding_1', mode: 'native_target', teamGroupId: 'team_group_1', teamGroupName: 'Platform Engineering' },
        lastCompleteObservationAt: '2026-09-06T10:00:00.000Z',
        sourceLabel: 'Primary directory',
      }],
      nextCursor: 'cursor_2',
    }).items).toHaveLength(1);
  });

  it('publishes one exact Action id and path for every public directory operation', () => {
    expect(TEAM_DIRECTORY_ACTION_IDS_V1).toEqual([
      'teams.directory.sourceSetup.list',
      'teams.directory.sources.list',
      'teams.directory.sources.get',
      'teams.directory.people.list',
      'teams.directory.groups.list',
      'teams.directory.sources.create',
      'teams.directory.sources.sync',
      'teams.directory.sources.pause',
      'teams.directory.sources.resume',
      'teams.directory.sources.remove.preview',
      'teams.directory.sources.remove',
    ]);
    expect(new Set(TEAM_DIRECTORY_ACTION_IDS_V1.map((id) =>
      `${TEAM_DIRECTORY_ACTION_METHODS_V1[id]} ${TEAM_DIRECTORY_ACTION_PATHS_V1[id]}`,
    )).size).toBe(11);
    expect(TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sourceSetup.list'])
      .toBe('/v1/teams/:teamId/directory-source-setup-options');
    expect(TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.sync'])
      .toBe('/v1/teams/:teamId/directory-sources/:sourceId/sync');
    expect(TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.remove.preview'])
      .toBe('/v1/teams/:teamId/directory-sources/:sourceId/removal-impact');
    expect(TeamDirectorySourceSyncResultV1Schema.safeParse({
      v: 1,
      status: 'coalesced',
      source,
    }).success).toBe(true);
  });
});
