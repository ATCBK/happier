/** The additional model bytes do not fit in the filesystem's reported free space. */
export class ModelPackInsufficientDiskSpaceError extends Error {
  constructor(readonly requiredBytes: number, readonly availableBytes: number) {
    super('model_pack_insufficient_disk_space');
    this.name = 'ModelPackInsufficientDiskSpaceError';
  }
}

/** A different observer cancelled the shared install, including its native cleanup. */
export class ModelPackInstallCancelledError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}
