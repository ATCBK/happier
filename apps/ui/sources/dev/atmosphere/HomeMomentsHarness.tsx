import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  ATMOSPHERE_PALETTE,
  ATMOSPHERE_PICTURES,
  lookFor,
} from '@happier-dev/brand/atmosphere';
import { PlanetCanvas } from '@/components/atmosphere/PlanetCanvas.web';
import { BackdropCanvas } from '@/components/atmosphere/BackdropCanvas.web';
import { AtmosphereRipple } from '@/components/atmosphere/AtmosphereRipple.web';
import type { AtmosphereRippleHandle } from '@/components/atmosphere/atmosphereRipple.types';
import { atmosphereResettleFact } from '@/components/atmosphere/atmosphereStage';
import { builtinPictureLocalId } from '@/components/atmosphere/ensureBuiltinPicture';
import {
  homePlanetGeometry,
  homePlanetSceneOptions,
} from '@/components/atmosphere/homePlanetPlacement';
import { pictureBackdropProps } from '@/components/atmosphere/pictureBackdrop';
import type { PictureRecord } from '@/components/atmosphere/pictureStore.types';
import {
  sessionRippleFrame,
  useSessionRipplePlayback,
} from '@/components/atmosphere/sessionRipple';

/**
 * U9b drawing harness: Home's session-finished ripple and idle resettle through the product's own
 * painters (PlanetCanvas, AtmosphereRipple, BackdropCanvas) at Home's real geometry. Stills are drawn
 * at a chosen instant; playback runs on the display's real frames for timing.
 */
type Theme = 'light' | 'dark';
const mount = document.getElementById('product');
if (!mount) throw new Error('Missing harness mount');
const root = createRoot(mount);
const pageOf = (theme: Theme) => ATMOSPHERE_PALETTE.page[theme];

function planetOptions(width: number, height: number, theme: Theme) {
  const pane = { width, height };
  return homePlanetSceneOptions(
    homePlanetGeometry('corner', pane, { widgets: true }),
    pane,
    { theme, style: 'balanced', digits: true },
  );
}

function RippleStill(
  props: Readonly<{
    width: number;
    height: number;
    theme: Theme;
    ms: number;
    reducedMotion: boolean;
    onReady: () => void;
  }>,
) {
  const options = planetOptions(props.width, props.height, props.theme);
  const frame = sessionRippleFrame(props.ms, {
    width: props.width,
    theme: props.theme,
    cx: options.cx,
    cy: options.cy,
    R: options.R,
    reducedMotion: props.reducedMotion,
  });
  const ring = React.useRef<AtmosphereRippleHandle>(null);
  React.useEffect(() => {
    ring.current?.paint(frame.ring);
  });
  const page =
    props.theme === 'dark'
      ? ([19, 17, 17] as const)
      : ([245, 245, 245] as const);
  return (
    <div
      style={{
        position: 'relative',
        width: props.width,
        height: props.height,
        overflow: 'hidden',
        background: pageOf(props.theme),
      }}
    >
      <PlanetCanvas
        width={props.width}
        height={props.height}
        options={frame.gain === 1 ? options : { ...options, gain: frame.gain }}
        onReady={props.onReady}
      />
      {frame.ring ? (
        <AtmosphereRipple
          ref={ring}
          width={props.width}
          height={props.height}
          theme={props.theme}
          page={page}
        />
      ) : null}
    </div>
  );
}

function RipplePlay(
  props: Readonly<{
    width: number;
    height: number;
    theme: Theme;
    reducedMotion: boolean;
    answers: number;
  }>,
) {
  const options = planetOptions(props.width, props.height, props.theme);
  const ring = React.useRef<AtmosphereRippleHandle>(null);
  const playback = useSessionRipplePlayback(
    props.answers,
    {
      width: props.width,
      theme: props.theme,
      cx: options.cx,
      cy: options.cy,
      R: options.R,
      reducedMotion: props.reducedMotion,
    },
    ring,
  );
  const page =
    props.theme === 'dark'
      ? ([19, 17, 17] as const)
      : ([245, 245, 245] as const);
  const lit = React.useMemo(
    () => (playback.gain === 1 ? options : { ...options, gain: playback.gain }),
    // The options are rebuilt per render here; their values only change with the inputs below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playback.gain, props.width, props.height, props.theme],
  );
  return (
    <div
      style={{
        position: 'relative',
        width: props.width,
        height: props.height,
        overflow: 'hidden',
        background: pageOf(props.theme),
      }}
    >
      <PlanetCanvas width={props.width} height={props.height} options={lit} />
      {playback.ringShown ? (
        <AtmosphereRipple
          ref={ring}
          width={props.width}
          height={props.height}
          theme={props.theme}
          page={page}
        />
      ) : null}
    </div>
  );
}

async function pictureRecord(id: string, file: string): Promise<PictureRecord> {
  const blob = await (await fetch(file)).blob();
  return {
    localId: builtinPictureLocalId(id),
    kind: 'builtin',
    createdAtMs: 0,
    size: blob.size,
    data: blob,
  };
}

function Band(
  props: Readonly<{
    source: PictureRecord;
    id: string;
    theme: Theme;
    width: number;
    height: number;
    onReady: () => void;
  }>,
) {
  const picture =
    ATMOSPHERE_PICTURES.find((entry) => entry.id === props.id) ?? null;
  const job = pictureBackdropProps({
    picture,
    look: lookFor(props.id),
    theme: props.theme,
    page: props.theme === 'dark' ? [19, 17, 17] : [245, 245, 245],
    layout: 'horizon',
    horizonAt: picture?.horizon.at ?? 0.6,
  });
  return (
    <BackdropCanvas
      source={props.source}
      size={{ width: props.width, height: props.height }}
      {...job}
      onReady={props.onReady}
    />
  );
}

const harness = {
  rippleStill(
    input: Readonly<{
      width: number;
      height: number;
      theme: Theme;
      ms: number;
      reducedMotion?: boolean;
    }>,
  ) {
    document.body.style.background = pageOf(input.theme);
    return new Promise<void>((resolve) =>
      root.render(
        <RippleStill
          {...input}
          reducedMotion={input.reducedMotion === true}
          onReady={resolve}
        />,
      ),
    );
  },
  /** Plays one answer on real frames; reports the display's frame intervals while it runs. */
  async ripplePlay(
    input: Readonly<{
      width: number;
      height: number;
      theme: Theme;
      reducedMotion?: boolean;
    }>,
  ) {
    document.body.style.background = pageOf(input.theme);
    const render = (answers: number) =>
      root.render(
        <RipplePlay
          {...input}
          reducedMotion={input.reducedMotion === true}
          answers={answers}
        />,
      );
    render(0);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const intervals: number[] = [];
    const done = new Promise<void>((resolve) => {
      let last: number | null = null;
      const until = performance.now() + 1800;
      const tick = (time: number) => {
        if (last !== null) intervals.push(time - last);
        last = time;
        if (time < until) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    // Chrome's long animation frames say whether a slow frame was script or rendering.
    const frames: { start: number; duration: number; script: number; render: number }[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { renderStart: number; scripts: { duration: number }[] })[]) {
        frames.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration),
          script: Math.round(entry.scripts.reduce((sum, script) => sum + script.duration, 0)),
          render: Math.round(entry.startTime + entry.duration - entry.renderStart) });
      }
    });
    observer.observe({ type: 'long-animation-frame', buffered: false });
    const startedAt = Math.round(performance.now());
    render(1);
    await done;
    observer.disconnect();
    (window as unknown as { __loaf: unknown }).__loaf = frames.map((frame) => ({ ...frame, start: frame.start - startedAt }));
    return intervals;
  },
  async resettleMount(
    input: Readonly<{
      theme: Theme;
      width: number;
      height: number;
      fromId: string;
      fromFile: string;
    }>,
  ) {
    document.body.style.background = pageOf(input.theme);
    const source = await pictureRecord(input.fromId, input.fromFile);
    await new Promise<void>((resolve) =>
      root.render(
        <Band
          source={source}
          id={input.fromId}
          theme={input.theme}
          width={input.width}
          height={input.height}
          onReady={resolve}
        />,
      ),
    );
  },
  async resettleTo(
    input: Readonly<{
      theme: Theme;
      width: number;
      height: number;
      toId: string;
      toFile: string;
      reducedMotion?: boolean;
    }>,
  ) {
    const source = await pictureRecord(input.toId, input.toFile);
    atmosphereResettleFact.announce(
      source.localId,
      input.reducedMotion === true,
    );
    await new Promise<void>((resolve) =>
      root.render(
        <Band
          source={source}
          id={input.toId}
          theme={input.theme}
          width={input.width}
          height={input.height}
          onReady={resolve}
        />,
      ),
    );
  },
  /** Per-frame costs on this host: a planet repaint at a new gain, and one ring frame at a few progresses. */
  async costs(input: Readonly<{ width: number; height: number; theme: Theme }>) {
    const options = planetOptions(input.width, input.height, input.theme);
    const page = input.theme === 'dark' ? ([19, 17, 17] as const) : ([245, 245, 245] as const);
    let handle: AtmosphereRippleHandle | null = null;
    const view = (gain: number) => (
      <div style={{ position: 'relative', width: input.width, height: input.height }}>
        <PlanetCanvas width={input.width} height={input.height} options={gain === 1 ? options : { ...options, gain }} />
        <AtmosphereRipple ref={(next) => { handle = next; }} width={input.width} height={input.height} theme={input.theme} page={page} />
      </div>
    );
    flushSync(() => root.render(view(1)));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const planet: number[] = [];
    for (let i = 1; i <= 12; i++) {
      const started = performance.now();
      flushSync(() => root.render(view(1 + i * 0.015)));
      planet.push(performance.now() - started);
    }
    const ring: Record<string, number> = {};
    for (const progress of [0.05, 0.15, 0.3, 0.6, 0.9]) {
      const started = performance.now();
      handle!.paint({ progress, x: options.cx, y: options.cy });
      ring[progress] = +(performance.now() - started).toFixed(1);
    }
    return { planetRepaintMs: planet.map((value) => +value.toFixed(1)), ringPaintMs: ring };
  },
  unmount() {
    root.unmount();
  },
};

declare global {
  interface Window {
    U9H: typeof harness;
  }
}
window.U9H = harness;
