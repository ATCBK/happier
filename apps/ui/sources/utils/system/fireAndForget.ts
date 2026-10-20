type FireAndForgetOptions = Readonly<{
    tag?: string;
    logError?: boolean;
    onError?: (error: unknown) => void;
}>;

export function fireAndForget(promise: Promise<unknown> | null | undefined, options?: FireAndForgetOptions): void {
    if (!promise || typeof promise.catch !== 'function') return;

    void promise.catch((error: unknown) => {
        try {
            if (options?.tag) {
                // Background tags and exception details are developer diagnostics. Expo turns
                // console.error into a raw on-screen toast; user failures belong to onError,
                // where the owning surface can present its typed, localized recovery state.
                if (options.logError === false) {
                    console.info(`[fireAndForget] ${options.tag}`);
                } else {
                    console.info(`[fireAndForget] ${options.tag}`, error);
                }
            }
            options?.onError?.(error);
        } catch {
            // ignore
        }
    });
}
