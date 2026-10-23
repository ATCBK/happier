type RunnerMetadataKeys = 'hostPid' | 'hostProcessStartTimeMs' | 'lifecycleState' | 'lifecycleStateSince';

/** Retire only the observed runner tuple. Clean Stop remains a separate fact;
 * a crash removes stale running evidence without inventing a stopped state. */
export function retireSessionRunnerMetadata<T extends Record<string, unknown>>(
  metadata: T,
  expected: Readonly<{ pid: number; startTimeMs: number | undefined }>,
): T | Omit<T, RunnerMetadataKeys> {
  if (metadata.hostPid !== expected.pid || metadata.hostProcessStartTimeMs !== expected.startTimeMs) return metadata;
  const { hostPid: _pid, hostProcessStartTimeMs: _birth, ...retired } = metadata;
  if (retired.lifecycleState !== 'running') return retired;
  const { lifecycleState: _state, lifecycleStateSince: _since, ...withoutRunning } = retired;
  return withoutRunning;
}
