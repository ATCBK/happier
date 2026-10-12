import type { BuiltinPicture, PictureRecord, PictureStore } from './pictureStore.types';

export function builtinPictureLocalId(id: string): string { return `builtin:${id}`; }
/** The picker's own small record: browsing pictures never downloads their full-size originals. */
export function builtinThumbnailLocalId(id: string): string { return `builtin-thumb:${id}`; }

/** Download nonces never enter this identity; only the catalog's canonical URLs do. */
export function pictureSourceMatches(source: BuiltinPicture['src'] | undefined, expected: BuiltinPicture['src']): boolean {
    return source?.full === expected.full && source.thumb === expected.thumb;
}

/** Optional metadata on existing device records; absent/malformed identities are re-downloadable. */
export function readPictureSource(value: unknown): BuiltinPicture['src'] | undefined {
    if (typeof value !== 'object' || value === null || !('full' in value) || typeof value.full !== 'string'
        || !('thumb' in value) || typeof value.thumb !== 'string') return undefined;
    return { full: value.full, thumb: value.thumb };
}

/** One visit downloads once; a failed attempt is eligible again on the next visit. */
export function createBuiltinPictureEnsurer(
    store: Pick<PictureStore, 'get' | 'put'>,
    prepare: (data: Blob | string) => Promise<Blob | string>,
    fetchPicture: (url: string) => Promise<Response> = url => fetch(url),
) {
    const pending = new Map<string, Readonly<{ source: BuiltinPicture['src']; operation: Promise<PictureRecord> }>>();
    return function ensureBuiltin(picture: BuiltinPicture): Promise<PictureRecord> {
        const localId = builtinPictureLocalId(picture.id);
        const existing = pending.get(localId);
        if (existing) return pictureSourceMatches(existing.source, picture.src) ? existing.operation
            : existing.operation.then(() => ensureBuiltin(picture), () => ensureBuiltin(picture));
        const operation = (async () => {
            const stored = await store.get(localId);
            if (stored && pictureSourceMatches(stored.source, picture.src)) return stored;
            const download = async (url: string) => {
                const response = await fetchPicture(url);
                if (!response.ok) throw new Error(`Atmosphere picture download failed (${response.status}).`);
                return prepare(await response.blob());
            };
            const [data, thumb] = await Promise.all([download(picture.src.full), download(picture.src.thumb)]);
            return store.put({ localId, kind: 'builtin', data, thumb, source: picture.src });
        })().finally(() => pending.delete(localId));
        pending.set(localId, { source: picture.src, operation });
        return operation;
    };
}

/** A picker thumbnail: the full download's thumb when present, otherwise `src.thumb` alone, cached once. */
export function createBuiltinThumbnailEnsurer(
    store: Pick<PictureStore, 'get' | 'put'>,
    prepare: (data: Blob | string) => Promise<Blob | string>,
    fetchPicture: (url: string) => Promise<Response> = url => fetch(url),
) {
    const pending = new Map<string, Readonly<{ source: string; operation: Promise<Blob | string> }>>();
    return function ensureBuiltinThumbnail(picture: BuiltinPicture): Promise<Blob | string> {
        const localId = builtinThumbnailLocalId(picture.id);
        const existing = pending.get(localId);
        if (existing) return existing.source === picture.src.thumb ? existing.operation
            : existing.operation.then(() => ensureBuiltinThumbnail(picture), () => ensureBuiltinThumbnail(picture));
        const operation = (async () => {
            const full = await store.get(builtinPictureLocalId(picture.id));
            if (full?.thumb !== undefined && full.source?.thumb === picture.src.thumb) return full.thumb;
            const stored = await store.get(localId);
            if (stored?.source?.thumb === picture.src.thumb) return stored.data;
            const response = await fetchPicture(picture.src.thumb);
            if (!response.ok) throw new Error(`Atmosphere thumbnail download failed (${response.status}).`);
            return (await store.put({ localId, kind: 'builtin', data: await prepare(await response.blob()), source: picture.src })).data;
        })().finally(() => pending.delete(localId));
        pending.set(localId, { source: picture.src.thumb, operation });
        return operation;
    };
}
