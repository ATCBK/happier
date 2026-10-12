import * as React from 'react';
import type { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';
import { buildOverlayLayerFixture } from './__tests__/buildOverlayLayerFixture';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const captured: { popover: Record<string, any> | null } = { popover: null };

installAgentInputCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
  },
});

// Placement geometry needs real layout, which the DOM harness lacks: capture the props the
// composer hands the shared Popover (its geometry has its own tests) and stop there.
vi.mock('@/components/ui/popover', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Popover: (props: Record<string, any>) => {
    captured.popover = props;
    return null;
  },
}));

function ref(): React.RefObject<View | null> {
  return { current: null } as React.RefObject<View | null>;
}

describe('AgentInputOverlayLayer engine popover placement (lab MP1/MP3)', () => {
  it('attaches the engine popover to the composer at its width instead of covering the input from the chip', async () => {
    const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');
    const composer = ref();
    const chip = ref();
    await renderScreen(
      <AgentInputOverlayLayer
        {...buildOverlayLayerFixture({
          overlayAnchorRef: composer,
          agentChipAnchorRef: chip,
          agentPickerAnchor: 'chip',
          showAgentPicker: true,
          hasAgentPickerOptions: true,
          agentPickerOptions: [{ id: 'claude', label: 'Claude' }],
          maxWidthCap: 760,
        })}
      />,
    );

    expect(captured.popover?.anchorRef).toBe(composer);
    expect(captured.popover?.portal?.matchAnchorWidth).toBe(true);
  });

  it('opens the machine list on the composer edge at its own width, never over the draft (lab m-pick)', async () => {
    const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');
    const composer = ref();
    const chip = ref();
    await renderScreen(
      <AgentInputOverlayLayer
        {...buildOverlayLayerFixture({
          overlayAnchorRef: composer,
          machineChipAnchorRef: chip,
          machinePopoverAnchor: 'chip',
          showMachinePopover: true,
          machinePopover: { renderContent: () => null },
        })}
      />,
    );

    expect(captured.popover?.anchorRef).toBe(composer);
    expect(captured.popover?.portal?.matchAnchorWidth).not.toBe(true);
  });
});
