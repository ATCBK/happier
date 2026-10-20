import * as React from 'react';

import { resolveWorkspaceFavicon, type WorkspaceFaviconResult } from '@/sync/ops/workspaceFavicon';

export function useWorkspaceFavicon(params: Readonly<{
    enabled: boolean;
    serverId?: string | null;
    machineId?: string | null;
    workspacePath?: string | null;
}>): Extract<WorkspaceFaviconResult, { status: 'found' }> | null {
    const [favicon, setFavicon] = React.useState<Extract<WorkspaceFaviconResult, { status: 'found' }> | null>(null);
    const serverId = params.serverId ?? null;
    const machineId = params.machineId ?? null;
    const workspacePath = params.workspacePath ?? null;

    React.useEffect(() => {
        const controller = new AbortController();
        if (!params.enabled || !machineId || !workspacePath) {
            setFavicon(null);
            return () => {
                controller.abort();
            };
        }

        setFavicon(null);
        void resolveWorkspaceFavicon({
            enabled: params.enabled,
            serverId,
            machineId,
            workspacePath,
            signal: controller.signal,
        }).then((result) => {
            if (controller.signal.aborted) return;
            setFavicon(result.status === 'found' ? result : null);
        }).catch(() => {
            if (!controller.signal.aborted) setFavicon(null);
        });

        return () => {
            controller.abort();
        };
    }, [params.enabled, serverId, machineId, workspacePath]);

    return favicon;
}
