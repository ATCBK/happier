export type WebDroppedFileEntry = Readonly<{
    file: File;
    relativePath: string;
}>;

export type WebDroppedEntriesOptions = Readonly<{ onDirectory?: (relativePath: string) => void }>;

export async function readWebDroppedEntries(_dataTransfer: unknown, _options?: WebDroppedEntriesOptions): Promise<WebDroppedFileEntry[]> {
    return [];
}

