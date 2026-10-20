import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { FilesystemWriteFileInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';

export function readApprovalFileSource(request: Pick<ApprovalRequest, 'actionId' | 'actionArgs'>): Readonly<{ rootPath: string; path: string }> | null {
    if (request.actionId !== 'daemon.filesystem.writeFile') return null;
    // Read raw validated operands, never the human-readable/quoted approval projection.
    const input = FilesystemWriteFileInputSchema.safeParse(request.actionArgs);
    return input.success ? { rootPath: input.data.rootPath, path: input.data.path } : null;
}
