import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useTeamInvitations } = await import('./useTeamInvitations');

beforeEach(async () => {
    await harness.reset();
});

describe('useTeamInvitations', () => {
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
