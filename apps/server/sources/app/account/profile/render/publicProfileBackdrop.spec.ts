import { describe, expect, it } from 'vitest';
import { ATMOSPHERE_DISSOLVES, ATMOSPHERE_LOOKS, backdropBandGrade, cropOf, pictureBackdropProps, renderBackdrop } from '@happier-dev/brand/atmosphere';
import { resolveWallpaperHaze, wallpaperHazeLayers } from '@happier-dev/brand/atmosphere-haze';
import type { PublicProfilePictureDescriptorV1 } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import { GLASS_BLUR_RADIUS_PX } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
import { loadSharp } from '@/storage/blob/sharpRuntime';
import { renderPublicProfileBackdrop } from './publicProfileBackdrop';

const picture: PublicProfilePictureDescriptorV1 = {
    kind: 'photo', title: 'Reviewed picture', credit: null, adaptiveHaze: false,
    focus: { x: 0.5, y: 0.5 }, horizon: {}, hour: 0.42,
    grades: { light: 0.42, dusk: 0.65, night: 0.81 }, dark: 'night',
    look: { effect: 'original', params: {}, strength: 1, dissolve: { style: 'gradient', from: 0.58, to: 1 } },
};

async function fixture(width: number, height: number) {
    const sharp = await loadSharp();
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = Math.round(x * 255 / (width - 1));
        rgba[i + 1] = Math.round(y * 255 / (height - 1));
        rgba[i + 2] = 80;
        rgba[i + 3] = 255;
    }
    const bytes = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
    return { bytes, rgba };
}

describe('renderPublicProfileBackdrop', () => {
    it('preserves CSS-sized effect cells at the selected device-pixel ratio', async () => {
        const sharp = await loadSharp();
        const source = await fixture(64, 48);
        const selected = { ...picture, look: { ...picture.look, effect: 'halftone' as const } };
        const input = { bytes: source.bytes, picture: selected, layout: 'wallpaper' as const, width: 64, height: 48,
            dpr: 2, theme: 'light' as const, page: [255, 255, 255] as const, horizonAt: 0.6 };
        const props = pictureBackdropProps({ ...input, look: { effect: selected.look.effect, params: selected.look.params,
            strength: selected.look.strength, fade: selected.look.dissolve.style, from: selected.look.dissolve.from, to: selected.look.dissolve.to } });
        const crop = cropOf({ w: 64, h: 48 }, input.width, input.height, props.focus, props.horizon);
        const job = { ...props, grade: backdropBandGrade(props.grade, crop, props.horizon),
            source: { rgba: new Uint8ClampedArray(source.rgba), w: 64, h: 48 } };
        const expected = renderBackdrop({ ...job, dpr: 2 });
        expect(Buffer.from(expected.rgba)).not.toEqual(Buffer.from(renderBackdrop({ ...job, dpr: 1 }).rgba));
        const actual = await renderPublicProfileBackdrop(input);
        expect((await sharp(actual.bytes).raw().toBuffer()).equals(Buffer.from(expected.rgba))).toBe(true);
    });

    it('encodes the actual Brand core output with source-space grades, crop, adjustment and fixed target inputs', async () => {
        const sharp = await loadSharp();
        const source = await fixture(48, 32);
        const selected = { ...picture, focus: { x: 0.75, y: 0.2 }, horizon: { src: 0.5 }, adjust: { exposure: 0.1, saturation: 0.8 } };
        const input = { bytes: source.bytes, picture: selected, layout: 'horizon' as const, width: 24, height: 32,
            theme: 'dark' as const, page: [20, 24, 30] as const, horizonAt: 0.5 };
        const result = await renderPublicProfileBackdrop(input);
        const props = pictureBackdropProps({ ...input, look: { effect: selected.look.effect, params: selected.look.params,
            strength: selected.look.strength, fade: selected.look.dissolve.style, from: selected.look.dissolve.from, to: selected.look.dissolve.to } });
        const crop = cropOf({ w: 48, h: 32 }, 24, 32, props.focus, props.horizon);
        expect(crop.s).toBe(1);
        const sampled = await sharp(source.bytes).extract({ left: crop.sx, top: crop.sy, width: 24, height: 32 }).ensureAlpha().raw().toBuffer();
        const expected = renderBackdrop({ ...props, grade: backdropBandGrade(props.grade, crop, props.horizon), source: { rgba: new Uint8ClampedArray(sampled), w: 24, h: 32 } });
        const actual = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(result).toMatchObject({ width: 24, height: 32, mimeType: 'image/png' });
        expect(actual.info).toMatchObject({ width: 24, height: 32, channels: 4 });
        expect(actual.data).toEqual(Buffer.from(expected.rgba));
    });

    it('preserves a fractional crop rather than rounding the selected focus', async () => {
        const sharp = await loadSharp();
        const source = await fixture(48, 32);
        const render = (x: number) => renderPublicProfileBackdrop({ bytes: source.bytes, picture: { ...picture, focus: { x, y: 0.5 } },
            layout: 'wallpaper', width: 24, height: 32, theme: 'light', page: [255, 255, 255], horizonAt: 0.5 });
        const [whole, fractional] = await Promise.all([render(0.5), render(0.5 + 0.25 / 48)]);
        const [a, b] = await Promise.all([sharp(whole.bytes).raw().toBuffer(), sharp(fractional.bytes).raw().toBuffer()]);
        expect(b.equals(a)).toBe(false);
        // A quarter-pixel move along the source ramp remains between its adjacent samples.
        expect(b[0]).toBeGreaterThanOrEqual(a[0]!);
        expect(b[0]! - a[0]!).toBeLessThanOrEqual(2);
    });

    it('samples a fixed viewport even when a valid source zoom would expand an enormous intermediate', async () => {
        const sharp = await loadSharp();
        const source = await fixture(48, 32);
        const result = await renderPublicProfileBackdrop({ bytes: source.bytes,
            picture: { ...picture, focus: { x: 0.5, y: 0.5, zoom: 1e10 } },
            layout: 'wallpaper', width: 24, height: 32, theme: 'light', page: [255, 255, 255], horizonAt: 0.5 });
        const decoded = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
        expect(decoded.info).toMatchObject({ width: 24, height: 32, channels: 4 });
        expect(decoded.data[0]).toBeGreaterThan(0);
        expect(decoded.data[3]).toBe(255);
    });

    it('keeps the shared zoom-out crop transparent outside its source before Brand paints it', async () => {
        const sharp = await loadSharp();
        const source = await fixture(16, 16);
        const selected = { ...picture, focus: { x: 0.5, y: 0.5, zoom: 0.5 } };
        const input = { bytes: source.bytes, picture: selected, layout: 'wallpaper' as const, width: 32, height: 32,
            theme: 'light' as const, page: [255, 255, 255] as const, horizonAt: 0.5 };
        const props = pictureBackdropProps({ ...input, look: { effect: selected.look.effect, params: selected.look.params,
            strength: selected.look.strength, fade: selected.look.dissolve.style, from: selected.look.dissolve.from, to: selected.look.dissolve.to } });
        const crop = cropOf({ w: 16, h: 16 }, 32, 32, props.focus, props.horizon);
        expect(crop).toMatchObject({ s: 1, sx: 0, sy: 0 });
        const sampled = Buffer.alloc(32 * 32 * 4);
        for (let y = 0; y < 16; y++) source.rgba.copy(sampled, y * 32 * 4, y * 16 * 4, (y + 1) * 16 * 4);
        const expected = renderBackdrop({ ...props, source: { rgba: new Uint8ClampedArray(sampled), w: 32, h: 32 },
            grade: backdropBandGrade(props.grade, crop, props.horizon) });
        const result = await renderPublicProfileBackdrop(input);
        const actual = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
        expect(actual).toEqual(Buffer.from(expected.rgba));
    });

    it('renders every shared effect and dissolve as real decoded PNG pixels', async () => {
        const sharp = await loadSharp();
        const source = await fixture(40, 28);
        const outputs = new Set<string>();
        for (const effect of ATMOSPHERE_LOOKS) for (const dissolve of ATMOSPHERE_DISSOLVES) {
            const result = await renderPublicProfileBackdrop({ bytes: source.bytes,
                picture: { ...picture, look: { ...picture.look, effect: effect.id, dissolve: { style: dissolve.id, from: 0.4, to: 1 } } },
                layout: 'horizon', width: 32, height: 24, theme: 'light', page: [255, 255, 255], horizonAt: 0.57 });
            const decoded = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
            expect(decoded.info).toMatchObject({ width: 32, height: 24, channels: 4 });
            outputs.add(decoded.data.toString('hex'));
        }
        expect(outputs.size).toBeGreaterThan(8);
    });

    it('composites the shared wallpaper layers and resolved veil at the actual target geometry', async () => {
        const sharp = await loadSharp();
        const source = await fixture(100, 80);
        const input = { bytes: source.bytes, picture, layout: 'wallpaper' as const, width: 65, height: 41,
            theme: 'dark' as const, page: [20, 24, 30] as const, horizonAt: 0.5 };
        const at = { x: 0.5, y: 0.5 };
        const composition = resolveWallpaperHaze({ heads: { dark: 0.9, light: 1, focus: 0.95 }, page: 'rgb(20, 24, 30)',
            primary: 'rgb(255, 255, 255)', column: { x: 0.05, y: 0.05 }, at, adaptive: true,
            layers: wallpaperHazeLayers(GLASS_BLUR_RADIUS_PX) });
        expect(composition.veil?.alpha).toBeGreaterThan(0);
        const [base, hazed] = await Promise.all([renderPublicProfileBackdrop(input),
            renderPublicProfileBackdrop({ ...input, wallpaperHaze: { composition, at } })]);
        const [a, b] = await Promise.all([sharp(base.bytes).raw().toBuffer(), sharp(hazed.bytes).raw().toBuffer()]);
        expect(a.length).toBe(65 * 41 * 4);
        expect(b.length).toBe(a.length);
        expect(b.subarray(0, 4)).toEqual(a.subarray(0, 4));
        const middle = (20 * 65 + 32) * 4;
        expect(b.subarray(middle, middle + 3)).not.toEqual(a.subarray(middle, middle + 3));
    });

    it('measures real full-size OG and desktop output work', async () => {
        const sharp = await loadSharp();
        const source = await fixture(2560, 1440);
        for (const { width, height, layout } of [
            { width: 1200, height: 630, layout: 'horizon' },
            { width: 1920, height: 1080, layout: 'wallpaper' },
        ] as const) {
            const start = performance.now();
            const memory = process.memoryUsage().rss;
            const at = { x: 0.5, y: 0.5 };
            const composition = resolveWallpaperHaze({ heads: { dark: 0.9, light: 1, focus: 0.95 }, page: 'rgb(20, 24, 30)',
                primary: 'rgb(255, 255, 255)', column: { x: 0.25, y: 0.18 }, at, adaptive: true,
                layers: wallpaperHazeLayers(GLASS_BLUR_RADIUS_PX) });
            const result = await renderPublicProfileBackdrop({ bytes: source.bytes, picture: { ...picture, look: { ...picture.look, effect: 'painted-fine' } },
                layout, width, height, theme: 'dark', page: [20, 24, 30], horizonAt: 0.57,
                ...(layout === 'wallpaper' ? { wallpaperHaze: { composition, at } } : {}) });
            const metadata = await sharp(result.bytes).metadata();
            expect(metadata).toMatchObject({ width, height, format: 'png' });
            console.info('public-profile-backdrop-cost', { width, height, layout, elapsedMs: Math.round(performance.now() - start),
                rssDeltaBytes: process.memoryUsage().rss - memory, pngBytes: result.bytes.length });
        }
    });
});
