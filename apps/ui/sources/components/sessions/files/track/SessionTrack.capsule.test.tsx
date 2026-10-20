import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  renderScreen,
  pressTestInstanceAsync,
  invokeTestInstanceHandler,
} from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const { TrackCapsule, TrackInputBoundary } = await import('./SessionTrack');
type Model = React.ComponentProps<typeof TrackCapsule>['track'];

function model(overrides: Partial<Model>): Model {
  return {
    enabled: false,
    paused: false,
    pauseReason: null,
    target: {
      path: 'src/a.ts',
      write: { toolCallId: 't', sessionId: 's', startedAt: 1 },
    },
    setEnabled: vi.fn(),
    toggle: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    agentId: null,
    agentTitle: 'Claude',
    ...overrides,
  } as Model;
}

describe('Track strip capsule (lab tr T0–T2)', () => {
  it('is absent while nobody writes, and each state does what its label says', async () => {
    const idle = await renderScreen(
      <TrackCapsule track={model({ target: null })} />,
    );
    expect(idle.findByTestId('session-details-track-capsule')).toBeFalsy();

    const off = model({});
    const offScreen = await renderScreen(<TrackCapsule track={off} />);
    await pressTestInstanceAsync(
      offScreen.findByTestId('session-details-track-capsule'),
    );
    expect(off.setEnabled).toHaveBeenCalledWith(true);

    const paused = model({
      enabled: true,
      paused: true,
      pauseReason: 'scroll',
    });
    const pausedScreen = await renderScreen(<TrackCapsule track={paused} />);
    await pressTestInstanceAsync(
      pausedScreen.findByTestId('session-details-track-capsule'),
    );
    expect(paused.resume).toHaveBeenCalledTimes(1);
    expect(paused.setEnabled).not.toHaveBeenCalled();

    const on = model({ enabled: true });
    const onScreen = await renderScreen(<TrackCapsule track={on} />);
    await pressTestInstanceAsync(
      onScreen.findByTestId('session-details-track-capsule'),
    );
    expect(on.setEnabled).toHaveBeenCalledWith(false);
    expect(on.resume).not.toHaveBeenCalled();
  });

  it('pauses on person input in the pane but not on a press of the capsule itself', async () => {
    const following = model({ enabled: true });
    const screen = await renderScreen(
      <TrackInputBoundary track={following}>
        <TrackCapsule track={following} />
      </TrackInputBoundary>,
    );
    const boundary = screen.tree.root.findAll(
      (node) => typeof node.props.onPointerDown === 'function',
    )[0]!;
    const capsuleElement = {
      closest: (selector: string) =>
        selector.includes('session-details-track-capsule') ? {} : null,
    };
    await invokeTestInstanceHandler(boundary, 'onPointerDown', {
      target: capsuleElement,
    });
    expect(following.pause).not.toHaveBeenCalled();
    await invokeTestInstanceHandler(boundary, 'onPointerDown', {
      target: { closest: () => null },
    });
    expect(following.pause).toHaveBeenCalledWith('selection');
    await invokeTestInstanceHandler(boundary, 'onWheel', {});
    expect(following.pause).toHaveBeenLastCalledWith('scroll');
  });
});
