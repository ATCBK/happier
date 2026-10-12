import {
  ATMOSPHERE_PALETTE,
  type AtmosphereEffectiveLook,
  type AtmospherePicture,
  type AtmosphereRgb,
} from '@happier-dev/brand/atmosphere';
import type { BackdropCanvasProps } from './backdropCanvas.types';
import { HOME_HORIZON_FADE_FROM } from './homePlanetPlacement';

/** Wallpaper puts the horizon behind the cards, so the headline, composer and section header sit on sky. */
const WALLPAPER_HORIZON_AT = 0.86;

/**
 * A picture's render inputs for one layout and theme: the lab's `skyVariant`/`skyOptions` and the
 * engine shell's defaults (`compute`), so the product asks the brand renderer exactly what the lab did.
 * A user picture has no release entry: no grade, a centred crop, the theme's mute.
 */
export function pictureBackdropProps(
  input: Readonly<{
    picture: AtmospherePicture | null;
    look: AtmosphereEffectiveLook;
    theme: 'light' | 'dark';
    page: AtmosphereRgb;
    layout: 'horizon' | 'wallpaper';
    horizonAt: number;
  }>,
): Pick<
  BackdropCanvasProps,
  | 'look'
  | 'params'
  | 'dissolve'
  | 'focus'
  | 'horizon'
  | 'grade'
  | 'adjust'
  | 'page'
  | 'theme'
> {
  const { picture, look, theme } = input;
  const hour = picture
    ? (picture.grades[theme === 'dark' ? picture.dark || 'night' : 'light'] ??
      picture.hour)
    : null;
  const grade =
    picture && hour !== null && Math.abs(picture.hour - hour) > 0.05
      ? { from: picture.hour, to: hour, horizon: picture.horizon.src }
      : null;
  const horizon =
    picture?.horizon && picture.horizon.src != null
      ? {
          ...picture.horizon,
          at:
            input.layout === 'wallpaper'
              ? WALLPAPER_HORIZON_AT
              : input.horizonAt,
        }
      : picture?.horizon;
  return {
    look: look.effect,
    params: {
      ...look.params,
      strength: look.strength,
      mute: ATMOSPHERE_PALETTE.mute[theme],
    },
    dissolve:
      input.layout === 'horizon'
        ? {
            style: look.fade,
            from: look.from ?? HOME_HORIZON_FADE_FROM,
            to: look.to ?? 1,
          }
        : null,
    focus: picture?.focus ?? { x: 0.5, y: 0.5 },
    ...(horizon ? { horizon } : {}),
    grade,
    adjust: picture?.adjust ?? null,
    page: input.page,
    theme,
  };
}
