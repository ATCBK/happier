/** Only preview-owner Blob URLs are read here; a remote SVG must first use its authorized source. */
export async function readCachedSvgPreviewText(uri: string, signal: AbortSignal): Promise<string> {
    if (!uri.startsWith('blob:')) throw new Error('svg_preview_uri_not_local');
    const response = await fetch(uri, { signal });
    if (!response.ok) throw new Error('svg_preview_cache_read_failed');
    return response.text();
}
