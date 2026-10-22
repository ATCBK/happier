import type { PublicProfileViewV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { HAPPIER_PUBLIC_PROFILE_HERO_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { createPlanetScene } from '@happier-dev/brand/planet';
import { homePlanetGeometry, homePlanetSceneOptions } from '@happier-dev/brand/planet-placement';
import * as privacyKit from 'privacy-kit';
import { loadSharp } from '@/storage/blob/sharpRuntime';
import { renderPublicProfilePlanetSceneSvg, type PublicProfileAssetPalette } from './publicProfileSvg';
import { renderPublicProfileBackdrop } from './publicProfileBackdrop';

export interface PublicProfileHeroImage {
    mimeType: 'image/png';
    base64: string;
    width: number;
    height: number;
}
export interface PublicProfileHeroData {
    credit?: string;
    editions: Readonly<Record<'light' | 'dark', Readonly<Record<'wide' | 'phone',
        Readonly<Record<'one' | 'two', PublicProfileHeroImage>>>>>>;
}
export interface PublicProfileHeroOptions {
    picture?: Buffer;
    palette: Readonly<Record<'light' | 'dark', PublicProfileAssetPalette>>;
}

/** Physical editions of the current already-filtered, applied atmosphere only. */
export async function renderPublicProfileHero(view: PublicProfileViewV1, options: PublicProfileHeroOptions): Promise<PublicProfileHeroData | undefined> {
    const atmosphere = view.appearance.atmosphere;
    if (atmosphere.source === 'none') return undefined;
    if (atmosphere.source === 'picture' && !options.picture) throw new Error('public_profile_picture_unavailable');
    const render = async (theme: 'light' | 'dark', viewport: 'wide' | 'phone', ratio: 1 | 2): Promise<PublicProfileHeroImage> => {
        const pane = { width: HAPPIER_PUBLIC_PROFILE_HERO_METRICS.rasterWidthPx[viewport],
            height: HAPPIER_PUBLIC_PROFILE_HERO_METRICS.bandHeightPx[viewport] };
        const width = pane.width * ratio;
        const height = pane.height * ratio;
        let bytes: Buffer;
        if (atmosphere.source === 'picture') {
            // Match AtmospherePreview frame="band": the applied backdrop fills
            // the band; shell-only WallpaperHaze geometry is not invented here.
            bytes = (await renderPublicProfileBackdrop({ bytes: options.picture!, picture: atmosphere.picture.descriptor,
                layout: atmosphere.picture.layout, width, height, dpr: ratio, theme, page: options.palette[theme].backgroundRgb,
                horizonAt: HAPPIER_PUBLIC_PROFILE_HERO_METRICS.horizonAt })).bytes;
        } else {
            // Match AtmospherePreview's band geometry and the real canvas' device-pixel scene input.
            const scene = createPlanetScene({ ...homePlanetSceneOptions(homePlanetGeometry(atmosphere.planet.placement, pane), pane,
                { theme, style: atmosphere.planet.style, digits: atmosphere.planet.digits }), dpr: ratio });
            const paint = await renderPublicProfilePlanetSceneSvg(scene, pane, ratio);
            const sharp = await loadSharp();
            bytes = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${pane.width} ${pane.height}">${paint}</svg>`))
                .flatten({ background: options.palette[theme].background }).ensureAlpha().png().toBuffer();
        }
        return { mimeType: 'image/png', base64: privacyKit.encodeBase64(Uint8Array.from(bytes)), width, height };
    };
    const edition = async (theme: 'light' | 'dark', viewport: 'wide' | 'phone') => ({
        one: await render(theme, viewport, 1), two: await render(theme, viewport, 2),
    });
    const credit = atmosphere.source === 'picture' ? atmosphere.picture.descriptor.credit : null;
    return {
        ...(credit ? { credit: `${credit.author} · ${credit.source}` } : {}),
        editions: {
            light: { wide: await edition('light', 'wide'), phone: await edition('light', 'phone') },
            dark: { wide: await edition('dark', 'wide'), phone: await edition('dark', 'phone') },
        },
    };
}
