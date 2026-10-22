import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BackdropCanvas } from '../BackdropCanvas';
import { PlanetCanvas } from '../PlanetCanvas';
import {
  homePlanetGeometry,
  homePlanetSceneOptions,
} from '../homePlanetPlacement';
import { pictureBackdropProps } from '../pictureBackdrop';
import { useAtmosphere, type AtmosphereTarget } from '../useAtmosphere';
import { useAtmospherePictureCatalog } from '../useAtmospherePictureCatalog';
import { atmospherePageRgb } from '../atmospherePage';
import { effectivePictureLook } from './atmosphereEdits';
import { HAPPIER_PUBLIC_PROFILE_HERO_METRICS } from '@happier-dev/plugin-ui/presentation';

/** In a small window preview the Horizon band covers the top of the page, as it does on Home. */
const PREVIEW_BAND_SHARE = 0.62;
/** Without a measured headline, the picture's horizon sits mid-band (Home measures its own). */
const PREVIEW_HORIZON_AT = 0.5;
/** A profile header band uses the public page's own horizon, so app and server paint the same band. */
const BAND_HORIZON_AT = HAPPIER_PUBLIC_PROFILE_HERO_METRICS.horizonAt;

/**
 * An atmosphere drawn static and decorative: by default the user's current Home behind a window
 * preview (Settings → Glass and backdrop, the glass material tiles). A public profile passes its own
 * draft and draws the whole box as its header band. The page, then the planet or the picture, exactly
 * as that target resolves on this device.
 */
export const AtmospherePreview = React.memo(function AtmospherePreview(props: Readonly<{
  target?: AtmosphereTarget;
  /** `band`: a Horizon picture fills the whole box (a header band), not the top of a window. */
  frame?: 'window' | 'band';
}>) {
  const { theme } = useUnistyles();
  const mode = theme.dark ? 'dark' : 'light';
  const atmosphere = useAtmosphere(props.target ?? 'home');
  const bandFrame = props.frame === 'band';
  const pictures = useAtmospherePictureCatalog();
  const [size, setSize] = React.useState<Readonly<{
    width: number;
    height: number;
  }> | null>(null);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) =>
      previous && previous.width === width && previous.height === height
        ? previous
        : { width, height },
    );
  }, []);
  const pageColor = theme.colors.surface.base;
  const page = React.useMemo(() => atmospherePageRgb(pageColor), [pageColor]);
  const record = atmosphere.pictureRecord;
  // The small preview draws from the cached thumbnail when there is one; the full picture otherwise.
  const source = React.useMemo(
    () =>
      record && record.thumb !== undefined
        ? { ...record, data: record.thumb }
        : record,
    [record],
  );
  let art: React.ReactNode = null;
  if (size && size.width > 0 && size.height > 0) {
    if (atmosphere.source === 'planet') {
      const pane = { width: size.width, height: size.height };
      art = (
        <PlanetCanvas
          width={size.width}
          height={size.height}
          style={StyleSheet.absoluteFill}
          options={homePlanetSceneOptions(
            homePlanetGeometry(atmosphere.planet.placement, pane),
            pane,
            {
              theme: mode,
              style: atmosphere.planet.style,
              digits: atmosphere.planet.digits,
            },
          )}
        />
      );
    } else if (atmosphere.source === 'picture' && source) {
      const wallpaper = atmosphere.picture.layout === 'wallpaper';
      const band = {
        width: size.width,
        height: wallpaper || bandFrame
          ? size.height
          : Math.round(size.height * PREVIEW_BAND_SHARE),
      };
      const backdrop = pictureBackdropProps({
        picture: atmosphere.builtinPicture,
        look: effectivePictureLook(atmosphere, pictures),
        theme: mode,
        page,
        layout: atmosphere.picture.layout,
        horizonAt: bandFrame ? BAND_HORIZON_AT : PREVIEW_HORIZON_AT,
      });
      art = (
        <BackdropCanvas
          resettle={false}
          source={source}
          size={band}
          {...backdrop}
          style={styles.band}
        />
      );
    }
  }
  return (
    <View
      style={styles.page}
      onLayout={onLayout}
      pointerEvents="none"
      aria-hidden
    >
      {art}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  page: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.surface.base,
    overflow: 'hidden',
  },
  band: { position: 'absolute', left: 0, top: 0 },
}));
