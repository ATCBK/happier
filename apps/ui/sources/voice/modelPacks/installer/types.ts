import type { Directory as ExpoDirectory, File as ExpoFile } from 'expo-file-system';
import type { NativeModelPackDownload } from './nativeDownload';

export type InstallMode = 'require_installed' | 'download_if_missing';
export type UpdatePolicy = 'none' | 'manual_update_if_available';

/**
 * Minimal structural view of the Expo `File` handle the installer host uses
 * (LB-L5). Typed to the exact surface consumed so the adapter edge is not `any`.
 * Mirrors `expo-file-system`'s `File`.
 */
export type ExpoFsFile = {
  readonly uri: string;
  readonly name: string;
  readonly exists: boolean;
  /** Byte size of the file (0 when absent), used for resume offsets without reading bytes. */
  readonly size?: number;
  bytes: () => Promise<Uint8Array>;
  open(): Pick<ReturnType<ExpoFile['open']>, 'readBytes' | 'close'>;
  text: () => Promise<string>;
  copy: (destination: ExpoFsFile | { uri: string }) => void;
  /** Write content; `{ append: true }` appends without rewriting the whole file. */
  write(content: string | Uint8Array, options?: { append?: boolean }): void;
  create?: ExpoFile['create'];
  delete?: ExpoFile['delete'];
};

/** Minimal structural view of the Expo `Directory` handle. Mirrors `expo-file-system`'s `Directory`. */
export type ExpoFsDirectory = {
  uri: string;
  readonly name: string;
  readonly exists: boolean;
  create?: ExpoDirectory['create'];
  delete?: ExpoDirectory['delete'];
  move: (destination: ExpoFsDirectory | { uri: string }) => void;
  list: () => (ExpoFsDirectory | ExpoFsFile)[];
};

export type ExpoFsDirectoryCtor = new (...args: unknown[]) => ExpoFsDirectory;
export type ExpoFsFileCtor = new (...args: unknown[]) => ExpoFsFile;

export type InstallerFs = {
  Directory: ExpoFsDirectoryCtor;
  File: ExpoFsFileCtor;
  Paths: { document: unknown };
};

export type InstallerOverrides = {
  fs?: InstallerFs;
  fetch?: typeof fetch;
  /** Native artifact network/file boundary; fetch is used only for manifests. */
  download?: NativeModelPackDownload;
  /**
   * Invalidate runtime state derived from the live pack directory, awaited
   * before the bytes at that directory are replaced or deleted. Native voice
   * engines and the derived speaker count are keyed by that stable path, so a
   * replacement would otherwise keep serving the superseded pack.
   */
  invalidatePackRuntime?: InvalidatePackRuntime;
};

/** Called with the live pack directory uri whose bytes are about to change. */
export type InvalidatePackRuntime = (packDirUri: string) => Promise<void>;

export type Progress = { loaded: number; total: number };
