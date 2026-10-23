import { normalizeAttachmentRelativePathV1 } from '@happier-dev/protocol/transfers/attachments/attachmentPathV1';

/** Validate before joining so an absolute source cannot become relative. */
export function resolveUploadRelativePath(parentDir: string, relativePath: string): string | null {
    const relative = normalizeAttachmentRelativePathV1(relativePath);
    if (!relative) return null;
    if (!parentDir.trim()) return relative;
    const parent = normalizeAttachmentRelativePathV1(parentDir);
    return parent ? normalizeAttachmentRelativePathV1(`${parent}/${relative}`) : null;
}
