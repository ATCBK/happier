import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

import { useOptionalSessionViewerController, type SessionViewerController } from './SessionViewerController';
import { SessionViewerScope } from './SessionViewerScope';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/utils/platform/responsive', () => ({ useDeviceType: () => 'desktop' }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const storage = createStorageStoreMock({
        sessions: {
            session_online: createSessionFixture({ id: 'session_online', serverId: 'server_1' }),
            session_offline: createSessionFixture({ id: 'session_offline', serverId: 'server_1', metadata: { path: '/work', host: 'h', machineId: 'machine-off' } }),
            session_nomachine: createSessionFixture({ id: 'session_nomachine', serverId: 'server_1', metadata: { path: '/work', host: 'h' } }),
        },
        machineListByServerId: { server_1: [createMachineFixture(), createMachineFixture({ id: 'machine-off', active: false })] },
    });
    return createStorageModuleStub({ storage, getStorage: () => storage });
});

let controller: SessionViewerController | null = null;
function Probe() {
    controller = useOptionalSessionViewerController();
    return null;
}

async function mount(sessionId: string) {
    await renderScreen(
        <AppPaneProvider>
            <SessionViewerScope sessionId={sessionId} serverId="server_1"><Probe /></SessionViewerScope>
        </AppPaneProvider>,
    );
}

describe('SessionViewerScope presentable sources', () => {
    beforeEach(() => { controller = null; });

    it('presents the Computer while the Session\'s Machine is unreachable, but not the Browser', async () => {
        await mount('session_offline');
        expect(controller?.canPresentSource('computer')).toBe(true);
        expect(controller?.canPresentSource('browser')).toBe(false);
    });

    it('presents both sources on a reachable Machine and neither for a Session with no Machine', async () => {
        await mount('session_online');
        expect(controller?.canPresentSource('computer')).toBe(true);
        expect(controller?.canPresentSource('browser')).toBe(true);

        await mount('session_nomachine');
        expect(controller?.canPresentSource('computer')).toBe(false);
        expect(controller?.canPresentSource('browser')).toBe(false);
    });
});
