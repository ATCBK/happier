import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from '@/components/appShell/panes/appPaneScopeHostTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let registeredDriver: any = null;
let currentDeviceType: 'phone' | 'tablet' = 'phone';
let hostProps: any = null;

installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width: currentDeviceType === 'phone' ? 390 : 1200, height: 844 }),
    getLocalSetting: (key: string) => (key === 'uiMultiPanePanelsEnabled' ? true : null),
});

vi.mock('@/utils/platform/responsive', () => ({
  useDeviceType: () => currentDeviceType,
}));

// The pane scope as the desktop left it: its bottom pane is open on the Terminal.
vi.mock('@/components/appShell/panes/AppPaneProvider', () => {
  const scope = {
    mainHidden: false,
    right: { isOpen: false, activeTabId: null },
    details: { isOpen: false, tabs: [], activeTabKey: null },
    bottom: {
      isOpen: true,
      activeTabId: 'terminal',
      selectedDestination: null,
      tabState: {},
    },
  };
  const context = () => ({
    dispatch: vi.fn(),
    state: {
      scopes: new Proxy({}, { get: () => scope }),
      activeScopeId: null,
    },
    registerDriver: (driver: any) => {
      registeredDriver = driver;
      return () => {};
    },
    getDriver: () => registeredDriver,
    driverRegistryVersion: 1,
  });
  return { useAppPaneContext: context, useOptionalAppPaneContext: context };
});

vi.mock('@/components/ui/panels/MultiPaneHostWithBottom', () => ({
  MultiPaneHostWithBottom: (props: any) => {
    hostProps = props;
    return React.createElement('MultiPaneHostStub');
  },
}));

vi.mock('./SessionRightPanel', () => ({
  SessionRightPanel: () => React.createElement('SessionRightPanel'),
  SessionActionRail: () => null,
}));
vi.mock('./SessionDetailsPanel', () => ({
  SessionDetailsPanel: () => React.createElement('SessionDetailsPanel'),
}));
vi.mock('./bottom/SessionBottomPanel', () => ({
  SessionBottomPanel: () => React.createElement('SessionBottomPanel'),
}));
vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
  useSessionMachineTarget: () => ({
    machineId: 'machine-s1',
    basePath: '/repo',
  }),
}));
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession',
  () => ({
    usePreferredServerIdForSession: () => 'server-s1',
  }),
);
vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', async () => {
  const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
  return {
    useScopedPluginUiProjection: () => ({
      pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1 },
      pluginBrowserProjection: null,
      phase: 'current',
      interactionEnabled: true,
      platform: 'web',
    }),
  };
});

async function renderSessionPaneHost(deviceType: 'phone' | 'tablet') {
  standardCleanup();
  currentDeviceType = deviceType;
  registeredDriver = null;
  hostProps = null;
  const { useRegisterSessionPaneDriver } =
    await import('./useRegisterSessionPaneDriver');
  const { AppPaneScopeHost } =
    await import('@/components/appShell/panes/AppPaneScopeHost');
  let scopeId = '';
  const Probe = () => {
    scopeId = useRegisterSessionPaneDriver('s1');
    return null;
  };
  await renderScreen(<Probe />);
  await renderScreen(<AppPaneScopeHost scopeId={scopeId} main={<div />} />);
  return hostProps;
}

// Terminal lab B1: a phone shows the session terminal as the cockpit's Terminal page, never as a
// bottom dock; every Session scene mounts this host over the same pane scope, so a bottom pane
// left open by a wider layout would duplicate the terminal under the chat and the tab bar.
describe('Session pane driver, bottom terminal pane by device', () => {
  it('presents the bottom terminal pane on a wide layout', async () => {
    const props = await renderSessionPaneHost('tablet');
    expect(props?.bottomPane ?? null).not.toBeNull();
  }, 180_000);

  it('presents no bottom pane on a phone, whatever the scope left open', async () => {
    const props = await renderSessionPaneHost('phone');
    expect(props).not.toBeNull();
    expect(props.bottomPane ?? null).toBeNull();
  }, 180_000);
});
