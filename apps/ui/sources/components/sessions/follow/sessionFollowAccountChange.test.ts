import { describe, expect, it } from 'vitest';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';
import { PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

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

    it('invalidates a rule corpus for future sources and Project facts while leaving unrelated domains quiet', () => {
        expect(isSessionFollowAccountChangeRelevant({ serverId: 'home', entityIds: ['new-source'], changeKinds: ['session'] })).toBe(true);
        expect(isSessionFollowAccountChangeRelevant({ serverId: 'home', entityIds: ['new-source'], changeKinds: ['share'] })).toBe(true);
        const project = { serverId: 'home', entityIds: [`${PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1}payments`], changeKinds: ['kv'] };
        expect(isSessionFollowAccountChangeRelevant(project)).toBe(true);
        expect(isSessionFollowAccountChangeRelevant(project, sourceIds)).toBe(false);
        expect(isSessionFollowAccountChangeRelevant({ serverId: 'home', entityIds: ['other-key'], changeKinds: ['kv'] })).toBe(false);
        expect(isSessionFollowAccountChangeRelevant({ serverId: 'home', entityIds: ['new-source'], changeKinds: ['artifact'] })).toBe(false);
        expect(isSessionFollowAccountChangeRelevant({ serverId: 'home', entityIds: ['new-source'], changeKinds: ['machine'] })).toBe(false);
    });

    it('uses the list planner for corpus demand while keeping exact detail and independent changes fresh', () => {
        const transcript = { serverId: 'home', entityIds: ['source'], changeKinds: ['session'], sessionListQueryAffects: false } as const;
        expect(isSessionFollowAccountChangeRelevant(transcript)).toBe(false);
        expect(isSessionFollowAccountChangeRelevant(transcript, sourceIds)).toBe(true);
        expect(isSessionFollowAccountChangeRelevant({ ...transcript, sessionListQueryAffects: 'structural' })).toBe(true);
        expect(isSessionFollowAccountChangeRelevant({ ...transcript, sessionListQueryAffects: true })).toBe(true);
        expect(isSessionFollowAccountChangeRelevant({ ...transcript, changeKinds: ['session', 'share'] })).toBe(true);
        expect(isSessionFollowAccountChangeRelevant({ ...transcript, entityIds: [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID],
            changeKinds: ['session', 'account'] })).toBe(true);
        expect(isSessionFollowAccountChangeRelevant({ ...transcript, entityIds: [`${PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1}payments`],
            changeKinds: ['session', 'kv'] })).toBe(true);
        expect(isSessionFollowAccountChangeRelevant({ serverId: 'home', entityIds: ['session-tags'],
            changeKinds: ['kv'], sessionListQueryAffects: true })).toBe(true);
    });
});
