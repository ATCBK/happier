import { describe, expect, it } from 'vitest';

import { ScopeActionInputSchemas } from '../../actions/scopeActionFamily.js';
import { canSessionListFilterIncludeRunsV1, matchSessionBotFilterV1, matchSessionProjectFilterV1, matchSessionListFilterV1, normalizeSessionListFilterV1, readSessionListStartedByV1, SessionListFilterV1Schema } from './sessionListFilterV1.js';

describe('SessionListFilterV1', () => {
    it('never uses list attention promotion as proof that a Run matches the selected starter', () => {
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'], startedBy: ['you'] });
        expect(matchSessionListFilterV1(filter, { serverId: 'home', kind: 'run', startedBy: 'triggers', attentionRequired: true })).toBe('miss');
        expect(matchSessionListFilterV1({ ...filter, startedBy: [] }, { serverId: 'home', kind: 'run', startedBy: 'you', attentionRequired: true })).toBe('miss');
        expect(matchSessionListFilterV1({ ...filter, startedBy: ['you', 'you', 'you'] },
            { serverId: 'home', kind: 'run', startedBy: 'triggers', attentionRequired: false })).toBe('miss');
    });
    it('serializes Only coordinators and distinguishes positive, ordinary and unavailable relation facts', () => {
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'], coordinator: 'coordinator' });
        expect(filter).toHaveProperty('coordinator', 'coordinator');
        expect(SessionListFilterV1Schema.parse(JSON.parse(JSON.stringify(filter)))).toEqual(filter);
        expect(ScopeActionInputSchemas['session.list.view.set'].parse({ filters: { coordinator: 'coordinator' } }).filters).toEqual({ coordinator: 'coordinator' });
        const facts = { serverId: 'home', kind: 'session' as const, startedBy: 'you' as const };
        expect(matchSessionListFilterV1(filter, facts)).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, managedSessions: { total: 1 } })).toBe('match');
        expect(matchSessionListFilterV1(filter, { ...facts, receivedRuleCount: 1 })).toBe('match');
        expect(matchSessionListFilterV1(filter, { ...facts, managedSessions: { total: 0 }, receivedRuleCount: 0 })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, managedSessions: { total: 0 } })).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, kind: 'run', receivedRuleCount: 1 })).toBe('miss');
    });
    it('proves Started by me only with immutable none origin and the same owner Account', () => {
        expect(readSessionListStartedByV1({ origin: { kind: 'none' }, ownerAccountId: 'me', viewerAccountId: 'me' })).toBe('you');
        for (const facts of [
            { origin: { kind: 'none' as const }, viewerAccountId: 'me' },
            { ownerAccountId: 'me', viewerAccountId: 'me' },
            { origin: { kind: 'none' as const }, ownerAccountId: 'me' },
        ]) expect(readSessionListStartedByV1(facts)).toBeUndefined();
        const startedBy = readSessionListStartedByV1({ origin: { kind: 'none' }, ownerAccountId: 'other', viewerAccountId: 'me' });
        expect(startedBy).toBe('other_account');
        expect(matchSessionListFilterV1(normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'] }),
            { serverId: 'home', kind: 'session', startedBy })).toBe('miss');
        const automation = readSessionListStartedByV1({ origin: { kind: 'run_step', runId: 'workflow' }, ownerAccountId: 'me', viewerAccountId: 'me' });
        expect(automation).toBe('non_person');
        const match = (selection: ('you' | 'agents' | 'triggers')[]) => matchSessionListFilterV1(normalizeSessionListFilterV1({
            scope: 'all_accessible', homeServerIds: ['home'], startedBy: selection,
        }), { serverId: 'home', kind: 'session', startedBy: automation });
        expect(match(['you'])).toBe('miss');
        expect(match(['agents'])).toBe('unavailable');
    });
    it('round trips qualified include/exclude projects, canonical status and producer-owned subtree selection', () => {
        const filter = normalizeSessionListFilterV1({
            projects: { include: [{ serverId: ' home-a ', projectKey: ' payments ' }, { serverId: 'home-a', projectKey: 'payments' }], exclude: [{ serverId: 'home-b', projectKey: 'payments' }] },
            statuses: ['failed', 'thinking', 'failed'], underSessionId: ' manager ',
        });
        expect(filter).toMatchObject({ projects: { include: [{ serverId: 'home-a', projectKey: 'payments' }], exclude: [{ serverId: 'home-b', projectKey: 'payments' }] }, statuses: ['failed', 'thinking'], underSessionId: 'manager' });
        expect(SessionListFilterV1Schema.parse(JSON.parse(JSON.stringify(filter)))).toEqual(filter);
        expect(SessionListFilterV1Schema.safeParse({ ...filter, statuses: ['done'] }).success).toBe(false);
        expect(ScopeActionInputSchemas['session.list.view.set'].parse({ filters: { projects: filter.projects, statuses: ['failed'], underSessionId: 'manager' } }).filters).toMatchObject({ statuses: ['failed'], underSessionId: 'manager' });
    });

    it('uses one authorized tri-state predicate and never treats unavailable projects as satisfying exclusions', () => {
        const project = { serverId: 'home-a', projectKey: 'payments' };
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home-a'], projects: { include: [], exclude: [project] }, statuses: ['failed'] });
        const facts = { serverId: 'home-a', kind: 'session' as const, startedBy: 'you' as const, source: 'persisted' as const, status: 'failed' as const };
        expect(matchSessionListFilterV1(filter, { ...facts, metadata: null })).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, metadata: { projectId: 'payments' } })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, metadata: { projectId: 'other' } })).toBe('match');
        expect(matchSessionListFilterV1(filter, { ...facts, metadata: { projectId: 'other' }, status: undefined })).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, serverId: 'home-b', metadata: null })).toBe('miss');
        const under = normalizeSessionListFilterV1({ ...filter, projects: undefined, underSessionId: 'manager' });
        expect(matchSessionListFilterV1(under, facts)).toBe('unavailable');
        expect(matchSessionListFilterV1(under, { ...facts, underSessionMatches: true })).toBe('match');
        expect(matchSessionListFilterV1(under, { ...facts, underSessionMatches: false })).toBe('miss');
    });

    it('requires producer evidence for scope and qualified facets and keeps person-started sessions distinct from agent work', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home-a'], scope: 'following', attention: 'needs_my_attention',
            audiences: [{ serverId: 'home-a', kind: 'group', teamId: 'team', groupId: 'group' }], tagIds: [{ serverId: 'home-a', tagId: 'urgent' }], source: 'persisted' });
        const facts = { serverId: 'home-a', kind: 'session' as const, startedBy: 'you' as const, attentionRequired: true,
            scopeMatches: { following: true }, audiences: [{ kind: 'group' as const, teamId: 'team', groupId: 'group' }], tagIds: ['urgent'], source: 'persisted' as const };
        expect(matchSessionListFilterV1(filter, facts)).toBe('match');
        expect(matchSessionListFilterV1(filter, { ...facts, scopeMatches: undefined })).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, audiences: undefined })).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, audiences: [{ kind: 'team', teamId: 'team' }] })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, tagIds: ['other'] })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, startedBy: 'agents' })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, source: undefined })).toBe('unavailable');
    });
    it('matches only a qualified explicit Project or uniquely accepted checkout, never repository/path groups', () => {
        const project = { serverId: 'home-a', projectKey: 'anchor' };
        const refs = [{ id: 'checkout', serverId: 'home-a', projectKey: 'anchor', machineId: 'machine', rootPath: 'C:\\repo', createdAtMs: 1 }];
        const match = (metadata: unknown, serverId = 'home-a') => matchSessionProjectFilterV1(metadata, serverId, project, refs);
        expect(match({ projectId: 'anchor' })).toBe('match');
        expect(match({ projectId: 'anchor' }, 'home-b')).toBe('miss');
        expect(match({ projectId: 'other', workspaceId: 'checkout' })).toBe('miss');
        expect(match({ workspaceId: 'checkout' })).toBe('match');
        expect(match({ machineId: 'machine', path: 'c:/repo/' })).toBe('match');
        expect(match({ machineId: 'machine', path: 'c:/repo/child' })).toBe('miss');
        expect(match({ machineId: 'foreign', path: 'c:/repo' })).toBe('miss');
        expect(match(null)).toBe('unavailable');
        expect(matchSessionProjectFilterV1({ workspaceId: 'checkout' }, 'home-a', project)).toBe('unavailable');
        expect(match({ projectId: '', workspaceId: 'checkout' })).toBe('unavailable');
        expect(matchSessionProjectFilterV1({ workspaceId: 'checkout' }, 'home-a', project, [...refs, { ...refs[0]!, projectKey: 'other' }])).toBe('unavailable');
    });
    it('matches Bot identity only from authorized canonical metadata and distinguishes unavailable metadata', () => {
        expect(matchSessionBotFilterV1({ bot: { kind: 'bot', future: true } }, 'bot')).toBe('match');
        expect(matchSessionBotFilterV1({ title: 'Bot', tag: 'bot', pinned: true }, 'bot')).toBe('miss');
        expect(matchSessionBotFilterV1({}, 'ordinary')).toBe('match');
        for (const bot of [{ kind: 'ordinary' }, null]) {
            expect(matchSessionBotFilterV1({ bot }, 'ordinary')).toBe('unavailable');
            expect(matchSessionBotFilterV1({ bot }, 'bot')).toBe('unavailable');
        }
        expect(matchSessionBotFilterV1({ bot: { kind: 'bot' } }, 'ordinary')).toBe('miss');
        expect(matchSessionBotFilterV1(null, 'ordinary')).toBe('unavailable');
        expect(matchSessionBotFilterV1(undefined, 'bot')).toBe('unavailable');
        expect(matchSessionBotFilterV1(null)).toBe('match');
    });
    it('retains an optional Bot facet without changing an unset selection', () => {
        expect(normalizeSessionListFilterV1()).not.toHaveProperty('bot');
        for (const bot of ['bot', 'ordinary'] as const) {
            expect(SessionListFilterV1Schema.parse({ ...normalizeSessionListFilterV1(), bot }).bot).toBe(bot);
            expect(ScopeActionInputSchemas['session.list.view.set'].parse({ filters: { bot } }).filters).toEqual({ bot });
        }
        expect(SessionListFilterV1Schema.safeParse({ ...normalizeSessionListFilterV1(), bot: 'pinned' }).success).toBe(false);
    });
    it('defaults to sessions and runs you started', () => {
        expect(normalizeSessionListFilterV1()).toMatchObject({ show: 'both', startedBy: ['you'] });
    });

    it('normalizes started-by selections without replacing an explicit empty selection', () => {
        expect(normalizeSessionListFilterV1({ show: 'runs', startedBy: ['agents', 'triggers', 'agents'] }))
            .toMatchObject({ show: 'runs', startedBy: ['agents', 'triggers'] });
        expect(normalizeSessionListFilterV1({ startedBy: [] }).startedBy).toEqual([]);
    });

    it('requires the current closed filter shape and rejects unknown run facets', () => {
        expect(SessionListFilterV1Schema.safeParse({
            scope: 'my_work', attention: 'any', source: 'all', homeServerIds: [], audiences: [], tagIds: [],
        }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({ ...normalizeSessionListFilterV1(), show: 'everything' }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({ ...normalizeSessionListFilterV1(), startedBy: ['host'] }).success).toBe(false);
    });

    it('does not reset run facets when an Action patches another filter facet', () => {
        expect(ScopeActionInputSchemas['session.list.view.set'].parse({
            filters: { scope: 'all_accessible' },
        }).filters).toEqual({ scope: 'all_accessible' });
    });

    it('normalizes qualified selections without collapsing identities from different Homes', () => {
        const normalized = normalizeSessionListFilterV1({
            scope: 'all_accessible',
            homeServerIds: [' home-b ', '', 'home-a', 'home-b'],
            audiences: [
                { serverId: ' home-a ', kind: 'team', teamId: ' team-a ' },
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'team', teamId: 'team-a' },
                { serverId: '', kind: 'outside_teams' },
                { serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: ' group-a ' },
            ],
            tagIds: [
                { serverId: 'home-b', tagId: ' urgent ' },
                { serverId: 'home-b', tagId: 'urgent' },
                { serverId: 'home-a', tagId: 'urgent' },
                { serverId: 'home-a', tagId: '' },
            ],
        });
        expect(normalized).toEqual({
            scope: 'all_accessible', attention: 'any', source: 'all', show: 'both', startedBy: ['you'],
            homeServerIds: ['home-b', 'home-a'],
            audiences: [
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: 'group-a' },
            ],
            tagIds: [{ serverId: 'home-b', tagId: 'urgent' }, { serverId: 'home-a', tagId: 'urgent' }],
        });
        expect(normalizeSessionListFilterV1(normalized)).toEqual(normalized);
    });

    it('parses the serializable schema and delegates normalization to the same owner', () => {
        const filters = { ...normalizeSessionListFilterV1(), homeServerIds: [' home-a ', 'home-a'] };
        expect(SessionListFilterV1Schema.parse(JSON.parse(JSON.stringify(filters))))
            .toEqual({ ...normalizeSessionListFilterV1(), homeServerIds: ['home-a'] });
    });

    it('rejects UI-only state and unknown selection fields at the serializable boundary', () => {
        const filters = normalizeSessionListFilterV1();
        expect(SessionListFilterV1Schema.safeParse({ ...filters, searchQuery: 'draft search' }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({
            ...filters, audiences: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a', access: 'admin' }],
        }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({ ...filters, source: 'unknown' }).success).toBe(false);
    });

    it('treats Project and status as Session facts, so they select no Runs instead of an unavailable Run corpus', () => {
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'], startedBy: ['you', 'agents', 'triggers'], show: 'both' });
        const run = { serverId: 'home', kind: 'run' as const, startedBy: 'you' as const, attentionRequired: false };
        expect(canSessionListFilterIncludeRunsV1(filter)).toBe(true);
        expect(matchSessionListFilterV1(filter, run)).toBe('match');
        const failing = { ...filter, statuses: ['failed' as const] };
        const inPayments = { ...filter, projects: { include: [{ serverId: 'home', projectKey: 'payments' }], exclude: [] } };
        for (const sessionOnly of [failing, inPayments]) {
            expect(canSessionListFilterIncludeRunsV1(sessionOnly)).toBe(false);
            expect(matchSessionListFilterV1(sessionOnly, run)).toBe('miss');
        }
        // An emptied facet narrows nothing and keeps Runs in the corpus.
        expect(canSessionListFilterIncludeRunsV1({ ...filter, statuses: [], projects: { include: [], exclude: [] } })).toBe(true);
    });
});
