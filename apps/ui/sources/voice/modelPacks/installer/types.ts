export type InstallMode = 'require_installed' | 'download_if_missing';
export type UpdatePolicy = 'none' | 'manual_update_if_available';

export type InstallerFs = {
  Directory: any;
  File: any;
  Paths: { document: any };
};

export type InstallerOverrides = {
  fs?: InstallerFs;
  fetch?: typeof fetch;
};

export type Progress = { loaded: number; total: number };

/** Pack-level progress: bytes are clamped to the manifest sizes; verified files count as done. */
export type ModelPackDownloadProgress = Readonly<{ loaded: number; total: number; filesDone: number; filesTotal: number }>;

