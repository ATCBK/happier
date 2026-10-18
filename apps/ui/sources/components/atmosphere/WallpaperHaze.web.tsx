import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { BackdropCanvas } from './BackdropCanvas';
import { pictureBackdropProps } from './pictureBackdrop';
import { WALLPAPER_HAZE_LAYERS } from './wallpaperHaze';

/**
 * monocode's haze under the content (lab `paintHaze`): two soft copies of the scene, centred on the
 * content column. They are low-resolution renders of the same picture, blurred once as images, never a
 * live backdrop filter; the radii are the glass owner's.
 */
export function WallpaperHaze(
  props: Readonly<{
    source: NonNullable<React.ComponentProps<typeof BackdropCanvas>['source']>;
    size: { width: number; height: number };
    job: ReturnType<typeof pictureBackdropProps>;
    focus: { x: number; y: number };
    /** The haze's render: head lines stand on it, so the atmosphere measures its tone too. */
    onRendered?: React.ComponentProps<typeof BackdropCanvas>['onRendered'];
  }>,
) {
  const quarter = {
    width: Math.max(2, Math.round(props.size.width / 4)),
    height: Math.max(2, Math.round(props.size.height / 4)),
  };
  const at = `${((props.focus.x / props.size.width) * 100).toFixed(1)}% ${((props.focus.y / props.size.height) * 100).toFixed(1)}%`;
  const layer = (blur: number, ellipse: string, solid: string) => {
    const mask = `radial-gradient(ellipse ${ellipse} at ${at}, #000 ${solid}, transparent 100%)`;
    return (
      <View
        style={[
          StyleSheet.absoluteFill,
          { maskImage: mask, WebkitMaskImage: mask } as object,
        ]}
      >
        <View
          style={
            {
              width: quarter.width,
              height: quarter.height,
              transformOrigin: 'top left',
              transform: [{ scale: 4 }],
              filter: `blur(${blur / 4}px)`,
            } as object
          }
        >
          <BackdropCanvas
            source={props.source}
            size={quarter}
            dpr={1}
            {...props.job}
            onRendered={props.onRendered}
          />
        </View>
      </View>
    );
  };
  return (
    <>
      {WALLPAPER_HAZE_LAYERS.map(spec => <React.Fragment key={spec.blur}>{layer(spec.blur, `${spec.rx * 100}% ${spec.ry * 100}%`, `${spec.solid * 100}%`)}</React.Fragment>)}
    </>
  );
}
