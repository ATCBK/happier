export type ServerFeaturesSnapshotRefreshLoop = Readonly<{
  refresh(): Promise<void>;
  stop(): void;
}>;

/**
 * Follow an active Home indexing transition at its existing deadline. Once it
 * settles, park until the connection or a real consumer requests a refresh.
 */
export function startServerFeaturesSnapshotRefreshLoop(params: Readonly<{
  refresh(): Promise<void>;
  isTransitionActive(): boolean;
  transitionIntervalMs: number;
  onError?: (error: unknown) => void;
}>): ServerFeaturesSnapshotRefreshLoop {
  let stopped = false;
  let timeout: NodeJS.Timeout | null = null;
  let pendingRefresh: Promise<void> | null = null;

  const scheduleNext = () => {
    if (stopped || !params.isTransitionActive()) return;
    timeout = setTimeout(() => {
      timeout = null;
      void refresh();
    }, params.transitionIntervalMs);
    timeout.unref?.();
  };
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (timeout) clearTimeout(timeout);
    timeout = null;
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = Promise.resolve()
      .then(() => params.refresh())
      .catch((error: unknown) => { params.onError?.(error); })
      .finally(() => {
        pendingRefresh = null;
        scheduleNext();
      });
    return pendingRefresh;
  };

  void refresh();

  return {
    refresh,
    stop() {
      stopped = true;
      if (timeout) clearTimeout(timeout);
      timeout = null;
    },
  };
}
