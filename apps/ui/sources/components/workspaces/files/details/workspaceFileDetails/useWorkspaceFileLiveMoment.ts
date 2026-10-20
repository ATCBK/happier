import * as React from 'react';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import { deriveFileChangeDiff } from '@/sync/domains/session/changes/derivation/deriveFileChangeDiff';
import type { WorkspaceFileDetailsFileContent } from './refreshWorkspaceFileDetails';
import { createWorkspaceFileLiveMoment, isWorkspaceFileLiveUpdate, type WorkspaceFileLiveMoment } from './workspaceFileLiveMoment';

export type { WorkspaceFileLiveMoment } from './workspaceFileLiveMoment';

export function useWorkspaceFileLiveMoment(input: Readonly<{
    resourceKey: string;
    content: WorkspaceFileDetailsFileContent | null;
    isActive: boolean;
    isEditing: boolean;
    hasDraft: boolean;
    ownWriteHash?: string | null;
    reducedMotion: boolean;
}>): WorkspaceFileLiveMoment | null {
    const previous = React.useRef({ resourceKey: input.resourceKey, content: input.content });
    const [moment, setMoment] = React.useState<WorkspaceFileLiveMoment | null>(null);
    React.useEffect(() => {
        const old = previous.current;
        previous.current = { resourceKey: input.resourceKey, content: input.content };
        if (old.resourceKey !== input.resourceKey || !input.isActive || input.isEditing || input.hasDraft) {
            setMoment(null);
            return;
        }
        if (input.reducedMotion) setMoment(previousMoment => previousMoment?.changedLines.length
            ? { ...previousMoment, changedLines: [] } : previousMoment);
        if (!isWorkspaceFileLiveUpdate({ ...input, previous: old.content }) || !old.content || !input.content) return;
        const diff = deriveFileChangeDiff({ filePath: input.resourceKey, changeKind: 'modified',
            oldText: old.content.content, newText: input.content.content,
            source: 'inferred', confidence: 'exact', provider: 'workspace' });
        setMoment(createWorkspaceFileLiveMoment(diff ? parseUnifiedDiffHunks(diff) : [], input.content.contentHash ?? null, input.reducedMotion));
    }, [input.resourceKey, input.content, input.isActive, input.isEditing, input.hasDraft, input.ownWriteHash, input.reducedMotion]);
    return previous.current.resourceKey === input.resourceKey ? moment : null;
}
