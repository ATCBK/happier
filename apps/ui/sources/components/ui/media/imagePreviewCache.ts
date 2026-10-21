export type ImagePreviewCacheKey = Readonly<{
    sessionId: string;
    signature: string;
    filePath: string;
}>;

export type ImagePreviewCacheValue =
    | Readonly<{ status: 'loaded'; uri: string; cleanup?: (() => void | Promise<void>) | null; byteLength?: number | null; mimeType?: string }>
    | Readonly<{ status: 'error'; error: string; errorCode?: string }>;

/** A shared fill's bytes so far; every consumer of the key sees the one transfer's progress. */
export type ImagePreviewCacheProgress = Readonly<{ receivedBytes: number; totalBytes: number }>;
type ProgressListener = (progress: ImagePreviewCacheProgress) => void;
type ValueListener = (value: ImagePreviewCacheValue | null) => void;

export type ImagePreviewCacheEntry = Readonly<{
    value: ImagePreviewCacheValue;
    byteSize: number;
    cachedAtMs: number;
    sessionId: string;
    signature: string;
    filePath: string;
}>;

export type ImagePreviewCacheOptions = Readonly<{
    maxEntries: number;
    maxTotalBytes: number;
    now: () => number;
}>;

export class ImagePreviewCache {
    private readonly entries = new Map<string, ImagePreviewCacheEntry>();
    private readonly retained = new Map<string, number>();
    private readonly pending = new Map<string, { controller: AbortController; promise: Promise<ImagePreviewCacheValue>; progress: ImagePreviewCacheProgress | null }>();
    private readonly progressListeners = new Map<string, Set<ProgressListener>>();
    private readonly valueListeners = new Map<string, Set<ValueListener>>();
    private totalBytes = 0;
    private maxEntries: number;
    private maxTotalBytes: number;

    constructor(private readonly options: ImagePreviewCacheOptions) {
        this.maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, options.maxEntries) : 0;
        this.maxTotalBytes = Number.isFinite(options.maxTotalBytes) ? Math.max(0, options.maxTotalBytes) : 0;
    }

    get(key: ImagePreviewCacheKey): ImagePreviewCacheValue | null {
        const storageKey = this.toStorageKey(key);
        const existing = this.entries.get(storageKey) ?? null;
        if (!existing) return null;

        // Refresh LRU order by reinserting at the end.
        this.entries.delete(storageKey);
        this.entries.set(storageKey, existing);
        return existing.value;
    }

    /** A thumbnail follows existing bytes without becoming a producer of a full-size fill. */
    observeValue(key: ImagePreviewCacheKey, listener: ValueListener): () => void {
        const storageKey = this.toStorageKey(key);
        const listeners = this.valueListeners.get(storageKey) ?? new Set<ValueListener>();
        listeners.add(listener);
        this.valueListeners.set(storageKey, listeners);
        listener(this.get(key));
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.valueListeners.delete(storageKey);
        };
    }

    retain(key: ImagePreviewCacheKey): void {
        const storageKey = this.toStorageKey(key);
        this.retained.set(storageKey, (this.retained.get(storageKey) ?? 0) + 1);
    }

    release(key: ImagePreviewCacheKey): void {
        const storageKey = this.toStorageKey(key);
        const count = this.retained.get(storageKey) ?? 0;
        if (count > 1) this.retained.set(storageKey, count - 1);
        else {
            this.retained.delete(storageKey);
            this.pending.get(storageKey)?.controller.abort();
            this.evictIfNeeded();
        }
    }

    /** The cache owns a shared fill; one disappearing consumer cannot cancel another's read. */
    load(
        key: ImagePreviewCacheKey,
        loader: (signal: AbortSignal, onProgress: ProgressListener) => Promise<ImagePreviewCacheValue>,
    ): Promise<ImagePreviewCacheValue> {
        const cached = this.get(key);
        if (cached) return Promise.resolve(cached);
        const storageKey = this.toStorageKey(key);
        const pending = this.pending.get(storageKey);
        if (pending && !pending.controller.signal.aborted) return pending.promise;
        const controller = new AbortController();
        const report: ProgressListener = (progress) => {
            const current = this.pending.get(storageKey);
            if (!current || current.controller !== controller) return;
            current.progress = progress;
            for (const listener of this.progressListeners.get(storageKey) ?? []) listener(progress);
        };
        const promise = loader(controller.signal, report).then(value => {
            // A cancelled fill must not revoke a retry's mounted URI by replacing it.
            if (controller.signal.aborted && (this.entries.has(storageKey) || this.pending.get(storageKey)?.promise !== promise)) {
                this.cleanupValue(value);
                return value;
            }
            // A late successful fill is still cache-owned and subject to ordinary eviction.
            if (value.status === 'loaded') this.set(key, value);
            return value;
        }).finally(() => {
            if (this.pending.get(storageKey)?.promise === promise) this.pending.delete(storageKey);
        });
        this.pending.set(storageKey, { controller, promise, progress: null });
        return promise;
    }

    /** Follows the key's in-flight fill (current progress first); a consumer joining late sees the same bytes. */
    observeProgress(key: ImagePreviewCacheKey, listener: ProgressListener): () => void {
        const storageKey = this.toStorageKey(key);
        const listeners = this.progressListeners.get(storageKey) ?? new Set<ProgressListener>();
        listeners.add(listener);
        this.progressListeners.set(storageKey, listeners);
        const current = this.pending.get(storageKey)?.progress;
        if (current) listener(current);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.progressListeners.delete(storageKey);
        };
    }

    setLimits(limits: Readonly<{ maxEntries: number; maxTotalBytes: number }>): void {
        this.maxEntries = Number.isFinite(limits.maxEntries) ? Math.max(0, limits.maxEntries) : 0;
        this.maxTotalBytes = Number.isFinite(limits.maxTotalBytes) ? Math.max(0, limits.maxTotalBytes) : 0;
        this.evictIfNeeded();
    }

    set(key: ImagePreviewCacheKey, value: ImagePreviewCacheValue): void {
        if (!key.sessionId || !key.signature || !key.filePath) return;
        const storageKey = this.toStorageKey(key);

        const previous = this.entries.get(storageKey) ?? null;
        if (previous) {
            this.totalBytes -= previous.byteSize;
            this.entries.delete(storageKey);
            this.cleanupValue(previous.value);
        }

        const byteSize = this.estimateBytes(value);
        const entry: ImagePreviewCacheEntry = {
            value,
            byteSize,
            cachedAtMs: this.options.now(),
            sessionId: key.sessionId,
            signature: key.signature,
            filePath: key.filePath,
        };
        this.entries.set(storageKey, entry);
        this.totalBytes += byteSize;
        for (const listener of this.valueListeners.get(storageKey) ?? []) listener(value);
        this.evictIfNeeded();
    }

    invalidateSession(sessionId: string): void {
        if (!sessionId) return;
        for (const [storageKey, entry] of this.entries) {
            if (entry.sessionId !== sessionId) continue;
            this.entries.delete(storageKey);
            this.totalBytes -= entry.byteSize;
            this.cleanupValue(entry.value);
            for (const listener of this.valueListeners.get(storageKey) ?? []) listener(null);
        }
    }

    invalidatePaths(input: Readonly<{ sessionId: string; paths: ReadonlySet<string> }>): void {
        const sessionId = input.sessionId;
        if (!sessionId) return;

        for (const [storageKey, entry] of this.entries) {
            if (entry.sessionId !== sessionId) continue;
            if (!input.paths.has(entry.filePath)) continue;
            this.entries.delete(storageKey);
            this.totalBytes -= entry.byteSize;
            this.cleanupValue(entry.value);
            for (const listener of this.valueListeners.get(storageKey) ?? []) listener(null);
        }
    }

    private estimateBytes(value: ImagePreviewCacheValue): number {
        if (value.status === 'loaded') {
            if (typeof value.byteLength === 'number' && Number.isFinite(value.byteLength)) {
                return Math.max(0, Math.floor(value.byteLength));
            }
            return Math.max(0, value.uri.length * 2);
        }
        return Math.max(0, value.error.length * 2);
    }

    private cleanupValue(value: ImagePreviewCacheValue): void {
        if (value.status !== 'loaded' || typeof value.cleanup !== 'function') return;
        try {
            void Promise.resolve(value.cleanup()).catch(() => undefined);
        } catch {}
    }

    private toStorageKey(key: ImagePreviewCacheKey): string {
        return `${key.sessionId}\u0000${key.signature}\u0000${key.filePath}`;
    }

    private evictIfNeeded(): void {
        const maxEntries = this.maxEntries;
        const maxTotalBytes = this.maxTotalBytes;

        while (this.entries.size > maxEntries || (maxTotalBytes > 0 && this.totalBytes > maxTotalBytes)) {
            const oldestKey = [...this.entries.keys()].find(key => !this.retained.has(key));
            if (!oldestKey) break;
            const oldest = this.entries.get(oldestKey);
            this.entries.delete(oldestKey);
            if (oldest) {
                this.totalBytes -= oldest.byteSize;
                this.cleanupValue(oldest.value);
                for (const listener of this.valueListeners.get(oldestKey) ?? []) listener(null);
            }
        }
    }
}
