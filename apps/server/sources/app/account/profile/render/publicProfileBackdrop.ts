import { backdropBandGrade, cropOf, pictureBackdropProps, releaseLook, renderBackdrop,
    type AtmospherePixels, type AtmosphereRgb, type AtmosphereTheme } from '@happier-dev/brand/atmosphere';
import type { WallpaperHaze } from '@happier-dev/brand/atmosphere-haze';
import type { PublicProfilePictureDescriptorV1 } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import * as privacyKit from 'privacy-kit';
import { IMAGE_MAX_DECODE_PIXELS } from '@/storage/blob/processImage';
import { loadSharp } from '@/storage/blob/sharpRuntime';

export interface PublicProfileBackdropInput {
    bytes: Buffer;
    picture: PublicProfilePictureDescriptorV1;
    layout: 'horizon' | 'wallpaper';
    width: number;
    height: number;
    /** Device pixels per CSS pixel, as supplied to Brand by BackdropCanvas. */
    dpr?: number;
    theme: AtmosphereTheme;
    page: AtmosphereRgb;
    horizonAt: number;
    /** Resolve through Brand with picture.adaptiveHaze and the caller's actual content geometry. */
    wallpaperHaze?: Readonly<{ composition: WallpaperHaze; at: Readonly<{ x: number; y: number }> }>;
}

export interface PublicProfileBackdrop {
    bytes: Buffer;
    mimeType: 'image/png';
    width: number;
    height: number;
}

/**
 * Physical raster adapter only. The caller admits the current publication before
 * supplying its normalized local bytes; this function has no URL/storage authority.
 * Brand owns composition, crop, grade, effect and dissolve decisions.
 */
export async function renderPublicProfileBackdrop(input: PublicProfileBackdropInput): Promise<PublicProfileBackdrop> {
    if (!Number.isInteger(input.width) || input.width <= 0 || !Number.isInteger(input.height) || input.height <= 0) {
        throw new RangeError('Backdrop dimensions must be positive integer pixels');
    }
    const sharp = await loadSharp();
    const decoded = await sharp(input.bytes, { limitInputPixels: IMAGE_MAX_DECODE_PIXELS, autoOrient: true })
        .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // Embed only freshly decoded pixels, never a supplied SVG, URL or original
    // metadata. The SVG below is solely Sharp's fixed-size sampling viewport.
    const png = await sharp(decoded.data, { raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 } }).png().toBuffer();
    const source = { uri: `data:image/png;base64,${privacyKit.encodeBase64(png)}`, w: decoded.info.width, h: decoded.info.height };
    const props = pictureBackdropProps({ picture: input.picture, look: releaseLook(input.picture),
        layout: input.layout, theme: input.theme, page: input.page, horizonAt: input.horizonAt });
    const render = async (width: number, height: number, dpr = input.dpr) => {
        const crop = cropOf(source, width, height, props.focus, props.horizon);
        const sampled = await sampleCrop(source, crop, width, height);
        return renderBackdrop({ ...props, source: sampled, dpr,
            grade: backdropBandGrade(props.grade, crop, props.horizon) });
    };
    const backdrop = await render(input.width, input.height);
    let pixels: Buffer = Buffer.from(backdrop.rgba);
    if (input.layout === 'wallpaper' && input.wallpaperHaze) {
        const { composition, at } = input.wallpaperHaze;
        const dpr = input.dpr ?? 1;
        // WallpaperHaze renders a quarter CSS-size canvas at dpr=1, then scales
        // that image by four CSS pixels. Keep its effect lattice and blur intact.
        const quarter = { width: Math.max(2, Math.round(input.width / dpr / 4)), height: Math.max(2, Math.round(input.height / dpr / 4)) };
        const small = composition.layers.length > 0 ? await render(quarter.width, quarter.height, 1) : null;
        const layers: { input: Buffer; raw: { width: number; height: number; channels: 4 } }[] = [];
        for (const layer of composition.layers) {
            const blurred = await sharp(Buffer.from(small!.rgba), { raw: { ...quarter, channels: 4 } })
                .blur(layer.blur / 4).raw().toBuffer();
            // Match the UI's quarter-size layer scaled by four, then clipped to
            // the viewport (including viewports not divisible by four).
            const enlarged = await sharp(blurred, { raw: { ...quarter, channels: 4 } })
                .resize(Math.round(quarter.width * 4 * dpr), Math.round(quarter.height * 4 * dpr), { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
            const clipped = Buffer.alloc(input.width * input.height * 4);
            for (let row = 0; row < Math.min(input.height, enlarged.info.height); row++) {
                enlarged.data.copy(clipped, row * input.width * 4, row * enlarged.info.width * 4,
                    row * enlarged.info.width * 4 + Math.min(input.width, enlarged.info.width) * 4);
            }
            maskEllipse(clipped, input.width, input.height, at, layer);
            layers.push({ input: clipped, raw: { width: input.width, height: input.height, channels: 4 } });
        }
        if (composition.veil) {
            const veil = composition.veil;
            const fill = await sharp({ create: { width: input.width, height: input.height, channels: 4, background: veil.color } })
                .ensureAlpha().raw().toBuffer();
            maskEllipse(fill, input.width, input.height, veil.at, veil, veil.alpha);
            layers.push({ input: fill, raw: { width: input.width, height: input.height, channels: 4 } });
        }
        if (layers.length > 0) pixels = await sharp(pixels, { raw: { width: input.width, height: input.height, channels: 4 } })
            .composite(layers).raw().toBuffer();
    }
    const bytes = await sharp(pixels, { raw: { width: input.width, height: input.height, channels: 4 } }).png().toBuffer();
    return { bytes, mimeType: 'image/png', width: input.width, height: input.height };
}

async function sampleCrop(source: Readonly<{ uri: string; w: number; h: number }>, crop: ReturnType<typeof cropOf>, width: number, height: number): Promise<AtmospherePixels> {
    if (!Number.isFinite(crop.s) || crop.s <= 0 || !Number.isFinite(crop.sx) || !Number.isFinite(crop.sy)) {
        throw new RangeError('Invalid atmosphere crop');
    }
    const sharp = await loadSharp();
    // Sharp applies all extract operations before affine, so a raw affine result
    // expands with zoom before it can be clipped. Its existing librsvg adapter
    // samples directly into this viewport, preserving fractional source offsets
    // and transparency outside the source without materializing a zoomed image.
    const viewport = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image href="${source.uri}" x="${-crop.sx * crop.s}" y="${-crop.sy * crop.s}" width="${source.w * crop.s}" height="${source.h * crop.s}" preserveAspectRatio="none"/></svg>`;
    const sampled = await sharp(Buffer.from(viewport)).ensureAlpha().raw().toBuffer();
    return { rgba: new Uint8ClampedArray(sampled), w: width, h: height };
}

/** Physical equivalent of the shared CSS radial-gradient mask, in straight alpha. */
function maskEllipse(pixels: Buffer, width: number, height: number, at: Readonly<{ x: number; y: number }>,
    shape: Readonly<{ rx: number; ry: number; solid: number }>, opacity = 1): void {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const radius = Math.hypot(((x + 0.5) / width - at.x) / shape.rx, ((y + 0.5) / height - at.y) / shape.ry);
        const mask = radius <= shape.solid ? 1 : radius >= 1 ? 0 : (1 - radius) / (1 - shape.solid);
        const i = (y * width + x) * 4 + 3;
        pixels[i] = Math.round(pixels[i]! * mask * opacity);
    }
}
