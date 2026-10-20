import { describe, expect, it, vi } from 'vitest';
import type { SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

import { projectFollowerDelivery, projectSessionFollowerCensus } from './SessionPeopleFollowSections';

const important: SessionFollowSourceV1['policy'] = { preset: 'important' };
const quiet: SessionFollowSourceV1['policy'] = { preset: 'quiet' };
const everything: SessionFollowSourceV1['policy'] = { preset: 'everything' };
function source(destinationSessionId: string, relation: 'follower' | 'manager', policy = important): SessionFollowSourceV1 {
    return { sourceSessionId: 'this', destinationSessionId, relation, policy, deliveryState: 'eligible', hasPendingUpdates: false };
}

describe('projectSessionFollowerCensus', () => {
    it('keeps both configured routes and the effective wake decision on one receiver row', () => {
        const census = projectSessionFollowerCensus({ sources: [source('lead', 'manager', everything), source('lead', 'follower', quiet), source('peer', 'follower')],
            follows: [], peopleCount: 2 });
        expect(census.sessions).toHaveLength(2);
        const lead = census.sessions?.[0];
        expect(lead?.sessionId).toBe('lead');
        expect(lead?.relations).toEqual([{ relation: 'manager', policy: everything, deliveryState: 'eligible' }, { relation: 'follower', policy: quiet, deliveryState: 'eligible' }]);
        expect(lead?.effective.finished).toEqual({ delivery: 'wake', via: ['manager', 'follower'] });
        expect(lead?.effective.message).toEqual({ delivery: 'next_turn', via: ['manager'] });
        expect(census.sessions?.[1]?.effective.finished).toEqual({ delivery: 'next_turn', via: ['follower'] });
    });

    it('keeps a stronger ordinary route and a manager-only route', () => {
        const census = projectSessionFollowerCensus({ sources: [source('lead', 'follower', everything), source('lead', 'manager', quiet), source('manager-only', 'manager', quiet)],
            follows: [], peopleCount: 0 });
        expect(census.sessions).toHaveLength(2);
        expect(census.sessions?.[0]?.effective.finished).toEqual({ delivery: 'wake', via: ['follower', 'manager'] });
        expect(census.sessions?.[1]?.relations).toEqual([{ relation: 'manager', policy: quiet, deliveryState: 'eligible' }]);
        expect(census.sessions?.[1]?.effective.finished).toEqual({ delivery: 'next_turn', via: ['manager'] });
    });

    it('projects the actual needs-you variant through the canonical delivery policy', () => {
        const managerPolicy: SessionFollowSourceV1['policy'] = { preset: 'custom', events: { needs_you: {
            decision: { delivery: 'off' }, approval: { delivery: 'quiet' }, blocked: { delivery: 'interrupt' },
        } } };
        const followerPolicy: SessionFollowSourceV1['policy'] = { preset: 'custom', events: { needs_you: {
            decision: { delivery: 'interrupt' }, approval: { delivery: 'off' }, blocked: { delivery: 'quiet' },
        } } };
        const row = projectSessionFollowerCensus({ sources: [source('lead', 'manager', managerPolicy), source('lead', 'follower', followerPolicy)],
            follows: [], peopleCount: 0 }).sessions?.[0];
        expect(row).toBeDefined();
        if (!row) return;
        expect(projectFollowerDelivery(row, { kind: 'needs_you', type: 'decision', mode: 'continue', handling: 'manager' }))
            .toEqual({ delivery: 'wake', via: ['follower'] });
        expect(projectFollowerDelivery(row, { kind: 'needs_you', type: 'approval', mode: 'continue', handling: 'manager' }))
            .toEqual({ delivery: 'next_turn', via: ['manager'] });
        expect(projectFollowerDelivery(row, { kind: 'needs_you', type: 'blocked', mode: 'continue', handling: 'manager' }))
            .toEqual({ delivery: 'wake', via: ['manager', 'follower'] });
    });

    it('counts you in the people census only when your own follow is active, and keeps unknown unknown', () => {
        expect(projectSessionFollowerCensus({ sources: [], follows: [{}], peopleCount: 3 }).otherPeople).toBe(2);
        expect(projectSessionFollowerCensus({ sources: [], follows: [], peopleCount: 3 }).otherPeople).toBe(3);
        expect(projectSessionFollowerCensus({ sources: [], follows: [] })).toMatchObject({ peopleCount: null, otherPeople: null });
        expect(projectSessionFollowerCensus(null)).toEqual({ sessions: null, peopleCount: null, otherPeople: null });
    });
});
