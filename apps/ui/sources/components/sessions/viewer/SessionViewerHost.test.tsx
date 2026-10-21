import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  FloatingFrame,
  resolveFloatingFrameBodyRect,
  resolveFloatingFrameChromeHeight,
  resolveFloatingFrameRect,
  type FrameRect,
} from '@happier-dev/plugin-ui/presentation';

import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';
import type { BrowserCopresence } from '@/sync/domains/browser/automation/copresence';

import {
  useOptionalSessionViewerController,
  usePublishSessionViewerPresence,
  usePublishSessionViewerSourceFacts,
  NO_SESSION_VIEWER_INSET,
  useSessionViewerReadingInset,
  type SessionViewerController,
  type SessionViewerReadingInset,
  type SessionViewerPresence,
} from './SessionViewerController';
import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';
import { SessionViewerHost } from './SessionViewerHost';
import { SESSION_VIEWER_EDGE } from './sessionViewerGeometry';
import {
  SessionCockpitChromeRegistryProvider,
  useReportSessionCockpitComposerChromeHeight,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

/**
 * Plan 63s2 / R1-U1–U4: the mounted viewer composition. The source's presence owner and facts are
 * published through the viewer's public hooks (as the Computer and Browser bodies do); controller,
 * host, frame, controls and the presence capsule are the real owners.
 */
type Harness = {
  controller: SessionViewerController | null;
  inset: SessionViewerReadingInset;
};

const AGENT_PRESENCE: BrowserCopresence = {
  kind: 'agent',
  activity: null,
  target: null,
  controlEpoch: 1,
};
const HUMAN_PRESENCE: BrowserCopresence = {
  kind: 'human',
  controlEpoch: 2,
  interruptedCompletion: null,
};

function Source(
  props: Readonly<{ presence: BrowserCopresence; machineName?: string | null; targetTitle?: string | null; aspectRatio?: number; agentTitle?: string }>,
) {
  const watching = props.presence.kind === 'agent';
  usePublishSessionViewerSourceFacts('computer', {
    targetTitle: props.targetTitle ?? null,
    machineName: props.machineName === undefined ? 'fly-bot-1' : props.machineName,
    personInControl: props.presence.kind === 'human',
    watching,
    aspectRatio: props.aspectRatio ?? 2,
  });
  const presence = React.useMemo<SessionViewerPresence>(
    () => ({
      presence: props.presence,
      agent: { name: 'Claude' },
      ...(props.agentTitle ? { agentTitle: props.agentTitle } : {}),
      onTakeControl: () => {},
      onHandBack: () => {},
    }),
    [props.agentTitle, props.presence],
  );
  usePublishSessionViewerPresence('computer', presence);
  return null;
}

function Probe(props: Readonly<{ harness: Harness }>) {
  props.harness.controller = useOptionalSessionViewerController();
  props.harness.inset = useSessionViewerReadingInset();
  return null;
}

function Tree(
  props: Readonly<{
    harness: Harness;
    presence: BrowserCopresence;
    machineName?: string | null;
    targetTitle?: string | null;
    aspectRatio?: number;
    agentTitle?: string;
  }>,
) {
  return (
    <SessionViewerControllerProvider
      sessionId="session-a"
      serverId="home-a"
      phone={false}
      canPresentSource={() => true}
      openDocked={() => {}}
    >
      <Source presence={props.presence} machineName={props.machineName} targetTitle={props.targetTitle} aspectRatio={props.aspectRatio} agentTitle={props.agentTitle} />
      <Probe harness={props.harness} />
      <SessionViewerHost sessionId="session-a" serverId="home-a" />
    </SessionViewerControllerProvider>
  );
}

async function mountOpen(
  presence: BrowserCopresence,
  size: Readonly<{ width: number; height: number }>,
  machineName?: string | null,
) {
  const harness: Harness = { controller: null, inset: NO_SESSION_VIEWER_INSET };
  const result = await renderWithAppProviders(
    <Tree harness={harness} presence={presence} machineName={machineName} />,
  );
  await act(async () => {
    harness.controller!.port.apply({ kind: 'viewer.open', source: 'computer' });
  });
  await act(async () => {
    invokeTestInstanceHandler(
      result.tree.root.findByProps({ testID: 'session-viewer-host' }),
      'onLayout',
      { nativeEvent: { layout: { x: 0, y: 0, ...size } } },
    );
  });
  const frame = () => result.tree.root.findByType(FloatingFrame);
  return { result, harness, frame };
}

describe('SessionViewerHost', () => {
  it('propagates the selected display title to the frame and source switch independently of picture or recovery state', async () => {
    const { result, harness, frame } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    try {
      await result.update(<Tree harness={harness} presence={{ kind: 'unconfirmed', controlEpoch: 2 }} targetTitle="primary" />);
      expect(frame().props.accessibilityLabel).toContain('primary');
      const source = () => result.tree.root.findAll(node => node.props.testID === 'session-viewer-source:computer'
        && typeof node.props.accessibilityLabel === 'string')[0];
      expect(source()?.props.accessibilityLabel).toBe('primary');
      await result.update(<Tree harness={harness} presence={HUMAN_PRESENCE} targetTitle="secondary" />);
      expect(frame().props.accessibilityLabel).toContain('secondary');
      expect(source()?.props.accessibilityLabel).toBe('secondary');
      await result.update(<Tree harness={harness} presence={AGENT_PRESENCE} />);
      expect(frame().props.accessibilityLabel).not.toContain('secondary');
    } finally { await result.unmount(); }
  });
  it('moves by the watched picture, keeps the source’s shape and draws who acts below the picture', async () => {
    const { result, frame } = await mountOpen(AGENT_PRESENCE, {
      width: 1200,
      height: 800,
    });
    expect(frame().props.moveInput).toBe('surface');
    const rect = frame().props.rect as FrameRect;
    const body = resolveFloatingFrameBodyRect(rect, { footer: true });
    expect(body.width / body.height).toBeCloseTo(2);
    // The presence capsule stands in the frame's footer, not on the picture.
    const footer = frame().props.footer as React.ReactElement;
    expect(footer).toBeTruthy();
    expect(
      result.tree.root.findAll(
        (node) => node.props?.testID === 'session-viewer-presence',
      ).length,
    ).toBeGreaterThan(0);
    await result.unmount();
  });

  it('says the agent is working on the machine only while it acts; otherwise the source’s own line stands', async () => {
    const { result, harness } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    const capsuleTitle = () => result.tree.root.findAll(
      (node) => node.props?.testID === 'session-viewer-presence' && typeof node.props.agentTitle === 'string',
    )[0]?.props.agentTitle as string | undefined;
    try {
      // Shared and allowed, but no action in flight (no turn running): no claim of work.
      await result.update(<Tree harness={harness} presence={AGENT_PRESENCE} agentTitle="Claude can see Safari" />);
      expect(capsuleTitle()).toBe('Claude can see Safari');
      await result.update(<Tree harness={harness} presence={{ ...AGENT_PRESENCE, activity: 'click' }} agentTitle="Claude is using Safari" />);
      expect(capsuleTitle()).toContain('fly-bot-1');
    } finally { await result.unmount(); }
  });

  it('names what is watched and where, and never ends on a dangling "on" when its source states no machine', async () => {
    const named = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    expect(named.frame().props.accessibilityLabel).toContain('fly-bot-1');
    await named.result.unmount();

    const unnamed = await mountOpen(
      AGENT_PRESENCE,
      { width: 1200, height: 800 },
      null,
    );
    const label = String(unnamed.frame().props.accessibilityLabel);
    expect(label.length).toBeGreaterThan(0);
    expect(label).toBe(label.trim());
    expect(label).not.toMatch(/\s(on|sur|en|auf)$/);
    await unnamed.result.unmount();
  });

  it('leaves a driven picture its own input and keeps its controls shown', async () => {
    const { result, frame } = await mountOpen(HUMAN_PRESENCE, {
      width: 1200,
      height: 800,
    });
    expect(frame().props.moveInput).toBe('chrome');
    expect(frame().props.controlsAlwaysVisible).toBe(true);
    await result.unmount();
  });

  it('does not reflow the reading column while the frame is dragged; it yields where the frame settles', async () => {
    const { result, harness, frame } = await mountOpen(AGENT_PRESENCE, {
      width: 1400,
      height: 900,
    });
    const settled = harness.inset;
    const start = frame().props.rect as FrameRect;
    await act(async () => {
      frame().props.onRectChange({ ...start, x: 40, y: 40 }, { kind: 'move' });
    });
    expect(harness.inset).toEqual(settled);
    await act(async () => {
      frame().props.onRectChange(
        { ...start, x: 16, y: 16 },
        { kind: 'settle' },
      );
    });
    expect(harness.controller!.state.rect).toMatchObject({ x: 16, y: 16 });
    await result.unmount();
  });

  it('centres the empty Session state in the space beside its first floating placement', async () => {
    // The 1440 live geometry: a 946-wide transcript area. Whatever the reading column does, centred
    // content (the empty state's headline) must not sit under the frame.
    const { result, harness, frame } = await mountOpen(AGENT_PRESENCE, { width: 946, height: 705 });
    const rect = frame().props.rect as FrameRect;
    const centred = harness.inset.centred;
    expect(centred.left).toBe(0);
    expect(946 - centred.right).toBeLessThanOrEqual(rect.x - SESSION_VIEWER_EDGE);
    expect(946 - centred.right).toBeGreaterThan(0);
    await result.unmount();
  });

  it('sizes the frame to hold the switch, the Machine chip and the buttons side by side', async () => {
    const { result, frame } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    const layOut = async (testID: string, width: number) => {
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.find(
            (node) => node.props?.testID === testID && typeof node.props.onLayout === 'function',
          ),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } } },
        );
      });
    };
    await layOut('session-viewer-source-capsule', 150);
    await layOut('session-viewer-buttons-capsule', 90);
    const withoutChip = frame().props.minWidth as number;
    await layOut('session-viewer-machine', 100);
    // The chip's own width and the gap that separates it join the row.
    expect((frame().props.minWidth as number) - withoutChip).toBe(100 + 6);
    await result.unmount();
  });

  it('rests above where the composer band starts in the window, not only its height up from the area bottom', async () => {
    // Desktop: the workspace frame lifts the composer band off the window edge, so the band's
    // height alone puts the frame over the composer's status line. The band publishes its top.
    const { Dimensions } = await import('react-native');
    const windowHeight = Dimensions.get('window').height;
    const bandTopFromBottom = 200;
    function Composer() {
      const report = useReportSessionCockpitComposerChromeHeight(true);
      React.useEffect(() => { report(120, bandTopFromBottom); }, [report]);
      return null;
    }
    const harness: Harness = { controller: null, inset: NO_SESSION_VIEWER_INSET };
    const result = await renderWithAppProviders(
      <SessionCockpitChromeRegistryProvider>
        <Composer />
        <Tree harness={harness} presence={AGENT_PRESENCE} />
      </SessionCockpitChromeRegistryProvider>,
    );
    await act(async () => {
      harness.controller!.port.apply({ kind: 'viewer.open', source: 'computer' });
    });
    await act(async () => {
      invokeTestInstanceHandler(
        result.tree.root.findByProps({ testID: 'session-viewer-host' }),
        'onLayout',
        { nativeEvent: { layout: { x: 0, y: 0, width: 1400, height: windowHeight } } },
      );
    });
    const rect = result.tree.root.findByType(FloatingFrame).props.rect as FrameRect;
    expect(rect.y + rect.height).toBeLessThanOrEqual(windowHeight - bandTopFromBottom - SESSION_VIEWER_EDGE);
    await result.unmount();
  });

  it('keeps a live 16:10 picture floating when the room above the composer band is a sub-pixel under the controls’ ceil-rounded minimum', async () => {
    // The controls report their width rounded up (`Math.ceil`), while the room above the composer
    // band limits the picture by a fractional width: a shortfall below one pixel is the rounding,
    // not a frame too small to use (live: 375 px of room, a 16:10 picture and a 453 px minimum
    // gave 452.8 and docked the viewer the moment the live picture's footer appeared).
    const { Dimensions } = await import('react-native');
    const windowHeight = Dimensions.get('window').height;
    const aspect = 16 / 10;
    const minWidth = 453;
    const room = resolveFloatingFrameChromeHeight({ footer: true }) + (minWidth - 0.2) / aspect;
    const bandTopFromBottom = windowHeight - (room + SESSION_VIEWER_EDGE * 2);
    function Composer() {
      const report = useReportSessionCockpitComposerChromeHeight(true);
      React.useEffect(() => { report(300, bandTopFromBottom); }, [report]);
      return null;
    }
    const harness: Harness = { controller: null, inset: NO_SESSION_VIEWER_INSET };
    const result = await renderWithAppProviders(
      <SessionCockpitChromeRegistryProvider>
        <Composer />
        <Tree harness={harness} presence={AGENT_PRESENCE} aspectRatio={aspect} />
      </SessionCockpitChromeRegistryProvider>,
    );
    await act(async () => {
      harness.controller!.port.apply({ kind: 'viewer.open', source: 'computer' });
    });
    await act(async () => {
      invokeTestInstanceHandler(
        result.tree.root.findByProps({ testID: 'session-viewer-host' }),
        'onLayout',
        { nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: windowHeight } } },
      );
    });
    const layOut = async (testID: string, width: number) => {
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.find((node) => node.props?.testID === testID && typeof node.props.onLayout === 'function'),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } } },
        );
      });
    };
    await layOut('session-viewer-source-capsule', 300);
    await layOut('session-viewer-buttons-capsule', 90);
    await layOut('session-viewer-machine', 51);
    expect(harness.controller!.state.mode).toBe('floating');
    const frame = result.tree.root.findByType(FloatingFrame);
    expect(frame.props.minWidth).toBe(minWidth);
    // A real height shortfall is distinct from that rounding: the live 479 px composer at
    // window y480 and host y97 leaves 351 px after the two edge gutters. At the same measured
    // minimum, the picture plus footer cannot fit (the controls-only pending frame can).
    const measured = { rect: frame.props.rect as FrameRect,
      availableRect: { ...(frame.props.availableRect as FrameRect), height: 351 },
      aspectRatio: aspect, minWidth };
    expect(resolveFloatingFrameRect({ ...measured,
      chromeHeight: resolveFloatingFrameChromeHeight({ footer: false }) }).fits).toBe(true);
    const withFooter = resolveFloatingFrameRect({ ...measured,
      chromeHeight: resolveFloatingFrameChromeHeight({ footer: true }) });
    expect(withFooter.fits).toBe(false);
    expect(withFooter.rect.width).toBeCloseTo(414.4);
    await result.unmount();
  });

  it('docks when the area cannot hold a usable frame beside the composer', async () => {
    const { result, harness } = await mountOpen(AGENT_PRESENCE, {
      width: 1200,
      height: 70,
    });
    expect(harness.controller!.state.mode).toBe('docked');
    await result.unmount();
  });

  it('offers to float a docked desktop viewer again only once the area can hold the frame', async () => {
    const { result, harness } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    await act(async () => {
      harness.controller!.apply({ kind: 'viewer.dock' });
      invokeTestInstanceHandler(
        result.tree.root.findByProps({ testID: 'session-viewer-host' }),
        'onLayout',
        { nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 70 } } },
      );
    });
    expect(harness.controller!.state.mode).toBe('docked');
    expect(harness.controller!.floatFits).toBe(false);
    expect(harness.controller!.apply({ kind: 'viewer.float' }).status).toBe('unavailable');
    // The docked viewer keeps measuring its area: room returns (the composer shrank, the window grew).
    await act(async () => {
      invokeTestInstanceHandler(
        result.tree.root.findByProps({ testID: 'session-viewer-host' }),
        'onLayout',
        { nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } } },
      );
    });
    expect(harness.controller!.state.mode).toBe('docked');
    expect(result.tree.root.findAllByType(FloatingFrame)).toHaveLength(0);
    expect(harness.controller!.floatFits).toBe(true);
    // A resize may temporarily leave no area at all. A previous successful placement must not
    // keep Float available while the current geometry cannot present it.
    await act(async () => {
      invokeTestInstanceHandler(
        result.tree.root.findByProps({ testID: 'session-viewer-host' }),
        'onLayout',
        { nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 0 } } },
      );
    });
    expect(harness.controller!.floatFits).toBe(false);
    expect(harness.controller!.apply({ kind: 'viewer.float' }).status).toBe('unavailable');
    await act(async () => {
      invokeTestInstanceHandler(
        result.tree.root.findByProps({ testID: 'session-viewer-host' }),
        'onLayout',
        { nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } } },
      );
    });
    expect(harness.controller!.floatFits).toBe(true);
    await act(async () => {
      expect(harness.controller!.apply({ kind: 'viewer.float' }).status).toBe('applied');
    });
    expect(harness.controller!.state.mode).toBe('floating');
    expect(result.tree.root.findAllByType(FloatingFrame)).toHaveLength(1);
    await result.unmount();
  });

  it('returns a geometry-docked source to its floating presentation when resize restores room', async () => {
    const { result, harness } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 70 });
    try {
      expect(harness.controller!.state.mode).toBe('docked');
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.findByProps({ testID: 'session-viewer-host' }),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } } },
        );
      });
      expect(harness.controller!.state.mode).toBe('floating');
      expect(result.tree.root.findAllByType(FloatingFrame)).toHaveLength(1);
    } finally { await result.unmount(); }
  });

  it('fits an unavailable picture using the controls minimum instead of stretching a narrow retained placeholder aspect', async () => {
    const { result, harness } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 450 });
    try {
      await result.update(<Tree harness={harness} presence={AGENT_PRESENCE} aspectRatio={0} />);
      await act(async () => { harness.controller!.setRect({ x: 980, y: 30, width: 200, height: 312 }); });
      const layOut = async (testID: string, width: number) => {
        await act(async () => {
          invokeTestInstanceHandler(
            result.tree.root.find(node => node.props.testID === testID && typeof node.props.onLayout === 'function'),
            'onLayout',
            { nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } } },
          );
        });
      };
      await layOut('session-viewer-source-capsule', 300);
      await layOut('session-viewer-machine', 51);
      await layOut('session-viewer-buttons-capsule', 90);
      expect(harness.controller!.state.mode).toBe('floating');
      const frame = result.tree.root.findByType(FloatingFrame);
      expect(frame.props.minWidth).toBe(453);
      expect(frame.props.rect.width).toBeGreaterThanOrEqual(453);
      expect(frame.props.rect.height).toBeLessThanOrEqual(frame.props.availableRect.height);
    } finally { await result.unmount(); }
  });

});
