import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

import {
  ComputerScreenViewer,
  resolveComputerPresenceCapsule,
  type ComputerScreenViewerProps,
} from './ComputerScreenViewer';

vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('react-native', async () => {
  const React = await import('react');
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  // Image sizing is a platform boundary; retain the real viewer and input geometry.
  return createReactNativeWebMock({ Image: Object.assign(
    (props: Record<string, unknown>) => React.createElement('Image', props),
    { getSize: (_url: string, success: (width: number, height: number) => void) => success(800, 600) },
  ) });
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key, params) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  });
});

function props(
  overrides: Partial<ComputerScreenViewerProps> = {},
): ComputerScreenViewerProps {
  return {
    agent: { agentId: null, name: 'Claude' },
    targetTitle: 'Simulator — iPhone 17',
    targetKind: 'window',
    machineName: 'mac-vm-1',
    shared: true,
    stream: null,
    presence: { kind: 'agent', activity: null, target: null, controlEpoch: 0 },
    agentActing: false,
    onTakeControl: vi.fn(async () => ({ status: 'taken' }) as never),
    onHandBack: vi.fn(),
    onCheckAgain: vi.fn(),
    onChooseWindow: vi.fn(),
    onStopSharing: vi.fn(),
    testID: 'v',
    ...overrides,
  };
}

describe('ComputerScreenViewer', () => {
  it('keeps a removed-access refusal visible after the owner retires the selection, with no choose or repair bypass', async () => {
    const screen = await renderScreen(<ComputerScreenViewer {...props({ shared: false, failure: 'forbidden' })} />);
    expect(screen.findByTestId('v-not-shared')).toBeNull();
    expect(screen.findByTestId('v-recovery')).toBeTruthy();
    expect(screen.findByTestId('v-recovery-action')).toBeNull();
  });
  it.each(['driver_unavailable', 'driver_result_invalid'] as const)('offers the native installation repair for %s before selection is available', async failure => {
    const onRepairDriver = vi.fn();
    const screen = await renderScreen(<ComputerScreenViewer {...props({ shared: false })} failure={failure} onRepairDriver={onRepairDriver} />);
    expect(screen.findByTestId('v-not-shared') === null).toBe(true);
    expect(screen.findByTestId('v-recovery')).toBeTruthy();
    await screen.pressByTestIdAsync('v-recovery-action');
    expect(onRepairDriver).toHaveBeenCalledTimes(1);
  });

  it.each(['stale_capture', 'human_input_interruption_uncertain'] as const)('keeps the frame and recaptures without input replay for %s', async failure => {
    const onCheckAgain = vi.fn();
    const screen = await renderScreen(<ComputerScreenViewer {...props({
      onCheckAgain,
      presence: { kind: 'human', controlEpoch: 1 },
      stream: { machineName: 'mac-vm-1', input: { sourceId: 'computer-window-a', streamId: 'stream-a', send: vi.fn() }, playerState: {
        phase: 'playing', selectedCodec: 'image.mjpeg', activeRenderer: 'mjpeg',
        lastFrameUrl: 'data:image/jpeg;base64,AQID', decodedFrames: 1, droppedFrames: 0, bufferedBytes: 0,
      } },
    })} failure={failure} />);
    await act(async () => screen.root.findAll(node => typeof node.props.onLayout === 'function')[0].props.onLayout({
      nativeEvent: { layout: { width: 800, height: 600 } },
    }));
    expect(screen.findByTestId('v-player')).toBeTruthy();
    expect(screen.findByTestId('v-recovery')).toBeTruthy();
    await screen.pressByTestIdAsync('v-recovery-action');
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(screen.findByTestId('v-input')).toBeNull();
  });

  it('says once that control isn’t allowed and offers no Take control while the machine denies input', async () => {
    const denied = await renderScreen(
      <ComputerScreenViewer {...props({ inputDenied: true })} />,
    );
    const text = denied.getTextContent();
    expect(text.split('computerUse.presentation.controlNotAllowed').length - 1).toBe(1);
    expect(denied.findByTestId('v-presence-take-control')).toBeNull();
    expect(resolveComputerPresenceCapsule(props({ inputDenied: true })).onTakeControl).toBeUndefined();

    const granted = await renderScreen(
      <ComputerScreenViewer {...props({ inputDenied: false })} />,
    );
    expect(granted.getTextContent()).not.toContain('computerUse.presentation.controlNotAllowed');
    expect(granted.findByTestId('v-presence-take-control')).toBeTruthy();
  });

  it('keeps the last picture dimmed with its time and a way to retry while the stream is paused', async () => {
    const onRetry = vi.fn();
    const paused = await renderScreen(
      <ComputerScreenViewer
        {...props({
          stream: {
            machineName: 'mac-vm-1',
            onRetry,
            playerState: {
              phase: 'error',
              selectedCodec: null,
              activeRenderer: null,
              // A decoded frame is held (the picture owner's own evidence of a renderable frame).
              avccChunks: [new Uint8Array([0])],
              lastFrameAtMs: Date.UTC(2026, 9, 10, 14, 2),
              decodedFrames: 1,
              droppedFrames: 0,
              bufferedBytes: 0,
            },
          },
        })}
      />,
    );
    expect(paused.findByTestId('v-paused-scrim')).toBeTruthy();
    expect(paused.getTextContent()).toContain('computerUse.presentation.paused:{"time":');
    await paused.pressByTestIdAsync('v-stalled-action');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('names an unreachable machine with its one recovery and no fault code to look up', async () => {
    const screen = await renderScreen(
      <ComputerScreenViewer {...props({ shared: false, failure: 'machine_unreachable' })} />,
    );
    expect(screen.getTextContent()).toContain('computerUse.presentation.offlineTitle:{"machine":"mac-vm-1"}');
    expect(screen.findByTestId('v-recovery-action')).toBeTruthy();
    expect(screen.getTextContent()).not.toContain('common.details');
  });

  it('says the machine isn’t answering instead of a generic failure, and shows the missing permission in the picture', async () => {
    const offline = await renderScreen(
      <ComputerScreenViewer {...props({ machineOnline: false })} />,
    );
    expect(offline.getTextContent()).toContain('computerUse.presentation.offlineTitle:{"machine":"mac-vm-1"}');
    expect(offline.getTextContent()).not.toContain('computerUse.presentation.unavailableTitle');

    // Nothing to choose on a machine that cannot answer: no "No window is shared" before the failure arrives.
    const unshared = await renderScreen(
      <ComputerScreenViewer {...props({ shared: false, machineOnline: false })} />,
    );
    expect(unshared.getTextContent()).toContain('computerUse.presentation.offlineTitle:{"machine":"mac-vm-1"}');
    expect(unshared.findByTestId('v-not-shared')).toBeNull();
    expect(unshared.getTextContent()).toContain('computerUse.permission.checkAgain');

    const onOpenSettings = vi.fn();
    const denied = await renderScreen(
      <ComputerScreenViewer
        {...props({ shared: false, grants: { capture: 'denied', input: 'granted' }, onOpenSettings })}
      />,
    );
    expect(denied.getTextContent()).toContain('computerUse.permission.captureTitle:{"machine":"mac-vm-1"}');
    // Nobody acts on a screen that cannot be seen: no presence capsule beside the card.
    expect(denied.findByTestId('v-presence')).toBeNull();
    await denied.pressByTestIdAsync('v-permission-card-open-settings');
    expect(onOpenSettings).toHaveBeenCalledWith('capture');
  });

  it('leaves identity to the floating frame when the picture is the viewer', async () => {
    const framed = await renderScreen(
      <ComputerScreenViewer {...props({ chrome: 'none' })} />,
    );
    expect(framed.findByTestId('v-title')).toBeNull();
    expect(framed.findByTestId('v-more')).toBeNull();
    const pane = await renderScreen(<ComputerScreenViewer {...props()} />);
    expect(pane.findByTestId('v-title')).toBeTruthy();
  });
});
