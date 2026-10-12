import * as React from 'react';
import { FURTHER_PLANET_MOMENT_TIMINGS, sessionFinishedRippleFrame } from '@happier-dev/brand/planet-moments';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { ATMOSPHERE_RIPPLE_RING } from './AtmosphereRipple';
import type { AtmosphereRippleHandle } from './atmosphereRipple.types';

/**
 * The session-finished ripple as Home's planet plays it (plan UD-4): the brand's frame at Home's real
 * geometry, one clock for the planet's gain and the ring. Admission lives in `homeAtmosphereMoments`.
 */
export type SessionRippleFrame = Readonly<{
  /** The planet's brightness: the brand's gain for this instant, 1 at rest. */
  gain: number;
  /** The ring's normalized progress and its origin (the planet's centre, css px), or none. */
  ring: Readonly<{ progress: number; x: number; y: number }> | null;
  done: boolean;
}>;

const { RIP } = FURTHER_PLANET_MOMENT_TIMINGS;
/** The brand curve holds its full +22 % between 8 % and 10 % of the ripple; the reduced path starts there. */
const REDUCED_PEAK_SECONDS = RIP.DUR * 0.1;

/**
 * One instant of the ripple on Home's real planet. The full moment is the brand frame (its gain and the
 * ring's progress) at Home's geometry; under reduced motion the planet brightens to the brand's peak
 * and settles back in the shared cross-fade time, and no ring travels.
 */
export function sessionRippleFrame(
  elapsedMs: number,
  input: Readonly<{
    width: number;
    theme: 'light' | 'dark';
    cx: number;
    cy: number;
    R: number;
    reducedMotion: boolean;
  }>,
): SessionRippleFrame {
  const options = {
    w: input.width,
    theme: input.theme,
    px: input.width - input.cx,
    py: input.cy,
    R: input.R,
  };
  if (input.reducedMotion) {
    const settle = motionTokens.atmosphere.reducedCrossFadeMs;
    if (elapsedMs >= settle) return { gain: 1, ring: null, done: true };
    const peak = sessionFinishedRippleFrame(REDUCED_PEAK_SECONDS, options)
      .planet.gain;
    return {
      gain: 1 + (peak - 1) * (1 - elapsedMs / settle),
      ring: null,
      done: false,
    };
  }
  const frame = sessionFinishedRippleFrame(elapsedMs / 1000, options);
  const ring =
    frame.ringProgress === null
      ? null
      : {
          progress: frame.ringProgress,
          x: frame.planet.cx,
          y: frame.planet.cy,
        };
  const done = elapsedMs >= RIP.DUR * 1000;
  return { gain: done ? 1 : frame.planet.gain, ring: done ? null : ring, done };
}

/**
 * Plays each answer on Home's planet: one clock (the display's frames) drives the planet's gain and the
 * ring together for the brand's 1.6 s, or the 140 ms settle under reduced motion, then stops. Platforms
 * that draw no ring play the reduced answer.
 */
export function useSessionRipplePlayback(
    answers: number,
    input: Parameters<typeof sessionRippleFrame>[1] & Readonly<{ paused?: boolean }>,
    ring: React.RefObject<AtmosphereRippleHandle | null>,
): Readonly<{ gain: number; ringShown: boolean }> {
    const [gain, setGain] = React.useState(1);
    const [ringShown, setRingShown] = React.useState(false);
    const latest = React.useRef(input);
    latest.current = input;
    const progress = React.useRef({ answer: 0, elapsedMs: 0, done: true, reducedMotion: false, reducedMotionPreference: input.reducedMotion });
    React.useEffect(() => {
        if (answers === 0) return;
        const current = progress.current;
        const reduceSelected = latest.current.reducedMotion && !current.reducedMotionPreference;
        current.reducedMotionPreference = latest.current.reducedMotion;
        if (current.answer !== answers) {
            current.answer = answers;
            current.elapsedMs = 0;
            current.done = false;
            current.reducedMotion = latest.current.reducedMotion || !ATMOSPHERE_RIPPLE_RING;
            setGain(1);
            setRingShown(!current.reducedMotion);
        } else if (reduceSelected && !current.done) {
            // A newly selected preference settles the existing answer instead of replaying it.
            current.done = true;
            setGain(1);
            setRingShown(false);
            ring.current?.paint(null);
        }
        if (current.done || latest.current.paused) return;
        let last = performance.now();
        let frame = requestAnimationFrame(function step(time) {
            current.elapsedMs += Math.max(0, time - last);
            last = time;
            const next = sessionRippleFrame(current.elapsedMs, { ...latest.current, reducedMotion: current.reducedMotion });
            setGain(next.gain);
            ring.current?.paint(next.ring);
            if (next.done) {
                current.done = true;
                setRingShown(false);
                return;
            }
            frame = requestAnimationFrame(step);
        });
        return () => {
            cancelAnimationFrame(frame);
        };
    }, [answers, input.paused, input.reducedMotion, ring]);
    return { gain, ringShown };
}
