import { open, readFile, stat } from 'fs/promises';

import { configuration } from '@/configuration';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';

import { validatePath } from '../pathSecurity';
import { authorizeFilesystemPathWithinRoot } from './accessPolicy/filesystemPathAuthorization';
import type { FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';
import {
  authorizeExactAllowedReadFile,
  type ExactAllowedReadFile,
} from './accessPolicy/exactAllowedReadFile';
import { registerRootedFilesystemRpcHandlers } from './registerRootedFilesystemRpcHandlers';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import type { ActionId } from '@happier-dev/protocol';
import { FilesystemReadFileInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';

type ReadFileRequest = Readonly<{ rootPath?: string; path: string; offset?: number; length?: number }>;

type ReadFileResponse =
  | Readonly<{ success: true; content: string; sizeBytes?: number; eof?: boolean }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

type ReadFileHandlerDeps = Readonly<{
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
  getAdditionalAllowedReadFiles?: () => ReadonlyArray<ExactAllowedReadFile>;
}>;

async function readFileForRpc(data: ReadFileRequest | undefined, deps: ReadFileHandlerDeps): Promise<ReadFileResponse> {
  // Rootless predecessor reads retain their policy and exact-file grants below;
  // the same current schema owns byte-range admission for both RPC carriers.
  const parsed = FilesystemReadFileInputSchema.safeParse({ ...data,
    rootPath: data?.rootPath === undefined ? deps.workingDirectory : data.rootPath });
  if (!parsed.success) {
    return { success: false, errorCode: 'invalid_request', error: 'Invalid file read request' };
  }
  const path = typeof data?.path === 'string' ? data.path : '';
  logger.debug('Read file request:', path);
  const validation = data?.rootPath === undefined
    ? validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs(), deps.accessPolicy)
    : authorizeFilesystemPathWithinRoot({ targetPath: path, rootPath: data.rootPath,
      defaultDirectory: deps.workingDirectory, accessPolicy: deps.accessPolicy,
      additionalAllowedDirs: deps.getAdditionalAllowedReadDirs() });
  let resolvedPath: string;
  if (validation.valid && validation.resolvedPath) {
    resolvedPath = validation.resolvedPath;
  } else {
    if (data?.rootPath !== undefined) return { success: false, error: validation.error ?? 'Access denied' };
    const exactFileValidation = authorizeExactAllowedReadFile({
      targetPath: path,
      workingDirectory: deps.workingDirectory,
      allowedFiles: deps.getAdditionalAllowedReadFiles?.(),
    });
    if (!exactFileValidation.valid) {
      return { success: false, error: exactFileValidation.error ?? validation.error ?? 'Access denied' };
    }
    resolvedPath = exactFileValidation.resolvedPath;
  }

  try {
    const stats = await stat(resolvedPath);
    if (stats.isDirectory()) {
      return { success: false, error: 'Path is a directory' };
    }
    const length = parsed.data.length;
    if (length !== undefined) {
      if (length > configuration.filesReadMaxBytes) {
        return { success: false, error: 'Requested range is too large to read' };
      }
      const file = await open(resolvedPath, 'r');
      try {
        const sizeBytes = (await file.stat()).size;
        const offset = parsed.data.offset ?? 0;
        const buffer = Buffer.alloc(Math.min(length, Math.max(0, sizeBytes - offset)));
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
          if (chunk.bytesRead === 0) break;
          bytesRead += chunk.bytesRead;
        }
        if ((await file.stat()).size !== sizeBytes || bytesRead !== buffer.length) {
          return { success: false, error: 'File changed during download. Try again' };
        }
        return { success: true, content: buffer.subarray(0, bytesRead).toString('base64'), sizeBytes,
          eof: offset + bytesRead >= sizeBytes };
      } finally {
        await file.close();
      }
    }
    if (stats.size > configuration.filesReadMaxBytes) {
      return { success: false, error: 'File is too large to read' };
    }

    const buffer = await readFile(resolvedPath);
    return { success: true, content: buffer.toString('base64') };
  } catch (error) {
    logger.debug('Failed to read file:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' };
  }
}

export function createReadFileRpcActionExecutor(deps: ReadFileHandlerDeps): RpcActionExecutor {
  return {
    async execute(actionId: ActionId, input: unknown) {
      if (actionId !== 'daemon.filesystem.readFile') {
        return { ok: false, errorCode: 'unsupported_action', error: `Unsupported action: ${actionId}` };
      }
      return {
        ok: true,
        result: await readFileForRpc(input as ReadFileRequest | undefined, deps),
      };
    },
  };
}

export function registerReadFileHandler(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
    getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
    getAdditionalAllowedReadFiles?: () => ReadonlyArray<ExactAllowedReadFile>;
    actionExecutor?: RpcActionExecutor;
  }>,
): void {
  registerRootedFilesystemRpcHandlers({
    rpcHandlerManager,
    workingDirectory: deps.workingDirectory,
    actionExecutor: deps.actionExecutor,
    incumbentExecutor: createReadFileRpcActionExecutor(deps),
    actionIds: ['daemon.filesystem.readFile'],
  });
}
