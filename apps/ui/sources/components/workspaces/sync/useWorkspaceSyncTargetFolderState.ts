import * as React from 'react';

import { isPathNotFoundErrorMessage } from '@/components/ui/pathPicker/PathSelectionList';
import { listMachineFileBrowserDirectoryEntries } from '@/sync/domains/input/machineFileBrowser';

/** What the chosen destination folder holds on its machine; `unknown` until the machine answers. */
export type WorkspaceSyncTargetFolderState = 'unknown' | 'missing' | 'empty' | 'nonempty';

/**
 * Reads the destination folder through the same machine file-browser owner the path picker uses, so
 * "Use existing folder" can be refused before the daemon would refuse it. An answer that is not a
 * clear missing/empty/non-empty verdict stays `unknown` and never blocks the person.
 */
export function useWorkspaceSyncTargetFolderState(input: Readonly<{
    machineId: string | null;
    serverId: string;
    path: string | null;
}>): WorkspaceSyncTargetFolderState {
    const [observed, setObserved] = React.useState<Readonly<{ key: string; state: WorkspaceSyncTargetFolderState }> | null>(null);
    const key = input.machineId && input.path ? `${input.serverId}\n${input.machineId}\n${input.path}` : null;

    React.useEffect(() => {
        if (!key || !input.machineId || !input.path) return;
        const controller = new AbortController();
        void listMachineFileBrowserDirectoryEntries({
            machineId: input.machineId,
            serverId: input.serverId,
            directoryPath: input.path,
            includeFiles: true,
            signal: controller.signal,
        }).then((result) => {
            if (controller.signal.aborted) return;
            setObserved({
                key,
                state: result.ok
                    ? (result.entries.length === 0 && !result.truncated ? 'empty' : 'nonempty')
                    : isPathNotFoundErrorMessage(result.error) ? 'missing' : 'unknown',
            });
        }, () => undefined);
        return () => controller.abort();
    }, [input.machineId, input.path, input.serverId, key]);

    return key && observed?.key === key ? observed.state : 'unknown';
}
