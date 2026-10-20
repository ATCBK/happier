import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SessionViewerControllerProvider } from '@/components/sessions/viewer/SessionViewerControllerProvider';
import { SessionViewerControllerScope, type SessionViewerController } from '@/components/sessions/viewer/SessionViewerController';
import { Pressable } from 'react-native';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

let deviceTypeMock: 'phone' | 'tablet' | 'desktop' = 'desktop';
vi.mock('@/utils/platform/responsive', () => ({ useDeviceType: () => deviceTypeMock }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const storage = createStorageStoreMock({
        sessions: {
            session_1: createSessionFixture({ id: 'session_1', serverId: 'server_1' }),
            session_nomachine: createSessionFixture({ id: 'session_nomachine', serverId: 'server_1', metadata: { path: '/work', host: 'h' } }),
            session_offline: createSessionFixture({ id: 'session_offline', serverId: 'server_1', metadata: { path: '/work', host: 'h', machineId: 'machine-off' } }),
        },
        machineListByServerId: { server_1: [createMachineFixture(), createMachineFixture({ id: 'machine-off', active: false })] },
    });
    return createStorageModuleStub({ storage, getStorage: () => storage });
});

import { SessionHeaderComputerButton, useSessionComputerMenuEntry } from './SessionHeaderComputerButton';

const TEST_ID = 'session-header-computer-button';

function mounted(sessionId = 'session_1') {
    return (
        <SessionViewerControllerProvider
            sessionId={sessionId}
            serverId="server_1"
            phone={false}
            canPresentSource={() => true}
            openDocked={() => {}}
        >
            <SessionHeaderComputerButton sessionId={sessionId} serverId="server_1" />
        </SessionViewerControllerProvider>
    );
}

describe('SessionHeaderComputerButton', () => {
    beforeEach(() => {
        deviceTypeMock = 'desktop';
    });

    it('labels the Computer entry for its source', async () => {
        const screen = await renderScreen(mounted());
        expect(screen.findByTestId(TEST_ID)?.props.accessibilityLabel).toBe('computerUse.presentation.sourceComputer');
    });

    it('is absent on a phone, where the session actions menu carries the Computer entry', async () => {
        deviceTypeMock = 'phone';
        const screen = await renderScreen(mounted());
        expect(screen.findByTestId(TEST_ID)).toBeNull();
    });

    it('is absent where no viewer owner is mounted', async () => {
        const screen = await renderScreen(<SessionHeaderComputerButton sessionId="session_1" serverId="server_1" />);
        expect(screen.findByTestId(TEST_ID)).toBeNull();
    });

    it('is absent for a Session with no machine to watch', async () => {
        const screen = await renderScreen(mounted('session_nomachine'));
        expect(screen.findByTestId(TEST_ID)).toBeNull();
    });

    it('stays in the header while the Session\'s Machine is unreachable', async () => {
        const screen = await renderScreen(mounted('session_offline'));
        expect(screen.findByTestId(TEST_ID)).not.toBeNull();
    });
    describe('phone session actions entry', () => {
        const requestSemantic = vi.fn(async () => ({ ok: true as const }));
        const controller = { requestSemantic } as unknown as SessionViewerController;

        function MenuEntryProbe(props: Readonly<{ sessionId: string }>) {
            const open = useSessionComputerMenuEntry({ sessionId: props.sessionId, serverId: 'server_1' });
            return open ? <Pressable testID="menu-entry" onPress={open} /> : null;
        }
        const withController = (sessionId = 'session_1') => (
            <SessionViewerControllerScope controller={controller}><MenuEntryProbe sessionId={sessionId} /></SessionViewerControllerScope>
        );

        beforeEach(() => { requestSemantic.mockClear(); });

        it('opens the session\'s Computer through the one viewer opener on a phone, so a fresh phone can reach it', async () => {
            deviceTypeMock = 'phone';
            const screen = await renderScreen(withController());
            await act(async () => { screen.pressByTestId('menu-entry'); });
            expect(requestSemantic).toHaveBeenCalledWith({ kind: 'viewer.open', source: 'computer' });
        });

        it('stays out of the menu where the header button already is, and where there is nothing to open', async () => {
            deviceTypeMock = 'desktop';
            expect((await renderScreen(withController())).findByTestId('menu-entry')).toBeNull();
            deviceTypeMock = 'phone';
            expect((await renderScreen(withController('session_nomachine'))).findByTestId('menu-entry')).toBeNull();
            expect((await renderScreen(<MenuEntryProbe sessionId="session_1" />)).findByTestId('menu-entry')).toBeNull();
        });
    });
});
