import type { InstallerFs, ExpoFsFile } from './installer/types';

/**
 * Test-only in-memory filesystem that models a real directory tree for the
 * native model-pack installer specs. Unlike a flat uri->bytes map, it supports
 * `Directory.move` (relocating an entire subtree) and `Directory.delete`
 * (removing only that subtree), which the atomic staging -> backup -> swap
 * install flow relies on.
 *
 * Boundary mock only: it stands in for `expo-file-system`'s `Directory`/`File`
 * API. Domain installer logic is exercised for real.
 */
export type MemFs = {
  fs: { Directory: InstallerFs['Directory']; File: new (...args: unknown[]) => Omit<ExpoFsFile, 'delete' | 'open' | 'write'> & {
    delete(): void;
    open(...args: Parameters<ExpoFsFile['open']>): ReturnType<ExpoFsFile['open']>;
    write(...args: Parameters<ExpoFsFile['write']>): ReturnType<ExpoFsFile['write']>;
  }; Paths: { document: string } };
  files: Map<string, Uint8Array>;
  root: string;
};

export function createMemFs(): MemFs {
  const files = new Map<string, Uint8Array>();
  const root = 'file:///docs/happier/voice/modelPacks';

  const normalize = (uri: string): string => uri.replace(/\/+$/, '');
  const joinUri = (base: string, name: string): string => `${normalize(base)}/${name}`;

  function resolveUri(args: any[]): string {
    if (args.length === 0) return root;
    const [first, ...rest] = args;
    let base: string;
    if (first && typeof first === 'object' && typeof first.uri === 'string') {
      base = normalize(first.uri);
    } else if (typeof first === 'string') {
      base = normalize(first);
    } else {
      base = root;
    }
    for (const segment of rest) {
      base = joinUri(base, String(segment));
    }
    return base;
  }

  class Directory {
    uri: string;
    constructor(...args: any[]) {
      this.uri = resolveUri(args);
    }
    get exists(): boolean {
      const prefix = `${this.uri}/`;
      for (const key of files.keys()) {
        if (key === this.uri || key.startsWith(prefix)) return true;
      }
      return false;
    }
    get name(): string {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    create() {
      // Directories are implicit (defined by the files they contain).
    }
    delete() {
      // Expo's native bridge rejects any JS arguments for File/Directory.delete().
      if (arguments.length > 0) throw new Error('expo_delete_invalid_argument_count');
      const prefix = `${this.uri}/`;
      for (const key of Array.from(files.keys())) {
        if (key === this.uri || key.startsWith(prefix)) files.delete(key);
      }
    }
    move(destination: { uri: string }) {
      const prefix = `${this.uri}/`;
      const destUri = normalize(destination.uri);
      for (const key of Array.from(files.keys())) {
        if (key.startsWith(prefix)) {
          const suffix = key.slice(this.uri.length);
          const value = files.get(key)!;
          files.delete(key);
          files.set(`${destUri}${suffix}`, value);
        } else if (key === this.uri) {
          const value = files.get(key)!;
          files.delete(key);
          files.set(destUri, value);
        }
      }
      this.uri = destUri;
    }
    list() {
      const prefix = `${this.uri}/`;
      const children = new Map<string, boolean>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const remainder = key.slice(prefix.length);
        const [name, ...rest] = remainder.split('/');
        if (!name) continue;
        children.set(name, (children.get(name) ?? false) || rest.length > 0);
      }
      return [...children.entries()].map(([name, isDirectory]) => (
        isDirectory ? new Directory(this, name) : new File(this, name)
      ));
    }
  }

  class File {
    uri: string;
    constructor(...args: any[]) {
      this.uri = resolveUri(args);
    }
    get exists(): boolean {
      return files.has(this.uri);
    }
    get name(): string {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    get size(): number {
      return files.get(this.uri)?.byteLength ?? 0;
    }
    create() {
      if (!files.has(this.uri)) files.set(this.uri, new Uint8Array());
    }
    copy(destination: { uri: string }) {
      // Expo File.copy rejects an existing destination on both native platforms.
      if (files.has(destination.uri)) throw new Error('EEXIST_copy_destination');
      const bytes = files.get(this.uri);
      if (!bytes) throw new Error('copy_source_missing');
      files.set(destination.uri, bytes.slice());
    }
    write(data: string | Uint8Array, options?: { append?: boolean }) {
      const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      if (options?.append) {
        const prior = files.get(this.uri) ?? new Uint8Array();
        const out = new Uint8Array(prior.byteLength + buf.byteLength);
        out.set(prior, 0);
        out.set(buf, prior.byteLength);
        files.set(this.uri, out);
        return;
      }
      files.set(this.uri, new Uint8Array(buf));
    }
    writableStream() {
      const uri = this.uri;
      let acc: Uint8Array[] = [];
      return new WritableStream<Uint8Array>({
        write(chunk: Uint8Array) {
          acc.push(new Uint8Array(chunk));
        },
        close() {
          const total = acc.reduce((sum, b) => sum + b.length, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const b of acc) {
            out.set(b, off);
            off += b.length;
          }
          files.set(uri, out);
          acc = [];
        },
      });
    }
    async bytes(): Promise<Uint8Array> {
      return files.get(this.uri) ?? new Uint8Array();
    }
    open() {
      const uri = this.uri;
      let offset = 0;
      let closed = false;
      return {
        readBytes(length: number): Uint8Array<ArrayBuffer> {
          if (closed) throw new Error('file_handle_closed');
          const bytes = files.get(uri) ?? new Uint8Array();
          const chunk = bytes.slice(offset, offset + length);
          offset += chunk.byteLength;
          return chunk;
        },
        close() { closed = true; },
      };
    }
    readableStream() {
      // Expo FS 55.0.14 closes its native read handle on cancel, but not on EOF.
      const handle = this.open();
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const bytes = handle.readBytes(1024);
          if (bytes.length === 0) controller.close();
          else controller.enqueue(bytes);
        },
        cancel() { handle.close(); },
      });
    }
    async text(): Promise<string> {
      return new TextDecoder().decode(files.get(this.uri) ?? new Uint8Array());
    }
    delete() {
      if (arguments.length > 0) throw new Error('expo_delete_invalid_argument_count');
      files.delete(this.uri);
    }
    arrayBuffer(): Promise<ArrayBuffer> {
      return this.bytes().then((b) => b.buffer as ArrayBuffer);
    }
  }

  const fs = { Directory, File, Paths: { document: 'file:///docs/' } };
  return { fs, files, root };
}

/** Native network/file boundary fixture; production artifact bytes never use fetch. */
export function createMemNativeDownload(fs: InstallerFs, fetchImpl: typeof fetch) {
  return async (request: {
    url: string; fileUri: string; rangeStart?: number; signal: AbortSignal;
    onProgress?: (loaded: number) => void;
  }) => {
    const headers: Record<string, string> = {};
    if (request.rangeStart) headers.Range = `bytes=${request.rangeStart}-`;
    const response = await fetchImpl(request.url, { signal: request.signal, headers });
    if (!response.ok) throw new Error(`model_pack_download_failed:${response.status}`);
    const file = new fs.File(request.fileUri);
    file.create?.();
    let loaded = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          file.write(value, { append: true });
          loaded += value.byteLength;
          request.onProgress?.(loaded);
        }
      } finally {
        try { await reader.cancel?.(); } finally { reader.releaseLock?.(); }
      }
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      file.write(bytes);
      loaded = bytes.byteLength;
      request.onProgress?.(loaded);
    }
    return { status: response.status, headers: { 'content-length': String(loaded) } };
  };
}
