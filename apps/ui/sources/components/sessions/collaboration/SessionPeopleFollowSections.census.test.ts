import { describe, expect, it, vi } from 'vitest';
import type { SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

import { projectSessionFollowerCensus } from './SessionPeopleFollowSections';

const important = { preset: 'important' } as unknown as SessionFollowSourceV1['policy'];
const quiet = { preset: 'quiet' } as unknown as SessionFollowSourceV1['policy'];
function source(destinationSessionId: string, relation: 'follower' | 'manager', policy = important): SessionFollowSourceV1 {
    return { sourceSessionId: 'this', destinationSessionId, relation, policy, deliveryState: 'active', hasPendingUpdates: false } as unknown as SessionFollowSourceV1;
}

describe('projectSessionFollowerCensus', () => {
    it('draws a receiver that both follows and manages once, keeping its own follow level', () => {
        const census = projectSessionFollowerCensus({ sources: [source('lead', 'manager', quiet), source('lead', 'follower'), source('peer', 'follower')],
            follows: [], peopleCount: 2 });
        expect(census.sessions).toEqual([
            { sessionId: 'lead', manager: true, policy: important },
            { sessionId: 'peer', manager: false, policy: important },
        ]);
    });

    it('counts you in the people census only when your own follow is active, and keeps unknown unknown', () => {
        expect(projectSessionFollowerCensus({ sources: [], follows: [{}], peopleCount: 3 }).otherPeople).toBe(2);
        expect(projectSessionFollowerCensus({ sources: [], follows: [], peopleCount: 3 }).otherPeople).toBe(3);
        expect(projectSessionFollowerCensus({ sources: [], follows: [] })).toMatchObject({ peopleCount: null, otherPeople: null });
        expect(projectSessionFollowerCensus(null)).toEqual({ sessions: null, peopleCount: null, otherPeople: null });
    });
});
