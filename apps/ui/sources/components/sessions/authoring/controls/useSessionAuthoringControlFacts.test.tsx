import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';

const capabilityState = vi.hoisted(() => ({
    value: { status: 'idle' } as Record<string, unknown>,
}));

vi.mock('@/hooks/server/useDaemonScopedMachineCapabilitiesCache', () => ({
    useDaemonScopedMachineCapabilitiesCache: () => ({ state: capabilityState.value, refresh: vi.fn() }),
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({ phase: 'loading' }),
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => false }));
// The Account's profile read is the network boundary: a cold open waits on it.
vi.mock('@/sync/api/account/apiProfileCatalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/api/account/apiProfileCatalog')>()),
    readProfileCatalogProjection: () => new Promise(() => {}),
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return { ...createTextModuleMock({ translate: (key) => key }), getPreferredLanguage: () => 'en' };
});

let previous = getStorage().getState();
beforeEach(() => {
    previous = getStorage().getState();
    capabilityState.value = { status: 'idle' };
    const windows = createMachineFixture({ id: 'machine-1' });
    const selected = { ...windows, metadata: { ...windows.metadata!, platform: 'win32', host: 'windows.test' } };
    const otherHome = { ...selected, metadata: { ...selected.metadata, platform: 'linux', host: 'linux.test' } };
    // The exact Home owns this Machine. The focused map deliberately has a
    // same-id row from another Home, so an unscoped fallback cannot pass.
    getStorage().setState({ settingsScope: null, machines: { [otherHome.id]: otherHome },
        machineListByServerId: { 'server-1': [selected], 'server-2': [otherHome] },
        machineListStatusByServerId: { 'server-1': 'idle', 'server-2': 'idle' } });
});
afterEach(async () => {
    await standardCleanup();
    getStorage().setState(previous);
});

describe('useSessionAuthoringControlFacts', () => {
    it('projects the incumbent New Session Windows Terminal capability and fails closed without it', async () => {
        const { useSessionAuthoringControlFacts } = await import('./useSessionAuthoringControlFacts');
        const hook = await renderHook(() => useSessionAuthoringControlFacts({
            machineId: 'machine-1',
            serverId: 'server-1',
            directory: 'C:\\repo',
        }));

        expect(hook.getCurrent().windowsTerminalAvailable).toBe(false);
        expect(hook.getCurrent().machineName).toBe('windows.test');
        expect(hook.getCurrent().targetIsWindows).toBe(true);

        capabilityState.value = {
            status: 'loaded',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: {
                        'tool.windowsTerminal': {
                            ok: true,
                            checkedAt: 1,
                            data: { available: true },
                        },
                    },
                },
            },
        };
        await hook.rerender();

        expect(hook.getCurrent().windowsTerminalAvailable).toBe(true);
        await hook.unmount();
    });

    it('reports the Account profile read as loading while it has not answered, never as an empty answer', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { useSessionAuthoringControlFacts } = await import('./useSessionAuthoringControlFacts');
        const read = () => useSessionAuthoringControlFacts({ machineId: 'machine-1', serverId: 'server-1', directory: 'C:\\repo' });

        const noAccount = await renderHook(read);
        expect(noAccount.getCurrent().profilesLoading).toBe(false);
        await noAccount.unmount();

        getStorage().setState({ settingsScope: { serverId: 'server-1', accountId: 'account-1' } });
        const coldOpen = await renderHook(read);
        expect(coldOpen.getCurrent().profiles).toEqual([]);
        expect(coldOpen.getCurrent().profilesLoading).toBe(true);
        await coldOpen.unmount();
        getStorage().setState({ settingsScope: null });
    });
});
