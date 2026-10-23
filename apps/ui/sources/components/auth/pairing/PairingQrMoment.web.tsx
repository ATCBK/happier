import * as React from 'react';
import { View } from 'react-native';
import {
  loadMomentFonts,
  paintMomentCommands,
  prepareMomentCanvas,
} from '@/components/atmosphere/momentPaint.web';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import {
  selectQrMomentFrame,
  type QrMomentFrameRequest,
  type QrMomentScene,
} from './pairingQrMomentTimeline';
import type { PairingQrMomentCanvasProps } from './pairingQrMoment.types';
import { createPairingQrMomentFrames } from './pairingQrMomentFrame';

export const PAIRING_QR_MOMENT_SUPPORTED = true;

const defaultFrames = createPairingQrMomentFrames();

let markImage: HTMLImageElement | null = null;
function happierMark(): HTMLImageElement | null {
  if (markImage || typeof Image === 'undefined') return markImage;
  const source = require('@/assets/images/logo-black.png') as unknown;
  const uri =
    typeof source === 'string'
      ? source
      : ((source as { uri?: string; default?: { uri?: string } | string })
          ?.uri ??
        (
          (source as { default?: { uri?: string } | string })?.default as
            | { uri?: string }
            | undefined
        )?.uri ??
        (typeof (source as { default?: unknown })?.default === 'string'
          ? (source as { default: string }).default
          : ''));
  markImage = new Image();
  markImage.src = uri;
  return markImage;
}

/** Paints one frame request; the component's loop and the drawing harness share it. */
export function paintPairingQrMomentRequest(
  canvas: HTMLCanvasElement,
  request: QrMomentFrameRequest,
  props: PairingQrMomentCanvasProps,
  dpr: number,
  build = defaultFrames,
) {
  const { size } = props;
  const context = prepareMomentCanvas(canvas, size, size, dpr);
  if (!context) return;
  const env = { w: size, h: size, dpr, mark: happierMark() };
  paintMomentCommands(context, build(request, props, dpr), env);
}

const sameRequest = (
  a: QrMomentFrameRequest | null,
  b: QrMomentFrameRequest | null,
) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The pairing code block as the brand moment (lab `mo-qr` / `mo-pair`, square card layout): digits
 * assemble into the exact code, an expiring code re-forms, a scan folds it into the planet, and the
 * new machine lights on the horizon when the Home confirms. Frames run only while something moves;
 * a held code costs nothing. Under reduced motion each event lands on its rest frame with a short
 * cross-fade, as the lab specifies.
 */
export const PairingQrMomentCanvas = React.memo(function PairingQrMomentCanvas(
  props: PairingQrMomentCanvasProps & Readonly<{ scene: QrMomentScene }>,
) {
  const build = React.useMemo(createPairingQrMomentFrames, []);
  const live = React.useRef<HTMLCanvasElement | null>(null);
  const previous = React.useRef<HTMLCanvasElement | null>(null);
  const latest = React.useRef(props);
  latest.current = props;
  const shown = React.useRef<QrMomentFrameRequest | null>(null);
  const paintedFor = React.useRef('');
  const { scene, size, theme, reducedMotion, pairing } = props;
  const activelyViewed = useHostActivelyViewed();
  const presented = useLayoutPresentationActive();
  const visible = activelyViewed && presented;

  React.useEffect(() => {
    if (!visible) return;
    const canvas = live.current;
    if (!canvas) return;
    const dpr =
      typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    let frame = 0;
    let cancelled = false;
    const crossFade = () => {
      const under = previous.current;
      if (!under) return;
      const context = prepareMomentCanvas(under, size, size, dpr);
      if (!context) return;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(canvas, 0, 0);
      under.style.transition = 'none';
      under.style.opacity = '1';
      void under.offsetWidth;
      under.style.transition = `opacity ${motionTokens.atmosphere.reducedCrossFadeMs}ms ease-out`;
      under.style.opacity = '0';
    };
    const step = () => {
      if (cancelled) return;
      const selection = selectQrMomentFrame(scene, performance.now(), {
        reducedMotion,
        pairing,
      });
      // A theme, size or machine change repaints the frame on screen without a cross-fade.
      const key = `${theme}|${size}|${latest.current.machines.join('\u0000')}`;
      const repaint = key !== paintedFor.current;
      if (selection.request && (repaint || !sameRequest(selection.request, shown.current))) {
        if (reducedMotion && shown.current && !repaint) crossFade();
        paintedFor.current = key;
        paintPairingQrMomentRequest(canvas, selection.request, latest.current, dpr, build);
        shown.current = selection.request;
      }
      if (selection.animating)
        frame = requestAnimationFrame(step);
    };
    void loadMomentFonts().then(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [scene, size, theme, reducedMotion, pairing, props.machines, visible]);

  return (
    <View pointerEvents="none" style={{ width: size, height: size }}>
      <canvas
        ref={live}
        aria-hidden
        style={{ position: 'absolute', inset: 0, width: size, height: size }}
      />
      <canvas
        ref={previous}
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          width: size,
          height: size,
          opacity: 0,
        }}
      />
    </View>
  );
});
