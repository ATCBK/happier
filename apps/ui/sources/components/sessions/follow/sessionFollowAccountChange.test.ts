import { describe, expect, it } from 'vitest';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';

import { isSessionFollowAccountChangeRelevant } from './sessionFollowAccountChange';

describe('Follow census invalidation', () => {
    const sourceIds = new Set(['source', 'receiver']);
    it('refreshes exact Session/access and private-rule changes while rejecting unrelated domains', () => {
        const relevant = (event: Parameters<typeof isSessionFollowAccountChangeRelevant>[0]) => (
            isSessionFollowAccountChangeRelevant(event, sourceIds)
        );
        expect(relevant({ serverId: 'home', entityIds: ['source'], changeKinds: ['session'] })).toBe(true);
        expect(relevant({ serverId: 'home', entityIds: ['receiver'], changeKinds: ['share'] })).toBe(true);
        expect(relevant({ serverId: 'home', entityIds: [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], changeKinds: ['account'] })).toBe(true);
        expect(relevant({ serverId: 'home', entityIds: ['self'], changeKinds: ['account'] })).toBe(true);
        expect(relevant({ serverId: 'home', entityIds: ['other-session'], changeKinds: ['session'] })).toBe(false);
        expect(relevant({ serverId: 'home', entityIds: ['source'], changeKinds: ['artifact'] })).toBe(false);
        expect(relevant({ serverId: 'home', entityIds: ['source'], changeKinds: ['machine'] })).toBe(false);
        expect(relevant({ serverId: 'home', entityIds: ['other-account-setting'], changeKinds: ['account'] })).toBe(false);
    });

    it('keeps unknown/reconnect wakes conservative without treating an explicit empty page as a change', () => {
        expect(isSessionFollowAccountChangeRelevant({ serverId: 'home', source: 'connected' }, sourceIds)).toBe(true);
        expect(isSessionFollowAccountChangeRelevant({ serverId: 'home', entityIds: ['source'] }, sourceIds)).toBe(true);
        expect(isSessionFollowAccountChangeRelevant({ serverId: 'home', changeKinds: ['session'] }, sourceIds)).toBe(true);
        expect(isSessionFollowAccountChangeRelevant({ serverId: 'home', changeKinds: [] }, sourceIds)).toBe(false);
    });
});
