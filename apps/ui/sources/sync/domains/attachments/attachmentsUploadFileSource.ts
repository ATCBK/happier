export type AttachmentsUploadFileSource =
    | Readonly<{ kind: 'web'; file: File }>
    | Readonly<{
        kind: 'memory';
        bytes: Uint8Array;
        name: string;
        mimeType?: string | null;
        previewUri?: string | null;
    }>
    | Readonly<{
        kind: 'native';
        uri: string;
        name: string;
        sizeBytes?: number | null;
        mimeType?: string | null;
    }>;

export type AttachmentFolderEntry = Readonly<{
    relativePath: string;
    source: AttachmentsUploadFileSource;
}>;

/** Enumerated folder entries share one intake and upload path on every platform. */
export type AttachmentUploadSource = AttachmentsUploadFileSource | Readonly<{
    kind: 'folder';
    name: string;
    mimeType: 'inode/directory';
    entries: readonly AttachmentFolderEntry[];
    directories?: readonly string[];
}>;

export type AddWebAttachmentsOptions = Readonly<{ sources?: readonly AttachmentUploadSource[] }>;
