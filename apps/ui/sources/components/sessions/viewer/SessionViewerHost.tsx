import * as React from 'react';
import { BackHandler, Platform, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  FloatingFrame,
  HAPPIER_FLOATING_FRAME_METRICS,
  resolveFloatingFrameBodyRect,
  resolveFloatingFrameChromeHeight,
  resolveFloatingFrameCornerRect,
  resolveFloatingFrameHeight,
  resolveFloatingFrameRect,
  resolveFloatingFrameSettleTransition,
  type CompanionReleaseMotion,
  type FloatingFrameMode,
  type FloatingFrameRectChange,
  type FrameRect,
} from '@happier-dev/plugin-ui/presentation';

import { COMPANION_WEB_POINTER_BINDING } from '@/components/companion/interaction/useCompanionPointerDragSession';
import { NativeFloatingFrame } from '@/components/companion/interaction/NativeFloatingFrame';
import { SessionComputerScreenPane } from '@/components/computer/SessionComputerScreenPane';
import { SessionRightPanelBrowserView } from '@/components/sessions/panes/browser/SessionRightPanelBrowserView';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { VOICE_MOTION } from '@/components/voice/light/voiceLightTokens';
import {
  useSessionCockpitComposerChromeHeight,
  useSessionCockpitComposerChromeTop,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { RetainedPresentationGeometryTransition } from '@/components/ui/presentation/retainedPresentationSlots';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { t } from '@/text';

import {
  useOptionalSessionViewerController,
  useSessionViewerHasPresence,
  type SessionViewerController,
} from './SessionViewerController';
import { SessionViewerControls, type SessionViewerFrameCommands } from './SessionViewerControls';
import { SessionViewerPresenceFooter } from './SessionViewerPresenceFooter';
import type { SessionViewerSource } from './sessionViewerPresentation';
import {
  resolveSessionViewerWatchingLabel,
  useSessionViewerMachine,
  useSessionViewerMachineId,
} from './useSessionViewerMachine';
import {
  DEFAULT_WIDTH_SHARE,
  SESSION_VIEWER_EDGE,
  resolveSessionViewerBodyAspect,
} from './sessionViewerGeometry';




/**
 * A released viewer aims where the throw points (the same projection the floating presences use)
 * and travels there for the travel spring's duration on the frame's critically damped settle curve.
 * The frame reads only the duration and the projection; the retained body, drawn in its own layer,
 * takes the same settle transition from the frame's owner.
 */
const SESSION_VIEWER_RELEASE_MOTION: CompanionReleaseMotion = Object.freeze({
  durationMs: motionTokens.spring.travel.durationMs,
  dampingRatio: motionTokens.spring.travel.dampingRatio,
  overshootClamping: false,
  carryVelocity: false,
  projectionSeconds: VOICE_MOTION.throwProjectionSeconds,
});
const SESSION_VIEWER_SETTLE = resolveFloatingFrameSettleTransition(
  SESSION_VIEWER_RELEASE_MOTION,
);
/** The viewer floats over the transcript and under the session's popovers and sheets. */
const SESSION_VIEWER_LAYER = 20;

type Size = Readonly<{ width: number; height: number }>;
type Point = Readonly<{ x: number; y: number }>;

function offsetRect(rect: FrameRect, origin: Point): FrameRect {
  return {
    x: rect.x + origin.x,
    y: rect.y + origin.y,
    width: rect.width,
    height: rect.height,
  };
}


/**
 * The Session's floating viewer on desktop, and its expanded overlay on every device: one
 * `FloatingFrame` around the retained Computer or Browser body. The floating frame lies above
 * everything in the Session area (reading column, composer, Voice and pet presences) and moves
 * nothing behind it; the person places it and only the area's edges bound it. Phone docking is
 * the transcript's sticky slot.
 */
export function SessionViewerHost(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    pluginProjection?: PluginUiProjectionCurrentness;
    /**
     * The picture drawn inside the frame in place of the Session's retained Computer/Browser body.
     * Only the dev specimen passes one (a fixture stream, so the frame can be judged without a
     * Machine); the Session never does.
     */
    body?: React.ReactNode;
  }>,
): React.ReactElement | null {
  const controller = useOptionalSessionViewerController();
  const state = controller?.state;
  const source = state?.source ?? null;
  const shown = Boolean(
    controller &&
    source &&
    (state?.mode === 'expanded' || (!controller.phone && state?.mode === 'floating')),
  );
  if (!controller || !source || !shown) return null;
  return (
    <MountedSessionViewerHost
      {...props}
      controller={controller}
      source={source}
    />
  );
}

function MountedSessionViewerHost(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    pluginProjection?: PluginUiProjectionCurrentness;
    body?: React.ReactNode;
    controller: SessionViewerController;
    source: SessionViewerSource;
  }>,
): React.ReactElement {
  const { controller, source } = props;
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const containerRef = React.useRef<View | null>(null);
  const [size, setSize] = React.useState<Size | null>(null);
  const [origin, setOrigin] = React.useState<Point>({ x: 0, y: 0 });
  const [liveRect, setLiveRect] = React.useState<FrameRect | null>(null);
  const composerHeight = useSessionCockpitComposerChromeHeight();
  const composerTop = useSessionCockpitComposerChromeTop();
  const { height: windowHeight } = useWindowDimensions();
  const mode: FloatingFrameMode = controller.state.mode;
  const floating = mode === 'floating' && !controller.phone;

  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current && current.width === width && current.height === height
        ? current
        : { width, height },
    );
    containerRef.current?.measureInWindow?.((x, y) => {
      if (Number.isFinite(x) && Number.isFinite(y)) {
        setOrigin((current) =>
          current.x === x && current.y === y ? current : { x, y },
        );
      }
    });
  }, []);

  // Where the composer band starts: the expanded overlay takes over the reading area above it, and
  // a first placement opens in that area's corner rather than over the send box. On desktop the
  // workspace frame lifts the band off the area's bottom edge, so its height alone would put either
  // over the composer's status line; the band's measured top (window space) says where it begins.
  const composerStart = React.useMemo(() => {
    if (!size) return null;
    return composerTop > 0
      ? Math.min(size.height, windowHeight - composerTop - origin.y)
      : size.height - composerHeight;
  }, [composerHeight, composerTop, origin.y, size, windowHeight]);
  const readingRect = React.useMemo<FrameRect | null>(() => {
    if (!size || composerStart === null) return null;
    return {
      x: SESSION_VIEWER_EDGE,
      y: SESSION_VIEWER_EDGE,
      width: Math.max(0, size.width - SESSION_VIEWER_EDGE * 2),
      height: Math.max(0, composerStart - SESSION_VIEWER_EDGE * 2),
    };
  }, [composerStart, size]);
  // The only bound of a floating frame is the area itself (its edges and safe areas).
  const areaRect = React.useMemo<FrameRect | null>(() => {
    if (!size) return null;
    return {
      x: SESSION_VIEWER_EDGE,
      y: SESSION_VIEWER_EDGE,
      width: Math.max(0, size.width - SESSION_VIEWER_EDGE * 2),
      height: Math.max(0, size.height - SESSION_VIEWER_EDGE * 2),
    };
  }, [size]);
  const availableRect = mode === 'expanded' ? readingRect : areaRect;

  const committedRect = controller.state.rect;
  // The width the person gave the frame (null until they place it, or one was already held). The
  // area may shrink the frame below it but never rewrites it, so the shape asked for stays stable
  // while the area clamps, and the frame returns to this width when the area grows back.
  const placedRef = React.useRef<Readonly<{ width: number }> | null>(committedRect ? { width: committedRect.width } : null);
  const { setRect, apply, requestSemantic } = controller;
  const facts = controller.facts[source];
  // The narrowest frame whose controls still fit across, as the controls measured themselves.
  const [minWidth, setMinWidth] = React.useState(0);
  // The picture's own shape once its source reports it; until then the lab's 16:10, or taller where a
  // state card needs the room. The frame's width is where it rests, or the first floating width.
  const defaultWidth = readingRect ? Math.round(readingRect.width * DEFAULT_WIDTH_SHARE) : 0;
  const frameWidth = Math.max(minWidth, placedRef.current?.width ?? defaultWidth);
  const aspectRatio = resolveSessionViewerBodyAspect(facts?.aspectRatio, frameWidth);
  const watching = facts?.watching === true;
  const footer = useSessionViewerHasPresence(source);
  const chromeHeight = resolveFloatingFrameChromeHeight({ footer });
  // Open, viewport, aspect and footer changes revalidate the settled placement at the one geometry
  // owner: it clamps to the area and shrinks a frame the area cannot hold. The height always follows
  // the width through the picture's aspect.
  React.useEffect(() => {
    if (!floating || !areaRect || !readingRect || areaRect.width <= 0 || areaRect.height <= 0) return;
    const kept = committedRect !== null && placedRef.current !== null ? committedRect : null;
    const width = placedRef.current?.width ?? defaultWidth;
    const sized = { width, height: resolveFloatingFrameHeight(width, aspectRatio, { footer }) };
    const corner = resolveFloatingFrameCornerRect('br', sized, readingRect);
    const desired = kept
      ? { ...kept, ...sized }
      : (() => {
          // The default fits the reading area when it can; the area clamp below is then a no-op.
          const fitted = resolveFloatingFrameRect({ rect: corner, availableRect: readingRect, aspectRatio, chromeHeight, minWidth });
          return fitted.fits ? fitted.rect : corner;
        })();
    const placement = resolveFloatingFrameRect({
      rect: desired,
      availableRect: areaRect,
      aspectRatio,
      chromeHeight,
      minWidth,
    });
    if (!placement.fits) return;
    const next = placement.rect;
    if (
      !committedRect ||
      next.x !== committedRect.x ||
      next.y !== committedRect.y ||
      next.width !== committedRect.width ||
      next.height !== committedRect.height
    )
      setRect(next);
  }, [areaRect, aspectRatio, chromeHeight, committedRect, defaultWidth, floating, footer, minWidth, readingRect, setRect]);

  const rect = liveRect ?? committedRect;

  const onRectChange = React.useCallback(
    (next: FrameRect, change: FloatingFrameRectChange) => {
      if (change.kind === 'move') {
        setLiveRect(next);
        return;
      }
      placedRef.current = { width: next.width };
      setLiveRect(null);
      setRect(next);
    },
    [setRect],
  );
  // Menu geometry goes through the mounted owner's local validator, then the one placement owner.
  const geometryRef = React.useRef({ rect: committedRect, availableRect: areaRect, aspectRatio, chromeHeight, footer, minWidth });
  geometryRef.current = { rect: committedRect, availableRect: areaRect, aspectRatio, chromeHeight, footer, minWidth };
  const frameCommands = React.useMemo<SessionViewerFrameCommands>(() => {
    const place = (next: FrameRect) => {
      const { availableRect: available, aspectRatio: aspect, chromeHeight: chrome, minWidth: min } = geometryRef.current;
      if (!available) return;
      const placement = resolveFloatingFrameRect({
        rect: next, availableRect: available, aspectRatio: aspect, chromeHeight: chrome, minWidth: min,
      });
      if (!placement.fits) return;
      placedRef.current = { width: placement.rect.width };
      setRect(placement.rect);
    };
    return {
      moveToCorner: (corner) => {
        const { rect: current, availableRect: available } = geometryRef.current;
        if (!current || !available) return;
        if (apply({ kind: 'viewer.corner.set', corner }).status === 'unavailable') return;
        place(resolveFloatingFrameCornerRect(corner, current, available));
      },
      resize: (direction) => {
        const { rect: current, availableRect: available, aspectRatio: aspect, footer: withFooter } = geometryRef.current;
        if (!current || !available) return;
        const step = 1 + HAPPIER_FLOATING_FRAME_METRICS.resizeStep;
        const width = Math.min(available.width, current.width * (direction === 'larger' ? step : 1 / step));
        if (apply({ kind: 'viewer.size.set', width }).status !== 'applied') return;
        const right = current.x + current.width;
        place({ x: right - width, y: current.y, width, height: resolveFloatingFrameHeight(width, aspect, { footer: withFooter }) });
      },
    };
  }, [apply, setRect]);
  const onModeChange = React.useCallback(
    (next: FloatingFrameMode) => {
      if (next === 'expanded') void requestSemantic({ kind: 'viewer.expand' });
      else if (next === 'floating') void requestSemantic({ kind: 'viewer.restore' });
      else void requestSemantic({ kind: 'viewer.close' });
    },
    [requestSemantic],
  );

  // Android's hardware Back leaves the deliberate expanded overlay for where the viewer was.
  // Only Android has that event; React Native Web reports BackHandler as unsupported.
  const expanded = mode === 'expanded';
  React.useEffect(() => {
    if (Platform.OS !== 'android' || !expanded) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void requestSemantic({ kind: 'viewer.restore' });
      return true;
    });
    return () => subscription.remove();
  }, [expanded, requestSemantic]);

  const frameRect = mode === 'expanded' ? availableRect : rect;
  const bodyRect = frameRect ? resolveFloatingFrameBodyRect(frameRect, { footer }) : null;
  const windowGeometry = bodyRect && size ? offsetRect(bodyRect, origin) : null;
  const transition = liveRect || reducedMotion ? null : SESSION_VIEWER_SETTLE;
  const machine = useSessionViewerMachine(props.sessionId, props.serverId, source);

  return (
    <View
      ref={containerRef}
      onLayout={onLayout}
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        zIndex: SESSION_VIEWER_LAYER,
      }}
      testID="session-viewer-host"
    >
      {/* An expanded viewer takes over the transcript's pane: its controls band floats on the page's own paper,
          so the conversation never reads through the gaps and glass of the capsules above the picture. */}
      {expanded && composerStart !== null ? (
        <View
          testID="session-viewer-expanded-backing"
          style={{ position: 'absolute', left: 0, top: 0, right: 0, height: composerStart, backgroundColor: theme.colors.surface.base }}
        />
      ) : null}
      {availableRect && frameRect ? (
        <FloatingFrame
          testID="session-viewer-frame"
          mode={mode === 'expanded' ? 'expanded' : 'floating'}
          rect={frameRect}
          availableRect={availableRect}
          aspectRatio={aspectRatio}
          minWidth={minWidth}
          // The retained body paints in the route-stable portal above this frame. While it is only
          // watched it lets the pointer through, so the picture moves (and double-click expands)
          // the frame; while the person drives it, the picture's input is the content's own.
          moveInput={watching ? 'surface' : 'chrome'}
          onRectChange={onRectChange}
          onModeChange={onModeChange}
          accessibilityLabel={resolveSessionViewerWatchingLabel(source, machine.name, machine.targetTitle)}
          resizeLabel={t('computerUse.presentation.resizeView')}
          pointer={
            Platform.OS === 'web' ? COMPANION_WEB_POINTER_BINDING : undefined
          }
          nativeBinding={NativeFloatingFrame}
          releaseMotion={SESSION_VIEWER_RELEASE_MOTION}
          reducedMotion={reducedMotion}
          // Hover reaches the frame only through a watched picture; a driven picture keeps them shown.
          // (A pointer that cannot hover keeps them shown at the frame's own reveal rule.)
          controlsAlwaysVisible={controller.phone || !watching}
          colors={{
            grip: theme.colors.text.tertiary,
            focusRing: theme.colors.border.focus,
          }}
          controls={
            <SessionViewerControls
              sessionId={props.sessionId}
              serverId={props.serverId}
              source={source}
              frame={frameCommands}
              onMinWidthChange={setMinWidth}
            />
          }
          footer={
            footer ? (
              <SessionViewerPresenceFooter
                sessionId={props.sessionId}
                serverId={props.serverId}
                source={source}
                compact={controller.phone}
                frameWidth={frameRect.width}
              />
            ) : undefined
          }
        >
          {props.body ?? (
            <SessionViewerBody
              sessionId={props.sessionId}
              serverId={props.serverId}
              source={source}
              pluginProjection={props.pluginProjection}
              windowGeometry={windowGeometry}
              transition={transition}
              inputPassthrough={watching}
            />
          )}
        </FloatingFrame>
      ) : props.body ? null : (
        // Claim the same retained slot while this replacement host awaits layout.
        // The portal keeps its last valid placement until the frame can supply a new one.
        <SessionViewerBody
          sessionId={props.sessionId}
          serverId={props.serverId}
          source={source}
          pluginProjection={props.pluginProjection}
          windowGeometry={null}
          inputPassthrough={watching}
        />
      )}
    </View>
  );
}

/**
 * The retained source body for the viewer's presentation. Geometry flows to the slot binder; the
 * source body element itself is created once per source/identity so a moving frame never
 * re-renders the stream or control owners.
 */
export function SessionViewerBody(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    source: SessionViewerSource;
    machineId?: string | null;
    pluginProjection?: PluginUiProjectionCurrentness;
    windowGeometry?: FrameRect | null;
    transition?: RetainedPresentationGeometryTransition | null;
    /** The watched picture lets the pointer reach the frame beneath it. */
    inputPassthrough?: boolean;
  }>,
): React.ReactElement | null {
  // Computer use targets the Session's own machine (the same rule the Watch opener applies), named
  // even while it is unreachable so the Computer viewer can say so.
  const sessionMachineId = useSessionViewerMachineId(props.sessionId, props.serverId);
  const machineId = props.machineId ?? sessionMachineId;
  if (props.source === 'computer') {
    if (!machineId) return null;
    return (
      <SessionComputerScreenPane
        sessionId={props.sessionId}
        serverId={props.serverId}
        machineId={machineId}
        presentation="viewer"
        windowGeometry={props.windowGeometry}
        transition={props.transition}
        inputPassthrough={props.inputPassthrough}
        testID="session-viewer-computer"
      />
    );
  }
  return (
    <SessionRightPanelBrowserView
      sessionId={props.sessionId}
      pluginProjection={props.pluginProjection}
      presentation="viewer"
      windowGeometry={props.windowGeometry}
      transition={props.transition}
      inputPassthrough={props.inputPassthrough}
    />
  );
}
