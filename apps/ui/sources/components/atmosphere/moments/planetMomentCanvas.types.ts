import type { StyleProp, ViewStyle } from 'react-native';
import type { PlanetAssembly, PlanetAssemblyProgress, PlanetSceneDot } from '@happier-dev/brand/planet';

/** One frame of the brand assembly, drawn into a pane-sized canvas (css px). */
export type PlanetMomentCanvasProps = Readonly<{
    width: number;
    height: number;
    dpr: number;
    assembly: PlanetAssembly;
    /** The assembled planet's haze, which arrives last (the brand frame's `halo`). */
    haze: readonly PlanetSceneDot[];
    frame: PlanetAssemblyProgress;
    /** The whole frame's opacity: 1 while it plays, falling through an ending cross-fade. */
    opacity: number;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;
