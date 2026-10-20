import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const router = createExpoRouterMock();
installSettingsViewCommonModuleMocks({ router: () => router.module });

const { DestinationInstanceHost } =
  await import('@/components/appShell/workspace/DestinationInstanceHost');
const { Stack } =
  await import('@/components/appShell/workspace/destinationRoute');
const { SurfaceFreshnessLine } =
  await import('@/components/ui/surfaces/SurfaceFreshnessLine');
const { PluginSurfaceInteractionBoundary } =
  await import('@/components/plugins/shared/PluginSurfaceInteractionBoundary');
const { renderPluginNavigationActions, PluginArtifactHostingStatusProvider } =
  await import('./pluginPageHeaderActions');

function isInside(node: ReactTestInstance, testID: string): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      parent.props['data-testid'] === testID ||
      parent.props.testID === testID
    )
      return true;
  }
  return false;
}

/**
 * A plugin page whose header row takes the route's own control (the machine it runs on), the way a
 * Collection toolbar places `pageActions`.
 */
function page(online: boolean) {
  return (
    <DestinationInstanceHost
      tabId="prs"
      ref={{ kind: 'settings', params: {} }}
      pathname="/plugins/acme/page"
      focused
      visible
      phone={false}
      navigation={{ push: () => {}, replace: () => {}, back: () => {} }}
    >
      <Stack.Screen
        options={{
          headerRight: () => <button data-testid="run-on-chip">Run on</button>,
        }}
      />
      <PluginSurfaceInteractionBoundary
        surfaceId="acme-page"
        snapshotTitle="Acme"
        enabled={online}
      >
        {renderPluginNavigationActions(null)}
      </PluginSurfaceInteractionBoundary>
    </DestinationInstanceHost>
  );
}

describe('plugin page header actions', () => {
  it('keeps the route control usable outside the read-only snapshot while the plugin is offline', async () => {
    const screen = await renderScreen(page(true));
    const live = screen.root.findAllByProps({ 'data-testid': 'run-on-chip' });
    expect(live).toHaveLength(1);
    expect(isInside(live[0]!, 'plugin-surface-snapshot:acme-page')).toBe(true);

    // Offline, the plugin's tree is inert; the one control that leads elsewhere (another machine)
    // must not be frozen inside it.
    await screen.update(page(false));
    const offline = screen.root.findAllByProps({
      'data-testid': 'run-on-chip',
    });
    expect(offline).toHaveLength(1);
    expect(isInside(offline[0]!, 'plugin-surface-snapshot:acme-page')).toBe(
      false,
    );
    expect(isInside(offline[0]!, 'app-stack-header-actions')).toBe(true);

    // Back online, the row takes it again: never drawn twice.
    await screen.update(page(true));
    const again = screen.root.findAllByProps({ 'data-testid': 'run-on-chip' });
    expect(again).toHaveLength(1);
    expect(isInside(again[0]!, 'plugin-surface-snapshot:acme-page')).toBe(true);
  });

  /**
   * D3: the page's UI could not be hosted on the Account. It still works here, so the outcome is one
   * quiet chip in the page's own header row, never a strip above the page; a surface that draws no
   * header keeps the line so the fact is never lost.
   */
  function hostedPage(completion: Promise<{ kind: 'unavailable' } | { kind: 'published' }> | null, header: boolean) {
    return (
      <DestinationInstanceHost
        tabId="prs"
        ref={{ kind: 'settings', params: {} }}
        pathname="/plugins/acme/page"
        focused
        visible
        phone={false}
        navigation={{ push: () => {}, replace: () => {}, back: () => {} }}
      >
        <PluginArtifactHostingStatusProvider completion={completion as never} isCurrent={() => true}>
          <PluginSurfaceInteractionBoundary surfaceId="acme-page" snapshotTitle="Acme" enabled>
            {header ? renderPluginNavigationActions(null) : null}
          </PluginSurfaceInteractionBoundary>
        </PluginArtifactHostingStatusProvider>
      </DestinationInstanceHost>
    );
  }

  it('says a failed Account upload as one header chip on the page, or a line when the page has no header', async () => {
    const failed = Promise.resolve({ kind: 'unavailable' as const });
    const screen = await renderScreen(hostedPage(failed, true));
    await screen.update(hostedPage(failed, true));
    const chips = screen.root.findAllByType(SurfaceFreshnessLine);
    expect(chips).toHaveLength(1);
    expect(isInside(chips[0]!, 'plugin-surface-snapshot:acme-page')).toBe(true);
    expect(chips[0]!.props.presentation).toBe('chip');

    const lineScreen = await renderScreen(hostedPage(failed, false));
    await lineScreen.update(hostedPage(failed, false));
    const lines = lineScreen.root.findAllByType(SurfaceFreshnessLine);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.props.presentation ?? 'line').toBe('line');

    const ok = Promise.resolve({ kind: 'published' as const });
    const okScreen = await renderScreen(hostedPage(ok, true));
    await okScreen.update(hostedPage(ok, true));
    expect(okScreen.root.findAllByType(SurfaceFreshnessLine)).toHaveLength(0);

    const idle = await renderScreen(hostedPage(null, true));
    expect(idle.root.findAllByType(SurfaceFreshnessLine)).toHaveLength(0);
  });
});

