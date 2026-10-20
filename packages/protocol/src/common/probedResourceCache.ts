export type ProbedResourcePhase = 'idle' | 'loading' | 'refreshing';

export type ProbedResourceSnapshot<T> = Readonly<{
  phase: ProbedResourcePhase;
  data: T | null;
  dataUpdatedAt: number | null;
  error: unknown | null;
  errorUpdatedAt: number | null;
  isStale: boolean;
}>;

type ProbedResourceEntry<T> = {
  data: T | null;
  dataUpdatedAt: number | null;
  error: unknown | null;
  errorUpdatedAt: number | null;
  inflight: ProbedResourceFlight<T> | null;
};

type ProbedResourceFlight<T> = {
  promise: Promise<T | null>;
  controller: AbortController;
  consumers: number;
};

export class ProbedResourceCache<T> {
  readonly #entries = new Map<string, ProbedResourceEntry<T>>();
  readonly #staleTimeMs: number;
  readonly #errorCooldownMs: number;
  readonly #nowMs: () => number;
  readonly #listenersByKey = new Map<string, Set<() => void>>();

  constructor(params: Readonly<{ staleTimeMs: number; errorCooldownMs: number; nowMs?: () => number }>) {
    this.#staleTimeMs = Math.max(0, params.staleTimeMs);
    this.#errorCooldownMs = Math.max(0, params.errorCooldownMs);
    this.#nowMs = typeof params.nowMs === 'function' ? params.nowMs : () => Date.now();
  }

  keys(): IterableIterator<string> {
    return this.#entries.keys();
  }

  clear(): void {
    this.#entries.clear();
    this.#listenersByKey.clear();
  }

  delete(key: string): void {
    this.#entries.delete(key);
    this.#emit(key);
  }

  read(key: string): Readonly<{
    data: T | null;
    dataUpdatedAt: number | null;
    error: unknown | null;
    errorUpdatedAt: number | null;
    inflight: Promise<T | null> | null;
  }> | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    return {
      data: entry.data,
      dataUpdatedAt: entry.dataUpdatedAt,
      error: entry.error,
      errorUpdatedAt: entry.errorUpdatedAt,
      inflight: entry.inflight?.promise ?? null,
    };
  }

  getSnapshot(key: string, nowMs = this.#nowMs()): ProbedResourceSnapshot<T> {
    const entry = this.#entries.get(key) ?? null;
    const data = entry?.data ?? null;
    const dataUpdatedAt = entry?.dataUpdatedAt ?? null;
    const error = entry?.error ?? null;
    const errorUpdatedAt = entry?.errorUpdatedAt ?? null;
    const inflight = entry?.inflight ?? null;

    const isStale =
      dataUpdatedAt !== null &&
      nowMs >= 0 &&
      nowMs - dataUpdatedAt > this.#staleTimeMs;

    const phase: ProbedResourcePhase = inflight ? (data ? 'refreshing' : 'loading') : 'idle';

    return { phase, data, dataUpdatedAt, error, errorUpdatedAt, isStale };
  }

  setSuccess(key: string, data: T, nowMs = this.#nowMs()): void {
    const entry = this.#entries.get(key) ?? {
      data: null,
      dataUpdatedAt: null,
      error: null,
      errorUpdatedAt: null,
      inflight: null,
    };
    entry.data = data;
    entry.dataUpdatedAt = nowMs;
    entry.error = null;
    entry.errorUpdatedAt = null;
    this.#entries.set(key, entry);
    this.#emit(key);
  }

  setError(key: string, error: unknown, nowMs = this.#nowMs()): void {
    const entry = this.#entries.get(key) ?? {
      data: null,
      dataUpdatedAt: null,
      error: null,
      errorUpdatedAt: null,
      inflight: null,
    };
    entry.error = error;
    entry.errorUpdatedAt = nowMs;
    this.#entries.set(key, entry);
    this.#emit(key);
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.#listenersByKey.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listenersByKey.set(key, listeners);
    return () => {
      const current = this.#listenersByKey.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#listenersByKey.delete(key);
    };
  }

  async ensure(
    key: string,
    fetcher: (signal: AbortSignal) => Promise<T>,
    opts?: Readonly<{ force?: boolean; nowMs?: number; signal?: AbortSignal }>,
  ): Promise<T | null> {
    const nowMs = typeof opts?.nowMs === 'number' ? opts.nowMs : this.#nowMs();

    const existing = this.#entries.get(key) ?? {
      data: null,
      dataUpdatedAt: null,
      error: null,
      errorUpdatedAt: null,
      inflight: null,
    };

    if (opts?.signal?.aborted) return existing.data;
    if (existing.inflight) return await this.#join(key, existing, existing.inflight, opts?.signal);

    const hasData = existing.dataUpdatedAt !== null;
    const isStale =
      hasData &&
      nowMs >= 0 &&
      nowMs - (existing.dataUpdatedAt as number) > this.#staleTimeMs;

    const inErrorCooldown =
      existing.errorUpdatedAt !== null &&
      nowMs >= 0 &&
      nowMs - existing.errorUpdatedAt < this.#errorCooldownMs;

    const shouldFetch = Boolean(
      opts?.force === true ||
        (!inErrorCooldown && (!hasData || isStale)),
    );

    if (!shouldFetch) {
      this.#entries.set(key, existing);
      return existing.data;
    }

    const flight: ProbedResourceFlight<T> = {
      controller: new AbortController(),
      consumers: 0,
      promise: Promise.resolve(null),
    };
    existing.inflight = flight;
    this.#entries.set(key, existing);
    flight.promise = (async () => {
      try {
        const value = await fetcher(flight.controller.signal);
        if (flight.controller.signal.aborted) return existing.data;
        if (this.#entries.get(key) !== existing) return value;
        const commitNowMs = this.#nowMs();
        existing.data = value;
        existing.dataUpdatedAt = commitNowMs;
        existing.error = null;
        existing.errorUpdatedAt = null;
        return value;
      } catch (e) {
        if (flight.controller.signal.aborted || this.#entries.get(key) !== existing) return existing.data;
        const commitNowMs = this.#nowMs();
        existing.error = e;
        existing.errorUpdatedAt = commitNowMs;
        return existing.data;
      } finally {
        if (existing.inflight === flight) {
          existing.inflight = null;
          if (this.#entries.get(key) === existing) this.#emit(key);
        }
      }
    })();

    this.#emit(key);
    return await this.#join(key, existing, flight, opts?.signal);
  }

  #join(key: string, entry: ProbedResourceEntry<T>, flight: ProbedResourceFlight<T>, signal?: AbortSignal): Promise<T | null> {
    flight.consumers += 1;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        flight.consumers -= 1;
        resolve(value);
      };
      const cancel = () => {
        finish(entry.data);
        if (flight.consumers !== 0 || entry.inflight !== flight) return;
        // A flight belongs to its joined consumers, not whichever view started it.
        entry.inflight = null;
        flight.controller.abort();
        if (this.#entries.get(key) === entry) this.#emit(key);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      void flight.promise.then(finish);
    });
  }

  #emit(key: string): void {
    const listeners = this.#listenersByKey.get(key);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  }
}
