import * as React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} from './mcpServersTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installMcpServersCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Platform: {
                OS: 'web',
                select: <T,>(values: { default?: T; web?: T; ios?: T; android?: T }) =>
                    values.web ?? values.default ?? values.ios ?? values.android,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#666',
                    input: { background: '#fff', text: '#111', placeholder: '#888' },
                    divider: '#ddd',
                    accent: { blue: '#00f', indigo: '#60f', green: '#0f0' },
                },
            },
        });
    },
});

// Match the collection suite: transform the real Home/AppShell graph during
// collection, leaving the existing deadline for the actual browser operation.
const { McpDetectedServersTab } = await import('./McpDetectedServersTab');

describe('MCP directory browse tabs', () => {
  beforeEach(() => {
    resetMcpServersCommonModuleMockState();
    mcpServersModuleState.openMachinePathBrowserModalSpy.mockResolvedValue('/repo/from-browser');
  });

  it('opens the shared path browser from the detected directory input', async () => {
    const onChangeDirectory = vi.fn();

    let tree!: ReactTestRenderer;
        tree = (await renderScreen(<McpDetectedServersTab
                    selectedMachineId="machine-1"
                    selectedServerId="server-1"
                    canExecute
                    canImport
          directory="/repo"
          onChangeDirectory={onChangeDirectory}
          loading={false}
          detected={[]}
          warnings={[]}
          onRefresh={() => {}}
          onImport={() => {}}
        />)).tree;

    const browseButton = tree.findByType('PathInputBrowseButton');
    await act(async () => {
      await pressTestInstanceAsync(browseButton);
    });

    expect(mcpServersModuleState.openMachinePathBrowserModalSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      serverId: 'server-1',
      initialPath: '/repo',
      title: 'settings.mcpServersDetectedDirectoryTitle',
    });
    expect(onChangeDirectory).toHaveBeenCalledWith('/repo/from-browser');
  });
});
