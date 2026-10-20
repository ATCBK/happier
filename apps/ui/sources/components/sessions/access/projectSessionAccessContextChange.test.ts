import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { projectSessionAccessContextChange } from './projectSessionAccessContextChange';

const restricted = (teamId: string) => ({
    teamId,
    name: teamId,
    sessionCreationPolicy: 'private_default' as const,
    externalSharingPolicy: 'disabled' as const,
});

describe('projectSessionAccessContextChange', () => {
    it('reviews restrictive audience reclassification between Teams with the same policy', () => {
        const consequences = projectSessionAccessContextChange({
            current: restricted('team-one'),
            target: restricted('team-two'),
            grants: [],
        });

        expect(consequences).toHaveLength(1);
        expect(consequences[0]).toContain(t('teams.policy.externalSharingDisabled'));
    });

    it('names the context-required credential selections the outgoing Team keeps', () => {
        const credentialBindings = [
            { resourceId: 'r1', teamId: 'team-one', displayName: 'Prod registry', policy: 'team_context_required' as const },
            { resourceId: 'r2', teamId: 'team-one', displayName: 'Prod deploy key', policy: 'team_visibility_required' as const },
            { resourceId: 'r3', teamId: 'team-two', displayName: 'Design registry', policy: 'team_context_required' as const },
        ];
        const allowed = (teamId: string) => ({ ...restricted(teamId), externalSharingPolicy: 'allowed' as const });

        const leaving = projectSessionAccessContextChange({
            current: allowed('team-one'), target: allowed('team-two'), grants: [], credentialBindings,
        });
        expect(leaving).toEqual([expect.stringContaining('Prod registry')]);
        expect(JSON.stringify(leaving)).not.toContain('Prod deploy key');
        expect(JSON.stringify(leaving)).not.toContain('Design registry');

        expect(projectSessionAccessContextChange({
            current: allowed('team-one'), target: allowed('team-one'), grants: [], credentialBindings,
        })).toEqual([]);
    });

    it('names the required floor only when the target grant needs adding or promotion', () => {
        const target = {
            ...restricted('team-two'),
            sessionCreationPolicy: 'team_required' as const,
            externalSharingPolicy: 'allowed' as const,
        };

        expect(projectSessionAccessContextChange({ current: null, target, grants: [] }))
            .toEqual([expect.stringMatching(/required/i)]);
        expect(projectSessionAccessContextChange({
            current: null,
            target,
            grants: [{ subject: { kind: 'team', teamId: target.teamId }, accessLevel: 'edit' }],
        })).toEqual([]);
    });
});
