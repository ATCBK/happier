import { describe, expect, it } from 'vitest';
import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from './sessionListRenderable';
import { projectSessionList } from './projectSessionList';

describe('Project Session roster admission', () => {
    it('filters admitted list membership and never revives foreign, private, locked, or cache-only rows', () => {
        const row = (id: string, overrides: Parameters<typeof createSessionFixture>[0] = {}) => buildSessionListRenderableFromSession(createSessionFixture({
            id, owner: 'viewer', metadata: { path: '/repo', host: 'host', projectId: 'anchor' }, ...overrides,
        }));
        const rows = {
            own: row('own'), foreign: row('foreign', { owner: 'other' }),
            recipient: row('recipient', { access: createSessionAccessFixture('view'), accessLevel: 'view' }),
            locked: row('locked', { metadata: null }), cached: row('cached'),
        };
        const items = ['own', 'foreign', 'recipient', 'locked'].map(sessionId => ({ type: 'session' as const, serverId: 'home-a', sessionId }));
        const input = { project: { serverId: 'home-a', projectKey: 'anchor' }, viewer: { serverId: 'home-a', accountId: 'viewer' },
            source: items, rows, workspaceRefs: [] };
        expect(projectSessionList(input).items).toEqual([items[0]]);
        expect(projectSessionList({ ...input, viewer: { serverId: 'home-a', accountId: 'other' } }).items).toEqual([items[1]]);
        expect(projectSessionList({ ...input, project: { ...input.project, serverId: 'home-b' } }).items).toEqual([]);
        expect(projectSessionList({ ...input, source: [] }).items).toEqual([]);
        expect(projectSessionList({ ...input, viewer: null }).items).toEqual([]);
    });
});
