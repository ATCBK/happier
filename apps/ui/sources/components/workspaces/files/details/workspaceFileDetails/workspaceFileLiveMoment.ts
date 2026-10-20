import type { Hunk } from '@happier-dev/protocol/diff/hunks';
import type { WorkspaceFileDetailsFileContent } from './refreshWorkspaceFileDetails';

export type WorkspaceFileLiveMoment = Readonly<{
    changedLines: readonly number[];
    contentHash: string | null;
    /** The rendered tint redirects its running animation; it must not reset to full opacity. */
    restartFromCurrentOpacity: true;
}>;

export function isWorkspaceFileLiveUpdate(input: Readonly<{
    previous: WorkspaceFileDetailsFileContent | null;
    content: WorkspaceFileDetailsFileContent | null;
    isActive: boolean;
    isEditing: boolean;
    hasDraft: boolean;
    ownWriteHash?: string | null;
}>): boolean {
    const { previous, content } = input;
    if (!input.isActive || input.isEditing || input.hasDraft || !previous || !content
        || previous.isBinary || content.isBinary || previous.partial || content.partial) return false;
    if (previous.content === content.content) return false;
    if (content.contentHash && (previous.contentHash === content.contentHash || input.ownWriteHash === content.contentHash)) return false;
    return true;
}

export function createWorkspaceFileLiveMoment(hunks: readonly Hunk[], contentHash: string | null, reducedMotion: boolean): WorkspaceFileLiveMoment {
    const changed = new Set<number>();
    if (!reducedMotion) for (const hunk of hunks) {
        let line = hunk.newStart;
        for (const entry of hunk.lines) {
            if (entry.kind === 'add') changed.add(line);
            if (entry.kind !== 'remove') line += 1;
        }
    }
    return { changedLines: [...changed].sort((a, b) => a - b), contentHash, restartFromCurrentOpacity: true };
}
