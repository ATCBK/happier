import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSecureTempDirectorySync } from '@happier-dev/plugin-sdk/fs';

import type { DeepSecTempFiles, DeepSecTempFileRequest } from './run.js';

export async function createDeepSecTempFiles(): Promise<DeepSecTempFiles> {
  const temporary = createSecureTempDirectorySync({ prefix: 'deepsec' });
  const directory = temporary.path;
  return {
    async createTextFile(request: DeepSecTempFileRequest) {
      const path = join(directory, `${randomUUID()}${request.suffix}`);
      await writeFile(path, request.contents, 'utf8');
      return path;
    },
    async createScopedPathListFile(request) {
      const path = join(directory, `${randomUUID()}${request.suffix}`);
      await writeFile(path, `${request.paths.join('\n')}\n`, 'utf8');
      return { status: 'created', path, paths: request.paths };
    },
    async readText(path: string) {
      return await readFile(path, 'utf8');
    },
    async cleanup() {
      temporary.cleanup();
    },
  };
}
