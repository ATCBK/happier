import * as React from 'react';
import type { BrowserAdapterCapabilitiesV1 } from '@happier-dev/protocol/browser/adapters/v1';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import {
  applyBrowserControlEvent,
  createBrowserControlState,
} from '@/sync/domains/browser/control';
import { selectBrowserToolbarModel } from '@/sync/domains/browser/shell';

vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

const { BrowserToolbar } = await import('./BrowserToolbar');

function toolbarFor(
  input: Readonly<{
    adapterKind: 'externalUrl' | 'localPreview';
    target: BrowserViewTargetV1;
    capabilities: BrowserAdapterCapabilitiesV1;
    loading?: boolean;
  }>,
) {
  let state = createBrowserControlState();
  state = applyBrowserControlEvent(state, {
    kind: 'sessionCreated',
    eventId: 'event_session',
    browserSessionId: 'browser_session_1',
    profileId: 'profile_1',
    occurredAt: 1_000,
  });
  state = applyBrowserControlEvent(state, {
    kind: 'viewOpened',
    eventId: 'event_view',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    target: input.target,
    platform: 'web',
    currentUrl: 'https://docs.example.com/guide',
    adapterKind: input.adapterKind,
    engineKind: 'webIframe',
    adapterCapabilities: input.capabilities,
    occurredAt: 1_001,
  });
  const view = state.viewsById.view_1 ?? null;
  return selectBrowserToolbarModel(
    view ? { ...view, loadingState: input.loading ? 'loading' : 'ready' } : view,
  );
}

const externalTarget = {
  kind: 'externalUrl',
  targetId: 'external_1',
  url: 'https://docs.example.com/guide',
  display: { title: 'Guide', addressLabel: 'docs.example.com' },
} satisfies BrowserViewTargetV1;

const handlers = {
  onBack: vi.fn(),
  onForward: vi.fn(),
  onReload: vi.fn(),
  onStop: vi.fn(),
};

describe('BrowserToolbar (AMD-8)', () => {
  it('shows Back, Forward and Stop as unavailable with one reason on a third-party web iframe page, and keeps Reload', async () => {
    const capabilities = buildBrowserAdapterCapabilities({
      adapterKind: 'externalUrl',
      supportedTargetKinds: ['externalUrl'],
      supportedRenderEngines: ['webIframe'],
    });
    const reason = 'browserShell.toolbar.historyUncontrollable';

    const idle = await renderScreen(
      <BrowserToolbar
        testID="tb"
        model={toolbarFor({
          adapterKind: 'externalUrl',
          target: externalTarget,
          capabilities,
        })}
        {...handlers}
      />,
    );
    for (const id of ['tb-back', 'tb-forward']) {
      const control = idle.findByTestId(id);
      expect(control?.props.accessibilityState?.disabled).toBe(true);
      expect(control?.props.accessibilityHint).toBe(reason);
    }
    expect(
      idle.findByTestId('tb-reload')?.props.accessibilityState?.disabled,
    ).toBe(false);
    await idle.unmount();

    const loading = await renderScreen(
      <BrowserToolbar
        testID="tb"
        model={toolbarFor({
          adapterKind: 'externalUrl',
          target: externalTarget,
          capabilities,
          loading: true,
        })}
        {...handlers}
      />,
    );
    expect(
      loading.findByTestId('tb-stop')?.props.accessibilityState?.disabled,
    ).toBe(true);
    expect(loading.findByTestId('tb-stop')?.props.accessibilityHint).toBe(
      'browserShell.toolbar.stopUncontrollable',
    );
    await loading.unmount();
  });

  it('gives a relay preview live controls with no unavailability reason', async () => {
    const capabilities = buildBrowserAdapterCapabilities({
      adapterKind: 'localPreview',
      supportedTargetKinds: ['localServicePreview'],
      supportedRenderEngines: ['webIframe'],
    });
    const target = {
      kind: 'localServicePreview',
      targetId: 'preview_1',
      sessionId: 'session_1',
      machineId: 'machine_1',
      display: { title: 'Preview', addressLabel: 'localhost:5173' },
    } satisfies BrowserViewTargetV1;

    const screen = await renderScreen(
      <BrowserToolbar
        testID="tb"
        model={toolbarFor({
          adapterKind: 'localPreview',
          target,
          capabilities,
          loading: true,
        })}
        {...handlers}
      />,
    );
    expect(
      screen.findByTestId('tb-stop')?.props.accessibilityState?.disabled,
    ).toBe(false);
    expect(
      screen.findByTestId('tb-back')?.props.accessibilityHint,
    ).toBeUndefined();
    await screen.unmount();
  });
});
