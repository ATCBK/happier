import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import { validatePath } from '../pathSecurity';
import { authorizeFilesystemPathWithinRoot } from './accessPolicy/filesystemPathAuthorization';
import type { FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';
import { commitGuardedFileReplace, type GuardedFileReplaceResult } from './commitGuardedFileReplace';

export type WriteFileRequest = Readonly<{ rootPath?: string; path: string; content: string; expectedHash?: string | null }>;
export type WriteFileResponse = GuardedFileReplaceResult | Readonly<{ success: false; error: string; errorCode?: undefined }>;
export type WriteFileHandlerDeps = Readonly<{
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  getAdditionalAllowedWriteDirs: () => ReadonlyArray<string>;
}>;

/** Admits inline bytes then delegates guarded publication to the shared workspace writer. */
export async function writeFileForRpc(data: WriteFileRequest | undefined, deps: WriteFileHandlerDeps): Promise<WriteFileResponse> {
  const path = typeof data?.path === 'string' ? data.path : '';
  logger.debug('Write file request:', path);
  const validation = data?.rootPath === undefined
    ? validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedWriteDirs(), deps.accessPolicy)
    : authorizeFilesystemPathWithinRoot({ targetPath: path, rootPath: data.rootPath,
      defaultDirectory: deps.workingDirectory, accessPolicy: deps.accessPolicy,
      additionalAllowedDirs: deps.getAdditionalAllowedWriteDirs() });
  if (!validation.valid || !validation.resolvedPath) return { success: false, error: validation.error ?? 'Access denied' };
  const resolvedPath = validation.resolvedPath;
  try {
    const contentBase64 = typeof data?.content === 'string' ? data.content : '';
    const decodedByteLength = Buffer.byteLength(contentBase64, 'base64');
    const maxInlineWriteBytes = Math.min(configuration.filesReadMaxBytes, configuration.filesTransferChunkBytes);
    if (decodedByteLength > maxInlineWriteBytes) return { success: false, error: 'File content is too large to write' };
    return await commitGuardedFileReplace({ destPath: resolvedPath, expectation: data?.expectedHash,
      source: { kind: 'bytes', bytes: Buffer.from(contentBase64, 'base64') } });
  } catch (error) {
    logger.debug('Failed to write file:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to write file' };
  }
}
