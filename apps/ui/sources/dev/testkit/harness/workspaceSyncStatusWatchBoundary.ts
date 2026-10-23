import { MACHINE_WATCH_WINDOW_MS } from '@happier-dev/protocol/rpc/machineWatchWindow';
import type { WorkspaceSyncStatusV1, WorkspaceSyncStatusWatchRequestV1, WorkspaceSyncStatusWatchResultV1,
    WorkspaceSyncStatusWatchSnapshotV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

/** Simulated remote daemon replies; the UI's read, watch lifecycle and codecs remain real. */
export function createWorkspaceSyncStatusWatchBoundary() {
    let snapshot: WorkspaceSyncStatusWatchSnapshotV1 | undefined;
    const pending = new Set<(reply: WorkspaceSyncStatusWatchResultV1) => void>();
    return {
        watch(input: WorkspaceSyncStatusWatchRequestV1 & Readonly<{ signal?: AbortSignal }>): Promise<WorkspaceSyncStatusWatchResultV1> {
            if (input.signal?.aborted) return Promise.resolve({ changed: false });
            if (snapshot && input.sinceRevision !== snapshot.revision) return Promise.resolve({ changed: true, snapshot });
            return new Promise(resolve => {
                const finish = (reply: WorkspaceSyncStatusWatchResultV1) => {
                    clearTimeout(timer);
                    input.signal?.removeEventListener('abort', abort);
                    pending.delete(finish);
                    resolve(reply);
                };
                const abort = () => finish({ changed: false });
                const timer = setTimeout(abort, MACHINE_WATCH_WINDOW_MS);
                input.signal?.addEventListener('abort', abort, { once: true });
                pending.add(finish);
            });
        },
        publish(statuses: readonly WorkspaceSyncStatusV1[]): void {
            snapshot = { revision: (snapshot?.revision ?? 0) + 1, statuses };
            for (const finish of [...pending]) finish({ changed: true, snapshot });
        },
        parkedCount: () => pending.size,
        reset(): void {
            for (const finish of [...pending]) finish({ changed: false });
            snapshot = undefined;
        },
    };
}
