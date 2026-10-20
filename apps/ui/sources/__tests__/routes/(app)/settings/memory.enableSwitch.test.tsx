import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderBaseScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { Switch } from '@/components/ui/forms/Switch';
import {
    createMachineAdministrationTargetSelectionMock,
    installMachineAdministrationTargetSelectionBoundary,
} from '@/dev/testkit/mocks/machineAdministrationTargetSelection';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { machineRpcSpy } = vi.hoisted(() => ({ machineRpcSpy: vi.fn() }));
const featureEnabledState: Record<string, boolean> = { 'memory.search': true };
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
const administrationTargetSelection = vi.hoisted(() => {
    const executionTarget = {
        target: { serverIdentityId: 'srv_1', machineId: 'm1' },
        serverId: 'srv_1',
        machine: { id: 'm1' },
    };
    return {
        selectedTarget: executionTarget.target,
        canExecute: true,
        resolveExecutionTarget: () => executionTarget,
    };
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcSpy,
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => administrationTargetSelection,
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: Record<string, unknown>) => (
        React.createElement('MachineAdministrationTargetSelector', props)
    ),
}));

function installMemorySettingsEntryMocks() {
    installSessionSettingsEntryModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                View: 'View',
                TextInput: 'TextInput',
            });
        },
    });

    // The screen administers the machine chosen through the canonical Machine Administration target;
    // the selection owner's persisted-settings and live-inventory boundary is replaced by the testkit.
    installMachineAdministrationTargetSelectionBoundary(createMachineAdministrationTargetSelectionMock({
        serverId: 'srv_1',
        machines: [{ machineId: 'm1', displayName: 'Machine 1' }],
    }));

    vi.doMock('@/components/ui/lists/Item', () => ({
        Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
    }));
}
installMemorySettingsEntryMocks();
installDisconnectedServerSocketBoundary();

async function renderScreen(element: React.ReactElement) {
    account = await createSecretSettingsTestHarness({ serverIdentityId: 'srv_1', settings: settingsParse({
        experiments: true, featureToggles: { 'memory.search': featureEnabledState['memory.search'] === true },
    }), sharedEnabled: false });
    return renderBaseScreen(element);
}

afterEach(async () => {
    await standardCleanup();
    await account?.dispose();
    account = undefined;
    machineRpcSpy.mockReset();
    featureEnabledState['memory.search'] = true;
    resetSessionSettingsEntryState();
});

describe('Memory settings (enable switch)', () => {

    it('loads daemon.memory.status alongside settings', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return { v: 1, enabled: false };
            }
            if (params?.method === 'daemon.memory.status') {
                return {
                    v: 1,
                    enabled: false,
                    indexMode: 'hints',
                    hintsIndexReady: false,
                    hintsIndexHasContent: false,
                    deepIndexReady: false,
                    deepIndexHasContent: false,
                    activeIndexReady: false,
                    activeIndexSearchable: false,
                    indexContent: null,
                    worker: null,
                    queue: null,
                    lastRun: null,
                    embeddingsEnabled: false,
                    embeddingsMode: 'disabled',
                    embeddingsPresetId: null,
                    embeddingsProviderKind: null,
                    embeddingsModelId: null,
                    embeddingsRuntimeState: 'unavailable',
                    embeddingsUsingFallback: false,
                    tier1DbPath: null,
                    deepDbPath: null,
                    tier1DbBytes: null,
                    deepDbBytes: null,
                };
            }
            return { v: 1 };
        });

        const mod = await import('@/app/(app)/settings/memory');
        const Screen = mod.default;

        await renderScreen(React.createElement(Screen));

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.memory.status',
        }));
    });

    it('does not fetch settings when memory.search is disabled', async () => {
        featureEnabledState['memory.search'] = false;
        machineRpcSpy.mockImplementation(async () => {
            throw new Error('unexpected rpc');
        });

        const mod = await import('@/app/(app)/settings/memory');
        const Screen = mod.default;

        const screen = await renderScreen(React.createElement(Screen));

        const switches = screen.findAllByType(Switch);
        expect(switches).toHaveLength(0);
        expect(machineRpcSpy).not.toHaveBeenCalled();
    });

    it('writes daemon.memory.settings.set when toggling enabled', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return { v: 1, enabled: false };
            }
            if (params?.method === 'daemon.memory.status') {
                return {
                    v: 1,
                    enabled: false,
                    indexMode: 'hints',
                    hintsIndexReady: false,
                    hintsIndexHasContent: false,
                    deepIndexReady: false,
                    deepIndexHasContent: false,
                    activeIndexReady: false,
                    activeIndexSearchable: false,
                    indexContent: null,
                    worker: null,
                    queue: null,
                    lastRun: null,
                    embeddingsEnabled: false,
                    embeddingsMode: 'disabled',
                    embeddingsPresetId: null,
                    embeddingsProviderKind: null,
                    embeddingsModelId: null,
                    embeddingsRuntimeState: 'unavailable',
                    embeddingsUsingFallback: false,
                    tier1DbPath: null,
                    deepDbPath: null,
                    tier1DbBytes: null,
                    deepDbBytes: null,
                };
            }
            if (params?.method === 'daemon.memory.settings.set') {
                return params.payload;
            }
            return { v: 1 };
        });

        const mod = await import('@/app/(app)/settings/memory');
        const Screen = mod.default;

        const screen = await renderScreen(React.createElement(Screen));

        const enabledItem = screen.findAllByType('Item' as any).find((node: any) => node?.props?.subtitle === 'memorySearchSettings.enabled.subtitle');
        expect(enabledItem).toBeTruthy();
        const enabledSwitch = enabledItem!.props.rightElement;
        expect(enabledSwitch).toBeTruthy();
        await act(async () => {
            enabledSwitch.props.onValueChange(true);
        });

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.memory.settings.set',
        }));

        const setCall = machineRpcSpy.mock.calls.find((call) => call?.[0]?.method === 'daemon.memory.settings.set');
        expect(setCall?.[0]?.payload?.enabled).toBe(true);
    });
});
