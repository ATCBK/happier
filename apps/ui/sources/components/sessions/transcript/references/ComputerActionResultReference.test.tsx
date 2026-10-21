import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { makeToolCall, renderScreen } from '@/dev/testkit';
import { useSessionComputerMachine } from '@/sync/domains/computer/sessionComputerMachines';
import { ComputerActionResultReference } from './ComputerActionResultReference';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const base = createMachineFixture();
    const machine = createMachineFixture({ id: 'machine-reference', metadata: { ...base.metadata!, displayName: 'Studio laptop', host: 'studio' } });
    const storage = createStorageStoreMock({ machineListByServerId: { 'home-reference': [machine] } });
    return createStorageModuleStub({ storage, getStorage: () => storage });
});

describe('ComputerActionResultReference Machine identity', () => {
    it('publishes the readable Machine name for action references instead of an id or an unnamed hint', async () => {
        let name: string | null | undefined;
        function Probe() {
            name = useSessionComputerMachine('reference-session')?.machineName;
            return null;
        }
        const screen = await renderScreen(<>
            <ComputerActionResultReference sessionId="reference-session" serverId="home-reference" tool={makeToolCall({
                name: 'mcp__happier__action_execute', state: 'running',
                input: { actionId: 'computer.capture', input: { machineId: 'machine-reference' } },
            })} />
            <Probe />
        </>);
        expect(name).toBe('Studio laptop');
        expect(screen.getTextContent()).not.toContain('machine-reference');
    });
});
