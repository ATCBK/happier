import { describe, expect, it, vi } from 'vitest';

import { teamSummaryFixture } from '@/dev/testkit';

import type { TeamSectionContext } from '../teamSectionContext';
import { teamGitHubAppSurface } from './TeamGitHubAppScreens';

function teamContext(overrides?: Partial<TeamSectionContext>): TeamSectionContext {
    return {
        scope: { serverId: 'home-a', accountId: 'account-ada' },
        address: { serverId: 'home-a', teamId: 'team-acme' },
        homeName: 'Home A',
        team: teamSummaryFixture({ id: 'team-acme' }),
        mutationsAvailable: true,
        archived: false,
        canMutate: true,
        approvalPending: false,
        refresh: vi.fn(),
        requestApproval: vi.fn(),
        settleLeave: vi.fn(),
        ...overrides,
    };
}

describe('Team GitHub App surface', () => {
    it('administers the Team\'s own registrations at the Team destinations', () => {
        const surface = teamGitHubAppSurface(teamContext());

        expect(surface.owner).toEqual({ kind: 'team', teamId: 'team-acme' });
        expect(surface.routes.detail('registration-1'))
            .toBe('/settings/teams/home-a/team-acme/authentication/github-apps/registration-1');
        expect(surface.routes.edit('registration-1'))
            .toBe('/settings/teams/home-a/team-acme/authentication/github-apps/registration-1/edit');
        expect(surface.routes.signIn)
            .toBe('/settings/teams/home-a/team-acme/authentication');
        expect(surface.routes.directory)
            .toBe('/settings/teams/home-a/team-acme/authentication/directory');
    });

    it('withholds mutations from an archived Team even while its Home is reachable', () => {
        const surface = teamGitHubAppSurface(teamContext({ archived: true, canMutate: false }));

        expect(surface.mutationsAvailable).toBe(false);
    });
});
