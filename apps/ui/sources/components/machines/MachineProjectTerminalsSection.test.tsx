import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { MachineProjectTerminalsSection } from './MachineProjectTerminalsSection';
const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => { const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router'); return createExpoRouterMock({ router: { push } }).module; });
vi.mock('react-native', async () => { const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative'); return createReactNativeWebMock(); });
vi.mock('react-native-unistyles', async () => { const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles'); return createUnistylesMock(); });
describe('Machine to admitted Project terminal', () => {
    it('offers only this requester’s accepted roots on the qualified Machine and opens the canonical Project terminal surface', async () => {
        const serverId = 'srv_machine_project_terminal';
        const accepted = { id: 'accepted', machineId: 'machine', rootPath: '/admitted', serverId, createdAtMs: 1 };
        const workspaceRefs = [accepted, { ...accepted, id: 'elsewhere', machineId: 'other-machine' },
            { ...accepted, id: 'other-home', serverId: 'another-home' }];
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-project-terminal.test',
            serverIdentityId: serverId, accountId: 'bob' }],
            // Real Sync owns the admitted Project census and its readiness.
            route: request => request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
                ? Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs })) : undefined });
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            expect(home.homes.machine!.id).toBe(serverId);
            await waitForHomeGovernance(() => expect(storage.getState().projectAccountRows).toMatchObject({
                scope: { serverId, accountId: 'bob' }, status: 'ready', coverage: 'complete', workspaceRefs }));
            push.mockReset();
            const screen = await renderScreen(<MachineProjectTerminalsSection machineId="machine" serverId={serverId} />);
            expect(screen.findByTestId('machine-project-terminal-elsewhere')).toBeNull();
            expect(screen.findByTestId('machine-project-terminal-other-home')).toBeNull();
            await screen.pressByTestIdAsync('machine-project-terminal-accepted');
            const route = new URL(push.mock.calls[0][0], 'https://happier.test');
            expect(route.pathname).toBe('/projects/accepted/overview');
            expect(route.searchParams.get('mobileSurface')).toBe('terminal');
            expect(route.searchParams.get('serverId')).toBe(serverId);
            await screen.unmount();
        } finally { await home.dispose(); }
    });
});
