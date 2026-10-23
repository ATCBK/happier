export type PictureInfo = Readonly<{
    localId: string;
    kind: 'user' | 'builtin';
    createdAtMs: number;
    size: number;
}>;
export type PictureRecord = PictureInfo & Readonly<{ data: Blob | string; thumb?: Blob | string; source?: BuiltinPicture['src'] }>;
export type PictureInput = Readonly<{ localId: string; kind: PictureInfo['kind']; data: Blob | string; thumb?: Blob | string; source?: BuiltinPicture['src'] }>;
export type BuiltinPicture = Readonly<{ id: string; src: Readonly<{ full: string; thumb: string }> }>;
export type PicturePreparationOptions = Readonly<{ format?: 'webp' | 'png' }>;
export type PictureSubscription = string | Readonly<{ kind: PictureInfo['kind'] }>;
export interface PictureStore {
    /** Prepare image bytes once before ingress; put only persists already-prepared bytes. */
    prepare(data: Blob | string, options?: PicturePreparationOptions): Promise<Blob | string>;
    put(input: PictureInput): Promise<PictureRecord>;
    get(localId: string): Promise<PictureRecord | undefined>;
    remove(localId: string): Promise<void>;
    list(): Promise<PictureInfo[]>;
    ensureBuiltin(picture: BuiltinPicture): Promise<PictureRecord>;
    ensureBuiltinThumbnail(picture: BuiltinPicture): Promise<Blob | string>;
    /** An exact picture, one library kind, or the whole device library when omitted. */
    subscribe(listener: () => void, selection?: PictureSubscription): () => void;
    getRevision(kind?: PictureInfo['kind']): number;
}
