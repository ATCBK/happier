import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  HappierAgentCursorMotion,
  HappierAgentCursorMotionDriver,
} from '@happier-dev/plugin-ui/presentation';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const { EditorAgentCaret } = await import('./EditorAgentCaret');

/** The public cursor motion seam is the host's injection point; this driver records what the caret asks of it. */
function recordingDriver() {
  const calls: string[] = [];
  const motion: HappierAgentCursorMotion = {
    set: (channel, value) => {
      calls.push(`set ${channel} ${value}`);
    },
    travel: (channel, value) => {
      calls.push(`travel ${channel} ${value}`);
    },
    setOpacity: (layer, value) => {
      calls.push(`opacity ${layer} ${value}`);
    },
    fade: (layer, to) => {
      calls.push(`fade ${layer} ${to}`);
    },
    ringOpacity: () => 0,
  };
  const driver: HappierAgentCursorMotionDriver = {
    useMotion: () => motion,
    Pointer: (props) => <>{props.children}</>,
    Ring: () => null,
  };
  return { calls, driver };
}

describe('EditorAgentCaret', () => {
  it('travels from the previous region on the travel spring', async () => {
    const { calls, driver } = recordingDriver();
    const screen = await renderScreen(
      <EditorAgentCaret
        agentId={null}
        agentName="Claude"
        lineHeight={20}
        travelFromPx={-80}
        reducedMotion={false}
        motionDriver={driver}
      />,
    );
    expect(calls).toEqual(['opacity pointer 1', 'set y -80', 'travel y 0']);
    await screen.unmount();
    standardCleanup();
  });

  it('arrives in place with a cross-fade and no travel under reduced motion', async () => {
    const { calls, driver } = recordingDriver();
    const screen = await renderScreen(
      <EditorAgentCaret
        agentId={null}
        agentName="Claude"
        lineHeight={20}
        travelFromPx={-80}
        reducedMotion
        motionDriver={driver}
      />,
    );
    expect(calls).toEqual(['set y 0', 'opacity pointer 0', 'fade pointer 1']);
    expect(calls.some((call) => call.startsWith('travel'))).toBe(false);
    await screen.unmount();
    standardCleanup();
  });

  it('names the agent for assistive technology', async () => {
    const { driver } = recordingDriver();
    const screen = await renderScreen(
      <EditorAgentCaret
        agentId={null}
        agentName="Claude"
        lineHeight={20}
        reducedMotion={false}
        motionDriver={driver}
        testID="caret"
      />,
    );
    expect(screen.findByTestId('caret')?.props.accessibilityLabel).toBeTruthy();
    await screen.unmount();
    standardCleanup();
  });
});
