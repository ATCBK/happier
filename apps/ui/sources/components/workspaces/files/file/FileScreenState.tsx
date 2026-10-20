
import { t } from '@/text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

function getBasename(path: string): string {
    const parts = path.split(/[\\/]/);
    const last = parts.at(-1) ?? path;
    return last || path;
}

export function FileLoadingState({ filePath }: { filePath: string }) {
    return (
        <SurfaceStateCard
            testID="file-details-loading"
            kind="loading"
            title={t('surfaceState.opening', { name: getBasename(filePath) })}
        />
    );
}

/** A file that could not be read: what failed, the reason (already human copy), and one retry. */
export function FileErrorState({ filePath, error, onRetry }: { filePath: string; error?: string | null; onRetry: () => void }) {
    return (
        <SurfaceStateCard
            testID="file-details-error"
            kind="error"
            title={t('surfaceState.couldNotOpen', { name: getBasename(filePath) })}
            reason={error ?? undefined}
            detail={filePath}
            action={{ label: t('surfaceState.tryAgain'), onPress: onRetry }}
        />
    );
}
