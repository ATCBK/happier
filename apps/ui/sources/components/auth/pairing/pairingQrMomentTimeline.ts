import { FURTHER_PLANET_MOMENT_TIMINGS } from '@happier-dev/brand/planet-moments';

const { QR, SCAN, PAIR } = FURTHER_PLANET_MOMENT_TIMINGS;

/** What the pairing panel's lifecycle says, reduced to what the moment answers. */
export type QrMomentPanel =
  | Readonly<{ kind: 'making' }>
  | Readonly<{ kind: 'ready'; link: string }>
  | Readonly<{ kind: 'adding'; device: string }>
  | Readonly<{ kind: 'joined'; device: string }>
  | Readonly<{ kind: 'other' }>;

/** The panel facts the moment reads (a subset of the panel's own state). */
export type PairingQrMomentSource =
    | Readonly<{ kind: 'making' }>
    | Readonly<{ kind: 'ready'; link: string; qrAvailable: boolean }>
    | Readonly<{ kind: 'adding' | 'joined'; device: string }>
    | Readonly<{ kind: 'other' }>;

/** Which panel facts a moment answers, given each moment's switch; everything else keeps the static block. */
export function qrMomentPanelOf(source: PairingQrMomentSource, switches: Readonly<{ qr: boolean; pairing: boolean }>): QrMomentPanel {
    const { qr, pairing } = switches;
    switch (source.kind) {
        case 'making':
            return qr ? source : { kind: 'other' };
        // The brand code always carries the mark in a 7 × 7 centre: at quartile when that costs no density,
        // otherwise at the admission level, where the centre is well under 1 % of a real invite's modules.
        case 'ready':
            return qr && source.qrAvailable ? { kind: 'ready', link: source.link } : { kind: 'other' };
        case 'adding':
        case 'joined':
            return qr || pairing ? source : { kind: 'other' };
        case 'other':
            return source;
    }
}

/** The moment's own memory: which event started what, and when (monotonic ms). */
export type QrMomentScene =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'making' }>
  | Readonly<{ kind: 'assemble'; link: string; atMs: number }>
  | Readonly<{
      kind: 'reform';
      from: string;
      atMs: number;
      next: string | null;
      nextAtMs: number | null;
    }>
  | Readonly<{
      kind: 'pairing';
      device: string;
      scan: Readonly<{ link: string; atMs: number }> | null;
      joinedAtMs: number | null;
    }>;

export const QR_MOMENT_NONE: QrMomentScene = { kind: 'none' };

function heldLink(scene: QrMomentScene): string | null {
  if (scene.kind === 'assemble') return scene.link;
  if (scene.kind === 'reform') return scene.next;
  return null;
}

/**
 * The panel's next state applied to the moment. Events start motion; nothing else does: the wait for a
 * code or for the Home's confirmation is never dressed up as progress.
 */
export function advanceQrMoment(
  scene: QrMomentScene,
  panel: QrMomentPanel,
  nowMs: number,
): QrMomentScene {
  const held = heldLink(scene);
  switch (panel.kind) {
    case 'other':
      return QR_MOMENT_NONE;
    case 'making':
      // An expiring code breaks into digits at once and waits, however long the new one takes.
      if (held !== null)
        return {
          kind: 'reform',
          from: held,
          atMs: nowMs,
          next: null,
          nextAtMs: null,
        };
      return scene.kind === 'reform' ? scene : { kind: 'making' };
    case 'ready':
      if (held === panel.link) return scene;
      if (scene.kind === 'reform' && scene.next === null)
        return { ...scene, next: panel.link, nextAtMs: nowMs };
      if (held !== null)
        return {
          kind: 'reform',
          from: held,
          atMs: nowMs,
          next: panel.link,
          nextAtMs: nowMs,
        };
      return { kind: 'assemble', link: panel.link, atMs: nowMs };
    case 'adding':
      if (scene.kind === 'pairing')
        return scene.device === panel.device
          ? scene
          : { ...scene, device: panel.device };
      return {
        kind: 'pairing',
        device: panel.device,
        scan: held === null ? null : { link: held, atMs: nowMs },
        joinedAtMs: null,
      };
    case 'joined':
      if (scene.kind === 'pairing')
        return scene.joinedAtMs === null
          ? { ...scene, device: panel.device, joinedAtMs: nowMs }
          : scene;
      return {
        kind: 'pairing',
        device: panel.device,
        scan: held === null ? null : { link: held, atMs: nowMs },
        joinedAtMs: nowMs,
      };
  }
}

/** One brand call: a QR frame of `link` (or a reform onto `next`), or a pairing frame. Times in seconds. */
export type QrMomentFrameRequest =
  | Readonly<{ draw: 'making' }>
  | Readonly<{ draw: 'qr'; link: string; t: number }>
  | Readonly<{
      draw: 'reform';
      from: string;
      next: string | null;
      t: number;
      wait: number | null;
    }>
  | Readonly<{ draw: 'scan'; link: string; t: number }>
  | Readonly<{
      draw: 'pairing';
      phase: 'handoff' | 'joined';
      t: number;
      device: string;
    }>;

export type QrMomentFrameSelection = Readonly<{
  request: QrMomentFrameRequest | null;
  /** Whether the next display frame differs; false holds the canvas with zero frames. */
  animating: boolean;
}>;

/**
 * The frame to draw at `nowMs`. With reduced motion every event lands on its rest frame (the caller
 * cross-fades); with `pairing` off the scan rests on the planet and nothing follows it.
 */
export function selectQrMomentFrame(
  scene: QrMomentScene,
  nowMs: number,
  options: Readonly<{ reducedMotion: boolean; pairing: boolean }>,
): QrMomentFrameSelection {
  const seconds = (fromMs: number) => (nowMs - fromMs) / 1000;
  const rm = options.reducedMotion;
  switch (scene.kind) {
    case 'none':
      return { request: null, animating: false };
    case 'making':
      return { request: { draw: 'making' }, animating: false };
    case 'assemble': {
      const t = rm ? QR.T : seconds(scene.atMs);
      return {
        request: { draw: 'qr', link: scene.link, t },
        animating: t < QR.T,
      };
    }
    case 'reform': {
      if (rm) {
        return scene.next === null
          ? {
              request: {
                draw: 'reform',
                from: scene.from,
                next: null,
                t: QR.BREAK,
                wait: null,
              },
              animating: false,
            }
          : {
              request: { draw: 'qr', link: scene.next, t: QR.T },
              animating: false,
            };
      }
      const t = seconds(scene.atMs);
      if (scene.next === null || scene.nextAtMs === null) {
        return {
          request: {
            draw: 'reform',
            from: scene.from,
            next: null,
            t: Math.min(t, QR.BREAK),
            wait: null,
          },
          animating: t < QR.BREAK,
        };
      }
      // The digits wait exactly as long as making the new code really took.
      const wait = Math.max(
        0,
        seconds(scene.atMs) - seconds(scene.nextAtMs) - QR.BREAK,
      );
      return {
        request: {
          draw: 'reform',
          from: scene.from,
          next: scene.next,
          t,
          wait,
        },
        animating: t < QR.BREAK + wait + QR.T,
      };
    }
    case 'pairing': {
      const scanEndMs = scene.scan ? scene.scan.atMs + SCAN.T * 1000 : null;
      if (
        scene.scan &&
        scanEndMs !== null &&
        ((nowMs < scanEndMs && !rm) || !options.pairing)
      ) {
        const t = rm ? SCAN.T : Math.min(seconds(scene.scan.atMs), SCAN.T);
        return {
          request: { draw: 'scan', link: scene.scan.link, t },
          animating: !rm && t < SCAN.T,
        };
      }
      if (!options.pairing) return { request: null, animating: false };
      // From the code, the planet settles on its horizon; without one, the scene starts settled.
      const handoffEndMs =
        scanEndMs === null ? null : scanEndMs + PAIR.HAND * 1000;
      if (
        scene.joinedAtMs === null ||
        (handoffEndMs !== null && nowMs < handoffEndMs && !rm)
      ) {
        const t =
          rm || scanEndMs === null
            ? PAIR.HAND
            : Math.min(seconds(scanEndMs), PAIR.HAND);
        return {
          request: {
            draw: 'pairing',
            phase: 'handoff',
            t,
            device: scene.device,
          },
          animating: t < PAIR.HAND || scene.joinedAtMs !== null,
        };
      }
      const joinedFromMs = Math.max(
        scene.joinedAtMs,
        handoffEndMs ?? scene.joinedAtMs,
      );
      const t = rm ? PAIR.T : Math.min(seconds(joinedFromMs), PAIR.T);
      return {
        request: { draw: 'pairing', phase: 'joined', t, device: scene.device },
        animating: t < PAIR.T,
      };
    }
  }
}
