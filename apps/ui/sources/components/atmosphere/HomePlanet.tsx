import * as React from 'react';
import { StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { AtmosphereDissolve } from './AtmosphereDissolve';
import { AtmosphereRipple } from './AtmosphereRipple';
import type { AtmosphereRippleHandle } from './atmosphereRipple.types';
import { atmospherePageRgb } from './atmospherePage';
import { useSessionFinishedRipple, useSessionTurnStates } from './homeAtmosphereMoments';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useSessionRipplePlayback } from './sessionRipple';
import { PlanetCanvas } from './PlanetCanvas';
import type { PlanetSceneOptions } from '@happier-dev/brand/planet';
import { WELCOME_RETYPE_RATE, WELCOME_RETYPE_STEP_S, welcomeRetypeTime } from './moments/planetMomentTimeline';
import {
  homePlanetGeometry,
  homePlanetDrawnHeight,
  homePlanetSceneOptions,
  homeRiseFootFade,
  homeRiseLimb,
  projectPlanetBand,
  type HomePane,
  type HomePlanetPlacement,
  type HomePlanetStyle,
} from './homePlanetPlacement';

export type HomePlanetHero = Readonly<{
  /** The composer's top and the bottom of what stands under it (suggestions), in the pane. */
  composerTop: number | null;
  aboveBottom: number;
  /** The first thing below the hero (the widgets' header), or null when nothing follows. */
  nextTop: number | null;
}>;

export type HomePlanetLook = Readonly<{
  pane: HomePane;
  placement: HomePlanetPlacement;
  style: HomePlanetStyle;
  digits: boolean;
  theme: 'light' | 'dark';
  phone: boolean;
  hero: HomePlanetHero | null;
  /** A Project's band depth in the pane: the planet stays above it (see `projectPlanetBand`). */
  band?: number;
}>;

/**
 * Home's planet scene for its pane and hero: the one place its options are made, shared with the
 * moments that land on it. Null while it cannot be placed yet (Rise waits for the composer).
 */
export function useHomePlanetOptions(look: HomePlanetLook, retypeTime: number | null = null): PlanetSceneOptions | null {
  const { pane, placement, hero, phone, theme, style, digits } = look;
  const projectBand = look.band ? projectPlanetBand(look.band) : null;
  const widgets = hero ? hero.nextTop !== null : undefined;
  const ready = placement !== 'rise' || hero !== null || projectBand !== null;
  const limb = placement !== 'rise' ? undefined
    : projectBand ? projectBand.riseLimb
      : hero && hero.composerTop !== null ? homeRiseLimb(hero.composerTop) : undefined;
  const fadeTo = homePlanetFootFade(look)?.to;
  return React.useMemo(() => {
    if (!ready || pane.width <= 0 || pane.height <= 0) return null;
    const geometry = homePlanetGeometry(placement, pane, { phone, widgets, limb });
    // The scene's view reaches as far down as the planet is drawn (Rise's foot fade may pass the fold).
    const drawn = { width: pane.width, height: homePlanetDrawnHeight(pane.height, fadeTo === undefined ? undefined : { to: fadeTo }) };
    const options = homePlanetSceneOptions(geometry, drawn, { theme, style, digits });
    // After Welcome the field re-types slowly (lab rest: `rate: 0.5`).
    return retypeTime === null ? options : { ...options, time: retypeTime, rate: WELCOME_RETYPE_RATE };
  }, [digits, fadeTo, limb, pane, phone, placement, ready, retypeTime, style, theme, widgets]);
}

/** Rise's ordered foot fade before the widgets, in the pane (lab `layout()`); none for the other placements. */
export function homePlanetFootFade(look: Pick<HomePlanetLook, 'placement' | 'hero' | 'phone' | 'band'>) {
  const { placement, hero, phone } = look;
  if (look.band) return projectPlanetBand(look.band).fade;
  return placement === 'rise' && hero && hero.nextTop !== null
    ? homeRiseFootFade({ aboveBottom: hero.aboveBottom, nextTop: hero.nextTop, phone })
    : undefined;
}

/**
 * The brand dot planet as an object on Home (plan R-1): the pane crops it, it scrolls with the page,
 * and it is drawn over the content coat and under everything Home shows. It is decorative: hidden from
 * accessibility and never a target. It fades in once drawn and leaves with the send.
 */
export const HomePlanet = React.memo(function HomePlanet(
  props: Readonly<{
    pane: HomePane;
    placement: HomePlanetPlacement;
    style: HomePlanetStyle;
    digits: boolean;
    theme: 'light' | 'dark';
    phone: boolean;
    hero: HomePlanetHero | null;
    /** A Project's band: the planet is drawn only above it, ending in the ordered foot fade. */
    band?: number;
    /** Hidden while a send dissolves the page or a picture has taken over. */
    hidden: boolean;
    leave: 'climb' | 'fade';
    /** A moment that landed on this planet hands over in the same frame. */
    arrive?: 'fade' | 'instant';
    reducedMotion: boolean;
    /** This visit may re-type after Welcome. The leaf owns its clock. */
    retype?: boolean;
    writing?: boolean;
    /** Each time the planet's canvas has drawn. */
    onDrawn?: () => void;
    /** The session-finished ripple (UD-4): on while Home's source is the planet and the moment is on. */
    answerFinishes?: boolean;
    /** Home is the focused page; with the app in front, a finish it sees is answered. */
    focused?: boolean;
  }>,
) {
  const { pane } = props;
  const activelyViewed = useHostActivelyViewed();
  const paused = !activelyViewed || props.focused === false || props.writing === true || props.hidden;
  const retypeTime = useRetypeTime(props.retype === true && props.digits && !paused && !props.reducedMotion);
  const options = useHomePlanetOptions(props, props.retype ? retypeTime : null);
  const fade = homePlanetFootFade(props);
  const height = homePlanetDrawnHeight(pane.height, fade);
  const [drawn, setDrawn] = React.useState(false);
  const onDrawn = React.useRef(props.onDrawn);
  onDrawn.current = props.onDrawn;
  const onReady = React.useCallback(() => {
    setDrawn(true);
    onDrawn.current?.();
  }, []);
  const { theme } = useUnistyles();
  const page = React.useMemo(() => atmospherePageRgb(theme.colors.surface.base), [theme.colors.surface.base]);
  const [answers, setAnswers] = React.useState(0);
  const onAnswer = React.useCallback(() => setAnswers((count) => count + 1), []);
  const ring = React.useRef<AtmosphereRippleHandle>(null);
  const playback = useSessionRipplePlayback(
    answers,
    { width: pane.width, theme: props.theme, cx: options?.cx ?? 0, cy: options?.cy ?? 0, R: options?.R ?? 0, reducedMotion: props.reducedMotion, paused },
    ring,
  );
  // The answer brightens the same scene: PlanetCanvas re-gains it rather than sampling it again.
  const lit = React.useMemo(
    () => (options && playback.gain !== 1 ? { ...options, gain: playback.gain } : options),
    [options, playback.gain],
  );
  if (!options || !lit) return null;
  return (
    <AtmosphereDissolve
      visible={drawn && !props.hidden}
      leave={props.leave}
      arrive={props.arrive}
      height={height}
      reducedMotion={props.reducedMotion}
      style={[styles.layer, { width: pane.width, height }]}
    >
      <PlanetCanvas
        width={pane.width}
        height={height}
        options={lit}
        fade={fade}
        onReady={onReady}
        testID="home-planet"
      />
      {playback.ringShown ? (
        <AtmosphereRipple ref={ring} width={pane.width} height={pane.height} theme={props.theme} page={page} />
      ) : null}
      {props.answerFinishes && drawn ? (
        <SessionFinishWatch visible={props.focused === true && !props.hidden} onAnswer={onAnswer} />
      ) : null}
    </AtmosphereDissolve>
  );
});

/**
 * The session observation, mounted only while the planet can answer: the Activity source's changes
 * render this leaf, never the planet.
 */
function SessionFinishWatch(props: Readonly<{ visible: boolean; onAnswer: () => void }>) {
  const states = useSessionTurnStates();
  const active = useHostActivelyViewed();
  const answers = useSessionFinishedRipple({ enabled: true, visible: props.visible && active, states });
  const { onAnswer } = props;
  React.useEffect(() => {
    if (answers > 0) onAnswer();
  }, [answers, onAnswer]);
  return null;
}

/** Welcome's low-rate rest clock belongs only to the planet that draws its digits. */
function useRetypeTime(running: boolean): number {
  const [time, setTime] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(
      () => setTime(current => welcomeRetypeTime(current + WELCOME_RETYPE_STEP_S)),
      WELCOME_RETYPE_STEP_S * 1000,
    );
    return () => clearInterval(id);
  }, [running]);
  return time;
}


const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 0, top: 0 },
});
