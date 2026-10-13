import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SessionViewerControllerProvider } from '@/components/sessions/viewer/SessionViewerControllerProvider';

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
        },
        machineListByServerId: { server_1: [createMachineFixture()] },
    });
    return createStorageModuleStub({ storage, getStorage: () => storage });
});

// The Action front door is the network boundary: the mounted viewer owner still builds the request.
const frontDoor = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => async (...args: unknown[]) => {
        frontDoor.calls.push(args);
        return { ok: true, result: {} };
    },
}));

import { SessionHeaderComputerButton } from './SessionHeaderComputerButton';

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
        frontDoor.calls = [];
    });

    it('opens the Session viewer on Computer through the mounted presentation owner', async () => {
        const screen = await renderScreen(mounted());
        await screen.pressByTestIdAsync(TEST_ID);

        expect(frontDoor.calls).toHaveLength(1);
        const [actionId, input, context] = frontDoor.calls[0] as [string, unknown, Record<string, unknown>];
        expect(actionId).toBe('session.presentation.apply');
        expect(input).toEqual({ intent: { kind: 'viewer.open', source: 'computer' } });
        expect(context).toMatchObject({ serverId: 'server_1', defaultSessionId: 'session_1' });
    });

    it('is absent on a phone, where Watch opens from the transcript and the presence strip', async () => {
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
});
