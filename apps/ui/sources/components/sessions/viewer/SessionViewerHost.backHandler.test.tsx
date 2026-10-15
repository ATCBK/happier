import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';

import { useOptionalSessionViewerController, type SessionViewerController } from './SessionViewerController';
import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';
import { SessionViewerHost } from './SessionViewerHost';

const platform = vi.hoisted(() => ({ os: 'android' as 'android' | 'web' }));
const nativeBack = vi.hoisted(() => ({
  addEventListener: vi.fn((_eventName: string, _handler: () => boolean) => ({ remove: () => {} })),
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      get OS() { return platform.os; },
      select: (spec: Record<string, unknown>) => spec[platform.os] ?? spec.default,
    },
    BackHandler: nativeBack,
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mountExpanded() {
  const harness: { controller: SessionViewerController | null } = { controller: null };
  function Probe() {
    harness.controller = useOptionalSessionViewerController();
    return null;
  }
  const result = await renderWithAppProviders(
    <SessionViewerControllerProvider
      sessionId="session-a"
      serverId="home-a"
      phone={false}
      canPresentSource={() => true}
      openDocked={() => {}}
    >
      <Probe />
      <SessionViewerHost sessionId="session-a" serverId="home-a" />
    </SessionViewerControllerProvider>,
  );
  await act(async () => {
    harness.controller!.port.apply({ kind: 'viewer.open', source: 'computer' });
  });
  await act(async () => {
    invokeTestInstanceHandler(
      result.tree.root.findByProps({ testID: 'session-viewer-host' }),
      'onLayout',
      { nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } } },
    );
  });
  await act(async () => {
    harness.controller!.port.apply({ kind: 'viewer.expand' });
  });
  expect(harness.controller!.state.mode).toBe('expanded');
  return result;
}

describe('SessionViewerHost hardware Back', () => {
  beforeEach(() => {
    nativeBack.addEventListener.mockClear();
  });

  it('listens for hardware Back on Android while expanded', async () => {
    platform.os = 'android';
    const result = await mountExpanded();
    expect(nativeBack.addEventListener).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    await result.unmount();
  });

  it('never reaches the platform Back listener on web, where React Native reports it unsupported', async () => {
    platform.os = 'web';
    const result = await mountExpanded();
    expect(nativeBack.addEventListener).not.toHaveBeenCalled();
    await result.unmount();
  });
});
