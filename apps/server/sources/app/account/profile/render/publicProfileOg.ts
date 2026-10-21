import type { PublicProfileReadResultV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { loadSharp } from '@/storage/blob/sharpRuntime';
import { renderPublicProfileSvg, type PublicProfileSvgOptions } from './publicProfileSvg';

/** G1 has one resolved dark edition; rasterization never invents another model. */
export async function renderPublicProfileOg(result: PublicProfileReadResultV1,
    options: Omit<PublicProfileSvgOptions, 'kind' | 'theme' | 'metric'>): Promise<Buffer> {
    return rasterize(result, { ...options, kind: 'og', theme: 'dark' });
}

/** K1 PNG uses the identical card scene; automatic colour scheme resolves to its default light edition. */
export async function renderPublicProfileCardPng(result: PublicProfileReadResultV1,
    options: Omit<PublicProfileSvgOptions, 'kind' | 'metric'>): Promise<Buffer> {
    return rasterize(result, { ...options, kind: 'card', theme: options.theme === 'dark' ? 'dark' : 'light' });
}

async function rasterize(result: PublicProfileReadResultV1, options: PublicProfileSvgOptions): Promise<Buffer> {
    const sharp = await loadSharp();
    return sharp(Buffer.from(await renderPublicProfileSvg(result, options))).png().toBuffer();
}
