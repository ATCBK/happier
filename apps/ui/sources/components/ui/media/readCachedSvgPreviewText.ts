/** Decode the preview owner's local cache file; this function owns no transport or temporary URI. */
export async function readCachedSvgPreviewText(uri: string, _signal: AbortSignal): Promise<string> {
    const { File } = await import('expo-file-system');
    return new File(uri).text();
}
