import { vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

type WorkspaceFileDetailsModuleFactory = () => unknown | Promise<unknown>;

type InstallWorkspaceFileDetailsCommonModuleMocksOptions = Readonly<{
    modal?: WorkspaceFileDetailsModuleFactory;
    reactNative?: WorkspaceFileDetailsModuleFactory;
    text?: WorkspaceFileDetailsModuleFactory;
}>;

const workspaceFileDetailsModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as WorkspaceFileDetailsModuleFactory | undefined,
        reactNative: undefined as WorkspaceFileDetailsModuleFactory | undefined,
        text: undefined as WorkspaceFileDetailsModuleFactory | undefined,
    },
}));

const workspaceFileDetailsActionBoundary = vi.hoisted(() => ({
    read: vi.fn(),
    calls: [] as unknown[],
}));

export function getWorkspaceFileDetailsActionBoundary() {
    return workspaceFileDetailsActionBoundary;
}

const workspaceFileDetailsHomes = createHomeGovernanceHarness();

export function installWorkspaceFileDetailsActionBoundary() {
    installHomeGovernanceBoundaries(workspaceFileDetailsHomes);
    installDisconnectedServerSocketBoundary();
    vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
        callGuardedMachineRpcWithPolicy: async (request: unknown) => {
            workspaceFileDetailsActionBoundary.calls.push(request);
            return await workspaceFileDetailsActionBoundary.read(request);
        },
    }));
}

export async function prepareWorkspaceFileDetailsActionBoundary(): Promise<string> {
    await workspaceFileDetailsHomes.reset();
    await loadSyncSingletonForTests();
    const serverId = await workspaceFileDetailsHomes.addHome({
        name: 'File details Home',
        serverUrl: 'https://workspace-file-details.test',
        accountId: 'account-a',
    });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({
        token: workspaceFileDetailsHomes.findByServerUrl('https://workspace-file-details.test')!.token!,
    });
    workspaceFileDetailsActionBoundary.calls.length = 0;
    return serverId;
}

export async function cleanupWorkspaceFileDetailsActionBoundary(): Promise<void> {
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    await workspaceFileDetailsHomes.reset();
}

export function installWorkspaceFileDetailsCommonModuleMocks(
    options: InstallWorkspaceFileDetailsCommonModuleMocksOptions = {},
) {
    workspaceFileDetailsModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = workspaceFileDetailsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = workspaceFileDetailsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });
}
