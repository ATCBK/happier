import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createMachineFixture, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { createInstalledPluginCapabilityFixture } from '@/dev/testkit/fixtures/pluginCapabilityFixtures';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const route = vi.hoisted(() => ({ pathname: '/plugins', params: {} as Record<string, string>, replace: vi.fn(), setParams: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => route.pathname, params: () => route.params,
    router: { replace: route.replace, setParams: route.setParams },
}).module);
const installedPlugins = {
    value: [
        createInstalledPluginCapabilityFixture({ pluginId: 'happier.codex', title: 'Codex', source: { kind: 'bundled', locator: 'x' } }),
        createInstalledPluginCapabilityFixture({ pluginId: 'happier.claude', title: 'Claude', source: { kind: 'bundled', locator: 'x' } }),
        createInstalledPluginCapabilityFixture({ pluginId: 'acme.notes', title: 'Notes', enabled: false }),
    ],
};
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const account = createProviderSettingsAccountHarness();
installDisconnectedServerSocketBoundary(socket => {
    socket.connect = vi.fn<typeof socket.connect>(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event: string, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object' || !('method' in payload)
            || payload.method !== `machine-1:${RPC_METHODS.CAPABILITIES_DETECT}`) {
            throw new Error('Unexpected Plugins column Socket request');
        }
        return { ok: true, result: { protocolVersion: 1, results: {
            'tool.plugins': { ok: true, checkedAt: 1, data: { installedPlugins: installedPlugins.value } },
        } } };
    });
});
await import('./PluginsNavigationColumn');
beforeEach(async () => {
    const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
    const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now() });
    await account.restore({ accountId: 'plugin-navigation', serverIdentityId: 'srv_plugin_navigation', machines: [machine] });
    await account.selectMachine(account.serverId, machine.id, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins);
});

afterEach(async () => {
    standardCleanup();
    await account.reset();
    route.replace.mockReset();
    route.setParams.mockReset();
    route.pathname = '/plugins';
    route.params = {};
});

const rowIds = (screen: Awaited<ReturnType<typeof renderSettingsView>>, prefix: string) => [...new Set(screen
    .findAll((node) => typeof node.props?.testID === 'string' && node.props.testID.startsWith(prefix) && typeof node.props.title === 'string')
    .map((node) => String(node.props.testID)))];

describe('PluginsNavigationColumn', () => {
    it('keeps destination navigation without rendering a second installed collection or search', async () => {
        const { PluginsNavigationColumn } = await import('./PluginsNavigationColumn');
        const screen = await renderSettingsView(<PluginsNavigationColumn />);
        expect(rowIds(screen, 'plugins-column:plugin:')).toEqual([]);
        expect(screen.findByTestId('plugins-column:search')).toBeNull();
        await waitForHomeGovernance(() => {
            const installedRow = screen.findAll((node) => node.props?.testID === 'plugins-column:installed' && typeof node.props.title === 'string')[0];
            expect(installedRow?.props.detail).toBe('3');
        });
        expect(screen.findByTestId('plugins-column:developers.trigger')).not.toBeNull();
    });
    it('drives the Plugins page between Installed and Browse', async () => {
        const { PluginsNavigationColumn } = await import('./PluginsNavigationColumn');
        route.params = { view: 'browse' };
        const screen = await renderSettingsView(<PluginsNavigationColumn />);

        const row = (testID: string) => screen.findAll((node) => node.props?.testID === testID && typeof node.props.selected === 'boolean')[0];
        expect(row('plugins-column:discover')?.props.selected).toBe(true);
        expect(row('plugins-column:installed')?.props.selected).toBe(false);
        screen.pressByTestId('plugins-column:installed');
        expect(route.replace).toHaveBeenCalledWith('/plugins?view=installed');
        route.params = {};
    });
});
