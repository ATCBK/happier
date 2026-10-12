import { cleanupAndShutdown as runCleanupAndShutdown } from '../lifecycle/cleanupAndShutdown';

export function createDaemonCleanupAndShutdown(
    params: Omit<Parameters<typeof runCleanupAndShutdown>[0], 'source' | 'errorMessage'> & Readonly<{
        markShutdownInitiated: () => void;
    }>,
) {
    return async (
        source: 'happier-app' | 'happier-cli' | 'os-signal' | 'exception',
        errorMessage?: string,
    ) => {
        params.markShutdownInitiated();
        await runCleanupAndShutdown({
            ...params,
            source,
            errorMessage,
        });
    };
}
