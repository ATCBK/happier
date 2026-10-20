import { describe, expect, it, vi } from 'vitest';
import type { SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

import { describeSessionFollower, projectSessionFollowerCensus } from './SessionPeopleFollowSections';

function source(destinationSessionId: string, relation: 'follower' | 'manager', preset: 'everything' | 'important' | 'quiet'): SessionFollowSourceV1 {
    return { sourceSessionId: 'this', destinationSessionId, relation, policy: { preset }, deliveryState: 'eligible', hasPendingUpdates: false };
}
function row(sources: SessionFollowSourceV1[]) {
    const follower = projectSessionFollowerCensus({ sources, follows: [], peopleCount: 0 }).sessions?.[0];
    if (!follower) throw new Error('expected one follower');
    return describeSessionFollower(follower);
}

describe('describeSessionFollower', () => {
    it('keeps the one-relation level line', () => {
        expect(row([source('lead', 'follower', 'quiet')])).toContain('Quiet');
        expect(row([source('lead', 'manager', 'important')])).toContain('Its manager');
    });

    it('says a manager that also follows can wake it, even when its ordinary follow is Quiet', () => {
        const line = row([source('lead', 'manager', 'everything'), source('lead', 'follower', 'quiet')]);
        expect(line).toContain('Its manager');
        expect(line).toContain('Also follows it');
        expect(line).toContain('Can wake it');
        expect(line).not.toContain('Quiet');
    });

    it('says nothing wakes it when no relation does', () => {
        const line = row([source('lead', 'manager', 'quiet'), source('lead', 'follower', 'quiet')]);
        expect(line).toContain('Also follows it');
        expect(line).toContain('At its next turn');
        expect(line).not.toContain('Can wake it');
    });

    it('does not promise next-turn delivery when the merged Custom policies select no events', () => {
        const off: SessionFollowSourceV1['policy'] = { preset: 'custom', events: {} };
        const census = projectSessionFollowerCensus({
            sources: [
                { ...source('lead', 'manager', 'quiet'), policy: off },
                { ...source('lead', 'follower', 'quiet'), policy: off },
            ],
            follows: [],
            peopleCount: 0,
        });
        const follower = census.sessions?.[0];
        if (!follower) throw new Error('expected one follower');
        expect(Object.values(follower.effective).every((event) => event.delivery === 'off')).toBe(true);
        const line = describeSessionFollower(follower);
        expect(line).toContain('No events selected');
        expect(line).not.toContain('At its next turn');
        expect(line).not.toContain('Can wake it');
    });
});
