import { GLASS_BLUR_RADIUS_PX } from '@/components/ui/glass/glassMaterial';

/** The existing web Wallpaper haze composition, shared by both platform drawing adapters. */
export const WALLPAPER_HAZE_LAYERS = [
    { blur: GLASS_BLUR_RADIUS_PX.regular, rx: 0.40, ry: 0.44, solid: 0.38 },
    { blur: GLASS_BLUR_RADIUS_PX.strong, rx: 0.30, ry: 0.34, solid: 0.30 },
] as const;
