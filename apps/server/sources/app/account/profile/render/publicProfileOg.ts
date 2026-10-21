import type { PublicProfileReadResultV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { loadSharp } from '@/storage/blob/sharpRuntime';
import { renderPublicProfileSvg, type PublicProfileSvgOptions } from './publicProfileSvg';

/** G1 has one resolved dark edition; rasterization never invents another model. */
export async function renderPublicProfileOg(result: PublicProfileReadResultV1,
    options: Omit<PublicProfileSvgOptions, 'kind' | 'theme' | 'metric'>): Promise<Buffer> {
    const sharp = await loadSharp();
    return sharp(Buffer.from(await renderPublicProfileSvg(result, { ...options, kind: 'og', theme: 'dark' }))).png().toBuffer();
}
