import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createSessionFixture, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

installSessionSubagentCommonModuleMocks({
    storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const dimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
        return createReactNativeWebMock({
            Dimensions: { get: () => dimensions, addEventListener: () => ({ remove() {} }) },
            useWindowDimensions: () => dimensions,
        });
    },
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/lead' }).module;
});
installDisconnectedServerSocketBoundary();

// Keep the Work producer, launcher, selectors, pane and header publication real.
const { storage } = await import('@/sync/domains/state/storage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
const { PaneHeader } = await import('@/components/appShell/panes/PaneHeader');
const { PaneHeaderActions } = await import('@/components/appShell/panes/PaneHeaderActions');
const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
const { useSessionAgentActivity } = await import('@/hooks/session/useSessionAgentActivity');
const { SessionWorkSourcesProvider, useSessionWorkSourcesOwner } = await import('./sessionWorkSources');
const { SessionWorkView } = await import('./SessionWorkView');

function WorkHeader() {
    const published = usePublishedPaneHeaderContent('work');
    return <PaneHeader size="large" title="Work" line={published?.line} actions={
        <PaneHeaderActions published={published} title="Work" testID="phone-work-header" />
    } />;
}

function WorkHost(props: Readonly<{ serverId: string }>) {
    const activity = useSessionAgentActivity({ sessionId: 'lead', serverId: props.serverId });
    const sources = useSessionWorkSourcesOwner({ sessionId: 'lead', serverId: props.serverId,
        ownerMetadata: storage.getState().sessions.lead?.metadata ?? null, agentActivity: activity });
    return <SessionWorkSourcesProvider value={sources}>
        <AppPaneProvider>
            <PaneHeaderSlotProvider>
                <WorkHeader />
                <PaneHeaderSlotScope slotKey="work">
                    <SurfaceStateSizeProvider size="phone">
                        <SessionWorkView sessionId="lead" serverId={props.serverId} scopeId="session:lead" />
                    </SurfaceStateSizeProvider>
                </PaneHeaderSlotScope>
            </PaneHeaderSlotProvider>
        </AppPaneProvider>
    </SessionWorkSourcesProvider>;
}

afterEach(standardCleanup);

describe('phone Work List → Map', () => {
    it('renders the same qualified children across a cold credential binding and a settled repeat', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://phone-work-map.test', serverIdentityId: 'srv_phone_work_map', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const lead = createSessionFixture({ id: 'lead', serverId });
        const child = createSessionFixture({ id: 'child', serverId, reportsTo: { sessionId: lead.id } });
        const foreign = createSessionFixture({ id: 'foreign', serverId: 'another-home', reportsTo: { sessionId: lead.id } });
        storage.setState({ sessions: { lead, child, foreign }, sessionListRowsByServerId: {} });
        const credentials = createDeferred<void>();
        let pendingReads = 0;
        // Credential storage is an external boundary. Restoration is complete; hold only the
        // mounted consumers' cold reads so the first view switch overlaps their publication.
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async () => {
            pendingReads++;
            await credentials.promise;
            return connection.credentials;
        });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(<WorkHost serverId={serverId} />);
            expect(pendingReads).toBeGreaterThan(0);
            const switchView = async (view: 'list' | 'map') => {
                const tab = screen!.findByTestId(`session-work-view:${view}`);
                expect(tab).not.toBeNull();
                await pressTestInstanceAsync(tab!);
            };
            await switchView('map');
            expect(screen.findHostByTestId('session-work-map-node-session:child')).not.toBeNull();
            expect(screen.findHostByTestId('session-work-map-node-session:foreign')).toBeNull();
            await act(async () => { credentials.resolve(); await credentials.promise; });
            await switchView('list');
            await switchView('map');
            expect(screen.findHostByTestId('session-work-map-node-session:child')).not.toBeNull();
            expect(screen.findHostByTestId('session-work-map-node-session:foreign')).toBeNull();
        } finally {
            credentials.resolve();
            await screen?.unmount();
            storage.setState(initial, true);
            await connection.dispose();
        }
    }, 180_000);
});
