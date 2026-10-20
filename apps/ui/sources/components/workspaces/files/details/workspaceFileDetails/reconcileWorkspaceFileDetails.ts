import type { WorkspaceFileDetailsFileContent, WorkspaceFileDetailsRefreshResult } from './refreshWorkspaceFileDetails';

export type WorkspaceFileDetailsPublication = Readonly<{
    fileContent: WorkspaceFileDetailsFileContent | null;
    diffContent: string | null;
    fileWriteSupported: boolean;
    staleSince: number | null;
    lastOwnWriteHash: string | null;
}>;

function sameContent(a: WorkspaceFileDetailsFileContent | null, b: WorkspaceFileDetailsFileContent | null): boolean {
    return a === b || Boolean(a && b && a.content === b.content && a.isBinary === b.isBinary
        && a.contentHash === b.contentHash && a.binaryBase64 === b.binaryBase64
        && a.binaryMime === b.binaryMime && a.binarySizeBytes === b.binarySizeBytes
        && a.binaryPreviewRevision === b.binaryPreviewRevision
        && a.partial?.slice === b.partial?.slice && a.partial?.offset === b.partial?.offset
        && a.partial?.length === b.partial?.length && a.partial?.totalBytes === b.partial?.totalBytes
        && a.encoding?.editable === b.encoding?.editable && a.encoding?.hasBom === b.encoding?.hasBom
        && a.encoding?.reason === b.encoding?.reason && a.encoding?.eol === b.encoding?.eol
        && a.encoding?.mixedEol === b.encoding?.mixedEol);
}

/** Reconcile only publications for the same resource; the loader drops state on a resource change. */
export function reconcileWorkspaceFileDetails(
    previous: WorkspaceFileDetailsPublication,
    result: WorkspaceFileDetailsRefreshResult,
    receivedAt: number,
): WorkspaceFileDetailsPublication {
    const retainsFile = Boolean(result.error && !result.fileContent && previous.fileContent);
    const retainsDiff = Boolean(result.error && !result.diffContent && previous.diffContent);
    const nextContent = retainsFile ? previous.fileContent : result.fileContent;
    return {
        fileContent: sameContent(previous.fileContent, nextContent) ? previous.fileContent : nextContent,
        diffContent: result.error && !result.diffContent ? previous.diffContent : result.diffContent,
        fileWriteSupported: retainsFile ? previous.fileWriteSupported : result.fileWriteSupported,
        staleSince: retainsFile || retainsDiff ? previous.staleSince ?? receivedAt : null,
        lastOwnWriteHash: previous.lastOwnWriteHash ?? null,
    };
}

/** Publish the acknowledged write version, superseding pre-write reads at the loader's request boundary. */
export function publishSavedWorkspaceFileDetails(previous: WorkspaceFileDetailsPublication,
    value: Readonly<{ text: string; hash: string }>): WorkspaceFileDetailsPublication {
    return { ...previous,
        fileContent: { ...previous.fileContent, content: value.text, contentHash: value.hash, isBinary: false },
        fileWriteSupported: true, staleSince: null, lastOwnWriteHash: value.hash,
    };
}
