import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, teamInvitationRowFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useTeamInvitations } = await import('./useTeamInvitations');

beforeEach(async () => {
    await harness.reset();
});

describe('useTeamInvitations', () => {
    it('withdraws an obsolete Ask-first invitation read when its filter is replaced', async () => {
        const serverId = await harness.addHome({ name: 'Invitations', serverUrl: 'https://invitation-demand.example.test', accountId: 'account-a', teamsEnabled: true });
        const path = '/v1/teams/invitations/list';
        await harness.requireUiApproval(serverId, 'teams.invitations.list');
        harness.answer(serverId, path, { body: { items: [], nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' } });
        const rendered = await renderHook((props: Readonly<{ state: 'active' | 'revoked' }>) => useTeamInvitations({
            scope: { serverId, accountId: 'account-a' }, address: { serverId, teamId: 'team-1' }, state: props.state, enabled: true,
        }), { initialProps: { state: 'active' } });
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list().length).toBe(1));
        const obsolete = harness.artifacts(serverId).list()[0]!;
        await rendered.rerender({ state: 'revoked' });
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list().length).toBe(2));
        await act(async () => { await decideApprovalAsInbox(serverId, obsolete.id, 'approve'); });
        expect(harness.requestsFor(path)).toHaveLength(0);
        await act(async () => { await decideApprovalAsInbox(serverId, harness.artifacts(serverId).list()[1]!.id, 'approve'); });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().status).toBe('ready'));
        expect(harness.requestsFor(path).map(request => request.input)).toEqual([expect.objectContaining({ state: 'revoked' })]);
        await rendered.unmount();
    });

    it('retains 400 admitted invitation identities across a full reread while independently merging delivery changes', async () => {
        const serverId = await harness.addHome({ name: 'Invitations', serverUrl: 'https://invitation-admission.example.test', accountId: 'account-a', teamsEnabled: true });
        const path = '/v1/teams/invitations/list';
        let rows = Array.from({ length: 400 }, (_, index) => teamInvitationRowFixture({ id: `invitation-${index}` }));
        let emailDelivery: 'available' | 'unavailable' = 'available';
        harness.answer(serverId, path, { select: body => {
            const cursor = typeof body === 'object' && body !== null && 'cursor' in body ? body.cursor : null;
            const start = typeof cursor === 'string' ? Number(cursor) : 0;
            return { body: { items: rows.slice(start, start + 50), nextCursor: start + 50 < rows.length ? String(start + 50) : null,
                emailDelivery, linkDelivery: 'available' } };
        } });
        const rendered = await renderHook(() => useTeamInvitations({ scope: { serverId, accountId: 'account-a' },
            address: { serverId, teamId: 'team-1' }, state: null, enabled: true }));
        await vi.waitFor(() => expect(rendered.getCurrent().status).toBe('ready'));
        for (let page = 1; page < 8; page += 1) await act(async () => { await rendered.getCurrent().loadMore(); });
        const admitted = rendered.getCurrent().rows;
        expect(admitted).toHaveLength(400);
        expect(harness.requestsFor(path)).toHaveLength(8);
        emailDelivery = 'unavailable';
        await act(async () => { await rendered.getCurrent().reload(); });
        expect(rendered.getCurrent().emailDelivery).toBe('unavailable');
        expect(rendered.getCurrent().linkDelivery).toBe('available');
        expect(rendered.getCurrent().rows).toBe(admitted);
        expect(harness.requestsFor(path)).toHaveLength(16);
        rows = rows.map((row, index) => index === 250 ? { ...row, role: 'admin' as const } : row);
        await act(async () => { await rendered.getCurrent().reload(); });
        expect(rendered.getCurrent().rows.filter((row, index) => row !== admitted[index])).toHaveLength(1);
        expect(rendered.getCurrent().rows[250]?.role).toBe('admin');
        expect(harness.requestsFor(path)).toHaveLength(24);
        await rendered.unmount();
    });

    it('does not let a superseded Home answer replace the current delivery capability', async () => {
        let releaseFirst!: () => void;
        const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const homeA = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-a', teamsEnabled: true });
        const homeB = await harness.addHome({ name: 'Home B', serverUrl: 'https://home-b.example', accountId: 'account-b', teamsEnabled: true });
        const path = '/v1/teams/invitations/list';
        harness.answer(homeA, path, {
            respondAfter: first,
            body: { items: [], nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' },
        });
        harness.answer(homeB, path, {
            body: { items: [], nextCursor: null, emailDelivery: 'unavailable', linkDelivery: 'unavailable' },
        });

        const rendered = await renderHook(
            (props: Readonly<{ serverId: string; accountId: string }>) => useTeamInvitations({
                scope: { serverId: props.serverId, accountId: props.accountId },
                address: { serverId: props.serverId, teamId: 'team-1' },
                state: null,
                enabled: true,
            }),
            { initialProps: { serverId: homeA, accountId: 'account-a' } },
        );

        await vi.waitFor(() => expect(harness.requestsFor(path).some((request) => request.serverId === homeA)).toBe(true));
        await rendered.rerender({ serverId: homeB, accountId: 'account-b' });
        await vi.waitFor(() => expect(rendered.getCurrent().emailDelivery).toBe('unavailable'));

        await act(async () => {
            releaseFirst();
        });

        expect(rendered.getCurrent().emailDelivery).toBe('unavailable');
        expect(rendered.getCurrent().linkDelivery).toBe('unavailable');
        expect(harness.requestsFor(path).map((request) => request.serverId)).toEqual([homeA, homeB]);
        await rendered.unmount();
    });
});
