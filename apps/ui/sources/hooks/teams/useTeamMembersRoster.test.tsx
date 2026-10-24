import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';

import { createDeferred, renderHook, standardCleanup, teamMembershipFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { useTeamMembersRoster } = await import('./useTeamMembersRoster');
const { refreshTeamMembers, resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { getTeamMembersSnapshot, resetTeamsSnapshotsForTests, teamMembersQueryKey } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { useSessionAccessDirectory } = await import('@/components/sessions/access/useSessionAccessDirectory');

beforeEach(async () => {
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
});
afterEach(async () => {
    standardCleanup();
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
});

async function setupRoster() {
    const serverId = await home.addHome({ name: 'Roster Home', serverUrl: 'https://roster-demand.example.test',
        accountId: 'account-ada', teamsEnabled: true });
    const scope = { serverId, accountId: 'account-ada' };
    const address = { serverId, teamId: 'team-1' };
    const path = bindHomeDomainActionHttpRequestV1('teams.members.list', { v: 1, teamId: address.teamId, filter: 'all' }).path;
    const rows = [teamMembershipFixture({ id: 'member-1' }), teamMembershipFixture({ id: 'member-2' })];
    const input = { scope, address, filter: 'all', enabled: true } as const;
    return { serverId, scope, address, path, rows, input };
}

describe('Team member roster demand', () => {
    it('releases an obsolete Ask-first read so reobservation needs only its own approval', async () => {
        const { serverId, scope, address, path, rows, input } = await setupRoster();
        await home.requireUiApproval(serverId, 'teams.members.list');
        home.answer(serverId, path, { body: { items: rows, nextCursor: null } });
        const first = await renderHook(() => useTeamMembersRoster(input));
        await waitForHomeGovernance(() => expect(home.artifacts(serverId).list().length).toBe(1));
        expect(home.requestsFor(path)).toHaveLength(0);
        await first.unmount();
        const second = await renderHook(() => useTeamMembersRoster(input));
        await waitForHomeGovernance(() => expect(home.artifacts(serverId).list().length).toBe(2));
        expect(home.requestsFor(path)).toHaveLength(0);
        const current = home.artifacts(serverId).list()[1]!;
        await act(async () => { await decideApprovalAsInbox(serverId, current.id, 'approve'); });
        await waitForHomeGovernance(() => expect(second.getCurrent().rows).toEqual(rows));
        expect(getTeamMembersSnapshot(scope, address, teamMembersQueryKey('all'))?.stale).toBe(false);
        expect(home.requestsFor(path)).toHaveLength(1);
        await second.unmount();
    });

    it('keeps a shared Ask-first read alive until its last observer leaves', async () => {
        const { serverId, path, rows, input } = await setupRoster();
        await home.requireUiApproval(serverId, 'teams.members.list');
        home.answer(serverId, path, { body: { items: rows, nextCursor: null } });
        const first = await renderHook(() => useTeamMembersRoster(input));
        const second = await renderHook(() => useTeamMembersRoster(input));
        await waitForHomeGovernance(() => expect(home.artifacts(serverId).list().length).toBe(1));
        await first.unmount();
        await act(async () => { await decideApprovalAsInbox(serverId, home.artifacts(serverId).list()[0]!.id, 'approve'); });
        await waitForHomeGovernance(() => expect(second.getCurrent().rows).toEqual(rows));
        expect(home.requestsFor(path)).toHaveLength(1);
        expect(home.artifacts(serverId).list().length).toBe(1);
        await second.unmount();
    });

    it.each(['last observer leaves', 'query changes'] as const)('stops an abandoned multi-page refresh when the %s', async retirement => {
        const { serverId, scope, address, path, input } = await setupRoster();
        const rows = Array.from({ length: 150 }, (_, index) => teamMembershipFixture({ id: `member-${index}`, accountId: `account-${index}` }));
        const held = createDeferred<void>();
        let refreshing = false;
        home.answer(serverId, path, { select: body => {
            const request = body as { cursor?: string; query?: string };
            if (request.query === 'new') return { body: { items: [], nextCursor: null } };
            const start = Number(request.cursor ?? 0);
            return { body: { items: rows.slice(start, start + 50), nextCursor: start < 100 ? String(start + 50) : null },
                ...(refreshing && start === 0 ? { respondAfter: held.promise } : {}) };
        } });
        const list = await renderHook(({ query }) => useTeamMembersRoster({ ...input, query }), { initialProps: { query: 'old' } });
        await waitForHomeGovernance(() => expect(list.getCurrent().status).toBe('ready'));
        await act(async () => { await list.getCurrent().loadMore(); await list.getCurrent().loadMore(); });
        expect(list.getCurrent().rows).toHaveLength(150);
        expect(home.requestsFor(path)).toHaveLength(3);
        refreshing = true;
        let reload!: Promise<void>;
        await act(async () => { reload = list.getCurrent().reload(); });
        await waitForHomeGovernance(() => expect(home.requestsFor(path)).toHaveLength(4));
        if (retirement === 'last observer leaves') await list.unmount();
        else {
            await list.rerender({ query: 'new' });
            await waitForHomeGovernance(() => expect(list.getCurrent().status).toBe('ready'));
        }
        expect(getTeamMembersSnapshot(scope, address, teamMembersQueryKey('all', 'old'))).toBeNull();
        await act(async () => { held.resolve(); await reload; });
        expect(home.requestsFor(path).filter(request => (request.input as { query?: string }).query === 'old')).toHaveLength(4);
        expect(getTeamMembersSnapshot(scope, address, teamMembersQueryKey('all', 'old'))).toBeNull();
        if (retirement === 'query changes') expect(list.getCurrent().rows).toEqual([]);
    });

    it('pages the access-directory member lookup on its exact queried sequence through the real roster owner', async () => {
        const { serverId, path, input } = await setupRoster();
        const members = [7, 8].map(index => teamMembershipFixture({ id: `membership-${index}`, accountId: `account-${index}` }));
        home.answer(serverId, path, { select: body => {
            const request = body as { query?: string; cursor?: string };
            if (request.query !== 'Seventh') return { body: { items: [], nextCursor: null } };
            return { body: { items: [members[request.cursor ? 1 : 0]], nextCursor: request.cursor ? null : 'member-page-2' } };
        } });
        const directory = await renderHook(() => useSessionAccessDirectory({ scope: input.scope,
            teamAddress: input.address, availability: 'available', contextTeams: [], operations: {},
            revision: 1, enabled: true, principalKinds: ['account'] }));
        const people = () => directory.getCurrent().sections.find(section => section.kind === 'account')!;
        await act(async () => { await people().resolveCandidates!('Seventh', new AbortController().signal); });
        await waitForHomeGovernance(() => expect(people().hasMore).toBe(true));
        expect(home.requestsFor(path).at(-1)?.input).toMatchObject({ query: 'Seventh', filter: 'all' });
        await act(async () => { directory.getCurrent().loadMore('account'); });
        await waitForHomeGovernance(() => expect(people().hasMore).toBe(false));
        expect(home.requestsFor(path).at(-1)?.input).toMatchObject({ query: 'Seventh', cursor: 'member-page-2' });
        const candidates = await people().resolveCandidates!('Seventh', new AbortController().signal);
        expect(candidates.map(row => row.principal.ref)).toEqual([
            { kind: 'account', accountId: 'account-7' }, { kind: 'account', accountId: 'account-8' },
        ]);
    });

    it('owes a post-change read for an explicit reload during acquisition, but coalesces same-turn settled reloads', async () => {
        const { serverId, path, rows, input } = await setupRoster();
        const held = createDeferred<void>();
        home.answer(serverId, path, { body: { items: [rows[0]], nextCursor: null }, respondAfter: held.promise });
        const list = await renderHook(() => useTeamMembersRoster(input));
        await waitForHomeGovernance(() => expect(home.requestsFor(path)).toHaveLength(1));
        home.answer(serverId, path, { body: { items: [rows[1]], nextCursor: null } });
        let reload!: Promise<void>;
        await act(async () => { reload = list.getCurrent().reload(); });
        await act(async () => { held.resolve(); await reload; });
        expect(home.requestsFor(path)).toHaveLength(2);
        expect(list.getCurrent().rows.map(row => row.id)).toEqual(['member-2']);
        await act(async () => { await Promise.all([list.getCurrent().reload(), list.getCurrent().reload()]); });
        expect(home.requestsFor(path)).toHaveLength(3);
        expect(list.getCurrent().status).toBe('ready');
    });

    it('shares the admitted roster across the index and retained rail, including paging and revalidation', async () => {
        const fixture = await setupRoster();
        const { serverId, path, rows, input } = fixture;
        home.answer(serverId, path, { select: body => {
            const cursor = body && typeof body === 'object' && 'cursor' in body ? body.cursor : null;
            return { body: { items: cursor ? [rows[1]] : [rows[0]], nextCursor: cursor ? null : 'page-2' } };
        } });
        const index = await renderHook(() => useTeamMembersRoster(input));
        await waitForHomeGovernance(() => expect(index.getCurrent().status).toBe('ready'));
        const rail = await renderHook(() => useTeamMembersRoster({ ...input, scope: { ...input.scope }, address: { ...input.address } }));
        await waitForHomeGovernance(() => expect(rail.getCurrent().status).toBe('ready'));
        expect(home.requestsFor(path)).toHaveLength(1);
        expect(rail.getCurrent().rows).toBe(index.getCurrent().rows);
        await index.unmount();
        await rail.rerender();
        expect(home.requestsFor(path)).toHaveLength(1);
        await act(async () => { await Promise.all([rail.getCurrent().loadMore(), rail.getCurrent().loadMore()]); });
        expect(rail.getCurrent().rows.map(row => row.id)).toEqual(['member-1', 'member-2']);
        expect(home.requestsFor(path)).toHaveLength(2);
        await act(async () => { publishHomeAccountChange('another-home', [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
        expect(home.requestsFor(path)).toHaveLength(2);
        await act(async () => { publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
        await waitForHomeGovernance(() => expect(home.requestsFor(path)).toHaveLength(4));
        await waitForHomeGovernance(() => expect(rail.getCurrent().status).toBe('ready'));
        expect(rail.getCurrent().rows.map(row => row.id)).toEqual(['member-1', 'member-2']);
    });

    it('retains loaded pages after a transport failure and withdraws them after an authoritative refusal', async () => {
        const { serverId, path, rows, input } = await setupRoster();
        home.answer(serverId, path, { body: { items: rows, nextCursor: 'page-2' } });
        const list = await renderHook(() => useTeamMembersRoster(input));
        await waitForHomeGovernance(() => expect(list.getCurrent().status).toBe('ready'));
        home.answer(serverId, path, { status: 503, body: { error: 'unavailable' } });
        await act(async () => { await list.getCurrent().reload(); });
        expect(list.getCurrent()).toMatchObject({ status: 'error', hasMore: true, rows: [{ id: 'member-1' }, { id: 'member-2' }] });
        home.answer(serverId, path, { status: 403, body: { error: 'forbidden' } });
        await act(async () => { await list.getCurrent().reload(); });
        expect(list.getCurrent()).toMatchObject({ status: 'error', hasMore: false, rows: [], error: { kind: 'forbidden' } });
    });

    it('ignores an older continuation after a refresh replaces the sequence with the same cursor', async () => {
        const { serverId, path, rows, input } = await setupRoster();
        const held = createDeferred<void>();
        let fresh = false;
        home.answer(serverId, path, { select: body => {
            const cursor = body && typeof body === 'object' && 'cursor' in body ? body.cursor : null;
            return cursor ? { body: { items: [rows[1]], nextCursor: null }, respondAfter: held.promise }
                : { body: { items: [fresh ? teamMembershipFixture({ id: 'fresh-member' }) : rows[0]], nextCursor: 'page-2' } };
        } });
        const list = await renderHook(() => useTeamMembersRoster(input));
        await waitForHomeGovernance(() => expect(list.getCurrent().status).toBe('ready'));
        let paging!: Promise<void>;
        await act(async () => { paging = list.getCurrent().loadMore(); });
        await waitForHomeGovernance(() => expect(home.requestsFor(path)).toHaveLength(2));
        fresh = true;
        await act(async () => { await list.getCurrent().reload(); });
        expect(list.getCurrent().rows.map(row => row.id)).toEqual(['fresh-member']);
        await act(async () => { held.resolve(); await paging; });
        expect(list.getCurrent().rows.map(row => row.id)).toEqual(['fresh-member']);
        expect(list.getCurrent().hasMore).toBe(true);
    });

    it('keeps exact lookup sequences separate and never publishes an older answer into the current lookup', async () => {
        const { serverId, path, rows, input } = await setupRoster();
        const held = createDeferred<void>();
        home.answer(serverId, path, { select: body => {
            const query = body && typeof body === 'object' && 'query' in body ? body.query : '';
            return { body: { items: [query === 'Alice' ? rows[0] : rows[1]], nextCursor: null },
                ...(query === 'Alice' ? { respondAfter: held.promise } : {}) };
        } });
        const list = await renderHook(({ query }: { query: string }) => useTeamMembersRoster({ ...input, query }),
            { initialProps: { query: 'Alice' } });
        await waitForHomeGovernance(() => expect(home.requestsFor(path)).toHaveLength(1));
        let oldRead!: Promise<void>;
        await act(async () => { oldRead = refreshTeamMembers(input.scope, input.address, 'all', 'Alice'); });
        await list.rerender({ query: 'Bob' });
        await waitForHomeGovernance(() => expect(list.getCurrent().rows.map(row => row.id)).toEqual(['member-2']));
        expect(getTeamMembersSnapshot(input.scope, input.address, teamMembersQueryKey('all', 'Alice'))).toBeNull();
        await act(async () => { held.resolve(); await oldRead; });
        expect(list.getCurrent().rows.map(row => row.id)).toEqual(['member-2']);
        expect(getTeamMembersSnapshot(input.scope, input.address, teamMembersQueryKey('all', 'Alice'))).toBeNull();
        expect(home.requestsFor(path).map(request => request.input)).toEqual([
            expect.objectContaining({ query: 'Alice' }), expect.objectContaining({ query: 'Bob' }),
        ]);
        await list.unmount();
        expect(getTeamMembersSnapshot(input.scope, input.address, teamMembersQueryKey('all', 'Bob'))).toBeNull();
    });

    it('does not republish retired Account rows when a pending answer and queued retry settle', async () => {
        const { serverId, path, rows, input } = await setupRoster();
        const held = createDeferred<void>();
        home.answer(serverId, path, { body: { items: rows, nextCursor: null }, respondAfter: held.promise });
        const list = await renderHook(() => useTeamMembersRoster(input));
        await waitForHomeGovernance(() => expect(home.requestsFor(path)).toHaveLength(1));
        let oldRead!: Promise<void>;
        await act(async () => { oldRead = list.getCurrent().reload(); });
        await act(async () => { await home.switchAccount(serverId, 'account-grace'); });
        expect(getTeamMembersSnapshot(input.scope, input.address, teamMembersQueryKey('all'))).toBeNull();
        await act(async () => { held.resolve(); await oldRead; });
        expect(list.getCurrent().rows).toEqual([]);
        expect(getTeamMembersSnapshot(input.scope, input.address, teamMembersQueryKey('all'))).toMatchObject({ data: null, status: 'error' });
        expect(home.requestsFor(path)).toHaveLength(1);
    });
});
