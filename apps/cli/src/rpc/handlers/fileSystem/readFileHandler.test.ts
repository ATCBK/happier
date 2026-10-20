import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FilesystemReadFileOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandler } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { registerReadFileHandler } from './readFileHandler';

const filesystemBoundary = vi.hoisted(() => ({ truncateOnReadPath: null as string | null }));
// The OS read boundary truncates a real file after the owner's stat. All path
// admission, range handling, EOF decisions and returned schemas remain real.
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    if (args[0] !== filesystemBoundary.truncateOnReadPath) return file;
    return new Proxy(file, { get(target, key) {
      if (key === 'read') return async (...readArgs: unknown[]) => {
        await actual.truncate(args[0], 1);
        return Reflect.apply(target.read, target, readArgs);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});

describe('readFile ranged RPC', () => {
  it('refuses bytes from a file truncated during the range read instead of reporting stale EOF metadata', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-ranged-read-truncate-'));
    const handlers = new Map<string, RpcHandler>();
    registerReadFileHandler({ registerHandler: (name, handler) => { handlers.set(name, handler); } }, {
      workingDirectory: rootPath, accessPolicy: { kind: 'osUser' }, getAdditionalAllowedReadDirs: () => [],
    });
    const read = handlers.get('daemon.filesystem.readFile');
    if (!read) throw new Error('Missing file read handler');
    try {
      await writeFile(join(rootPath, 'changing.bin'), Buffer.from('abcdef'));
      filesystemBoundary.truncateOnReadPath = join(rootPath, 'changing.bin');
      expect(await read({ rootPath, path: 'changing.bin', offset: 2, length: 3 })).toMatchObject({
        success: false, error: 'File changed during download. Try again',
      });
    } finally {
      filesystemBoundary.truncateOnReadPath = null;
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.each(['daemon.filesystem.readFile', RPC_METHODS.READ_FILE])('reads bounded slices through %s including a file above the whole-read cap', async method => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-ranged-read-'));
    const handlers = new Map<string, RpcHandler>();
    registerReadFileHandler({ registerHandler: (name, handler) => { handlers.set(name, handler); } }, {
      workingDirectory: rootPath, accessPolicy: { kind: 'osUser' }, getAdditionalAllowedReadDirs: () => [],
    });
    const read = handlers.get(method);
    if (!read) throw new Error(`Missing read handler ${method}`);
    const bytes = Buffer.alloc(configuration.filesReadMaxBytes + 8, 0x61);
    Buffer.from([0x00, 0xff, 0x80, 0x41]).copy(bytes, 3);
    try {
      await writeFile(join(rootPath, 'large.bin'), bytes);
      const input = method === RPC_METHODS.READ_FILE ? { path: 'large.bin' } : { rootPath, path: 'large.bin' };
      expect(await read(input)).toMatchObject({ success: false });
      const slice = FilesystemReadFileOutputSchema.parse(await read({ ...input, offset: 3, length: 4 }));
      expect(slice).toEqual({ success: true, content: bytes.subarray(3, 7).toString('base64'), sizeBytes: bytes.length, eof: false });
      expect(await read({ ...input, offset: bytes.length - 2, length: 4 })).toEqual({
        success: true, content: bytes.subarray(-2).toString('base64'), sizeBytes: bytes.length, eof: true,
      });
      expect(await read({ ...input, offset: bytes.length + 9, length: 4 })).toEqual({
        success: true, content: '', sizeBytes: bytes.length, eof: true,
      });
      expect(await read({ ...input, offset: 0, length: configuration.filesReadMaxBytes + 1 })).toMatchObject({ success: false });
      const atCap = FilesystemReadFileOutputSchema.parse(await read({ ...input, length: configuration.filesReadMaxBytes }));
      expect(atCap).toMatchObject({ success: true, sizeBytes: bytes.length, eof: false });
      if (!atCap.success) throw new Error(atCap.error);
      expect(Buffer.from(atCap.content, 'base64').equals(bytes.subarray(0, configuration.filesReadMaxBytes))).toBe(true);
      expect(await read({ ...input, length: 4 })).toEqual({
        success: true, content: bytes.subarray(0, 4).toString('base64'), sizeBytes: bytes.length, eof: false,
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
