import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';
import type {
  AgentInputAttachmentsRowItem,
  AgentInputExtraActionChip,
} from '../agentInputContracts';

installAgentInputCommonModuleMocks();
vi.mock('@/components/ui/theme/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('expo-image', () => ({
  Image: (props: Record<string, unknown>) =>
    React.createElement('Image', props, null),
}));

const { Text } = await import('react-native');
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
const { AgentInputDocumentPreview } =
  await import('./AgentInputDocumentPreview');

/** A contributed chip as an admitted plugin control produces one: a pinned placement and a render. */
function contributedChip(
  key: string,
  press: (toggleCollapsedPopover?: (chipKey: string) => void) => void,
): AgentInputExtraActionChip {
  return {
    key,
    controlId: `plugin:control:${key}`,
    placement: {
      id: `plugin:control:${key}`,
      title: key,
      defaultPlacement: 'pinned',
    },
    render: ({ toggleCollapsedPopover }) => (
      <Text
        testID={`chip-${key}`}
        onPress={() => press(toggleCollapsedPopover)}
      >
        {key}
      </Text>
    ),
  };
}

function badge(
  key: string,
  onRemove?: () => void,
): AgentInputAttachmentsRowItem {
  return {
    kind: 'badge',
    key,
    label: `Issue ${key}`,
    testID: `attachment-${key}`,
    ...(onRemove ? { onRemove } : {}),
  };
}

function renderPreview(
  props: Partial<React.ComponentProps<typeof AgentInputDocumentPreview>> = {},
) {
  const onActivate = vi.fn();
  const element = (
    <AgentInputDocumentPreview
      value="Review the issue"
      references={[]}
      placeholder="Describe the step"
      onActivate={onActivate}
      {...props}
    />
  );
  return { onActivate, render: () => renderScreen(element) };
}

describe('AgentInputDocumentPreview plugin presentation', () => {
  beforeEach(() => {
    getStorage().setState({ localSettings: localSettingsDefaults });
  });

  it('draws host and plugin chips through the one placement owner, honouring the saved placement', async () => {
    const chips = [
      contributedChip('host-options', () => {}),
      contributedChip('acme-refresh', () => {}),
    ];
    const { render } = renderPreview({ extraActionChips: chips });
    const pinned = await render();
    expect(pinned.findHostByTestId('chip-host-options')).not.toBeNull();
    expect(pinned.findHostByTestId('chip-acme-refresh')).not.toBeNull();
    await pinned.unmount();

    getStorage()
      .getState()
      .applyLocalSettings({
        navigationSurfacePlacementsV1: {
          composer: {
            orderedIds: [],
            placements: { 'plugin:control:acme-refresh': 'overflow' },
          },
        },
      });
    const moved = await render();
    expect(moved.findHostByTestId('chip-host-options')).not.toBeNull();
    expect(moved.findHostByTestId('chip-acme-refresh')).toBeNull();
    await moved.unmount();
  });

  it('opens the live row for a chip whose popover only the live composer can anchor, performing it once', async () => {
    const press = vi.fn((toggle?: (chipKey: string) => void) =>
      toggle?.('acme-refresh'),
    );
    const { render, onActivate } = renderPreview({
      extraActionChips: [contributedChip('acme-refresh', press)],
    });
    const screen = await render();
    screen.findHostByTestId('chip-acme-refresh')!.props.onPress();
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(null, {
      chipPopover: 'acme-refresh',
    });
    await screen.unmount();
  });

  it('draws the attachment tray above the field through the shared row', async () => {
    const { render } = renderPreview({ attachmentRowItems: [badge('1', () => {}), badge('2')] });
    const screen = await render();
    const tray = screen.findHostByTestId('agent-input-document-preview-attachments')!;
    const field = screen.findHostByTestId('agent-input-document-preview-field')!;
    expect(tray.findAll((node) => node.props.testID === 'attachment-1' || node.props.testID === 'attachment-2')).not.toHaveLength(0);
    const hosts = screen.root.findAll((node) => node === tray || node === field);
    expect(hosts[0]).toBe(tray);
    await screen.unmount();
  });

  it('draws no tray when the document carries no attachments', async () => {
    const { render } = renderPreview({ attachmentRowItems: [] });
    const screen = await render();
    expect(
      screen.findHostByTestId('agent-input-document-preview-attachments'),
    ).toBeNull();
    await screen.unmount();
  });
});
