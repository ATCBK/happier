import * as React from 'react';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { deriveSettledFileWrites } from '../derivation/deriveLiveFileWrites';
import { readFileWriteSessionMessages, useFileWriteSessionSnapshots } from './fileWriteSessionSnapshots';
import type { FileWriteSessionSnapshot } from './fileWriteSessionSnapshots';

type SettledSessionHistory = { seen: Set<string>; transcript: FileWriteSessionSnapshot['transcript'] };

/** Terminal path evidence survives the activity gate, including batched first-seen results. */
export function useWorkspaceFileWriteSettlements(scope: WorkspaceScopeBase | null, onSettled: (paths: readonly string[]) => void): void {
    const snapshots = useFileWriteSessionSnapshots({ scope });
    const workspaceKey = scope ? tryBuildWorkspaceCacheKey(scope) : null;
    const callback = React.useRef(onSettled);
    React.useLayoutEffect(() => { callback.current = onSettled; }, [onSettled]);
    const history = React.useRef<{ key: string | null; sessions: Map<string, SettledSessionHistory> }>({ key: null, sessions: new Map() });
    React.useEffect(() => {
        if (history.current.key !== workspaceKey) history.current = { key: workspaceKey, sessions: new Map() };
        if (!scope || !workspaceKey) return;
        const paths = new Set<string>();
        for (const snapshot of snapshots) {
            if (!snapshot.transcript?.isLoaded) continue;
            const previous = history.current.sessions.get(snapshot.session.id);
            if (previous?.transcript === snapshot.transcript) continue;
            const settled = deriveSettledFileWrites(readFileWriteSessionMessages(snapshot), { workspaceRoot: scope.rootPath, sessionId: snapshot.session.id });
            if (!previous) {
                // An unloaded transcript is not a first snapshot: hydrate history before seeding.
                history.current.sessions.set(snapshot.session.id, { seen: new Set(settled.keys()), transcript: snapshot.transcript });
                continue;
            }
            previous.transcript = snapshot.transcript;
            for (const [toolCallId, write] of settled) {
                if (previous.seen.has(toolCallId)) continue;
                previous.seen.add(toolCallId);
                for (const path of write.paths) paths.add(path);
            }
        }
        if (paths.size > 0) callback.current(Object.freeze([...paths]));
    }, [snapshots, workspaceKey, scope?.rootPath]);
}
