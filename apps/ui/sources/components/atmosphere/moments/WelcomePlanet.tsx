import * as React from 'react';
import { PixelRatio, StyleSheet, View } from 'react-native';
import {
  createPlanetScene,
  planetAssembly,
  type PlanetAssembly,
  type PlanetSceneDot,
  type PlanetSceneOptions,
} from '@happier-dev/brand/planet';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PlanetCanvas } from '../PlanetCanvas';
import type { HomePane } from '../homePlanetPlacement';
import { PlanetMomentCanvas } from './PlanetMomentCanvas';
import { welcomePlanetPhase } from './planetMomentTimeline';
import { useMomentClock } from './useMomentClock';

type Prepared = Readonly<{
  options: PlanetSceneOptions;
  dpr: number;
  assembly: PlanetAssembly;
  haze: readonly PlanetSceneDot[];
}>;

/**
 * Welcome (plan R-11, UD-5 (a); lab `MOS.welcome4`): on the first arrival at Home after sign-in a cloud
 * of faint digits assembles into Home's own planet in 1.9 s, the lit limb first as the light swings
 * round, and cross-fades into the resting planet, which Home's canvas then carries. It stands where Home's
 * planet stands, under Home's content: decorative only, hidden from accessibility and never a target.
 */
export function WelcomePlanet(
  props: Readonly<{
    pane: HomePane;
    /** Home's planet: the assembly lands exactly on it. */
    options: PlanetSceneOptions;
    fade?: Readonly<{ from: number; to: number }>;
    visible: boolean;
    writing: boolean;
    reducedMotion: boolean;
    onLanded: () => void;
  }>,
) {
  const { pane, options } = props;
  const dpr = PixelRatio.get();
  const activelyViewed = useHostActivelyViewed();
  const presented = useLayoutPresentationActive();
  const [prepared, setPrepared] = React.useState<Prepared | null>(null);
  React.useEffect(() => {
    if (!activelyViewed || !presented || !props.visible || props.writing || props.reducedMotion) return;
    if (prepared?.options === options && prepared.dpr === dpr) return;
    // Prepared after Home's first frame, so Home never waits on it; the clock starts once it is.
    const frame = requestAnimationFrame(() => {
      const scene = { ...options, dpr };
      setPrepared({
        options,
        dpr,
        assembly: planetAssembly(scene),
        haze: createPlanetScene({ ...scene, rise: 1 }).haze,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [activelyViewed, presented, props.visible, props.writing, props.reducedMotion, dpr, options, prepared]);
  const [landed, setLanded] = React.useState(false);
  const t = useMomentClock(prepared !== null && !landed && !props.reducedMotion, !activelyViewed || !props.visible || props.writing);
  const phase = welcomePlanetPhase(t, props.reducedMotion);
  const onLanded = React.useRef(props.onLanded);
  onLanded.current = props.onLanded;
  React.useEffect(() => {
    if (phase.kind !== 'landed' || landed) return;
    setLanded(true);
    onLanded.current();
  }, [landed, phase.kind]);
  if (!prepared || phase.kind === 'landed' || !presented) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.layer, { width: pane.width, height: pane.height }]}
      testID="welcome-planet"
    >
      <PlanetMomentCanvas
        width={pane.width}
        height={pane.height}
        dpr={dpr}
        assembly={prepared.assembly}
        haze={prepared.haze}
        frame={phase.frame}
        opacity={1}
        style={styles.layer}
        testID="welcome-planet.assembly"
      />
      {/* The resting planet, drawn from the start so its cross-fade (1.68–1.9 s) has it ready. */}
      <View style={[styles.layer, { opacity: phase.restOpacity }]}>
        <PlanetCanvas
          width={pane.width}
          height={pane.height}
          options={options}
          fade={props.fade}
          testID="welcome-planet.rest"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 0, top: 0 },
});
