type RunnerProcessKeys = 'hostPid' | 'hostProcessStartTimeMs';
type RunnerMetadataKeys = RunnerProcessKeys | 'lifecycleState' | 'lifecycleStateSince';

/** Retire only the observed runner tuple. Clean Stop remains a separate fact;
 * a crash removes stale running evidence without inventing a stopped state. */
export function retireSessionRunnerMetadata<T extends Record<string, unknown>>(
  metadata: T,
  expected: Readonly<{ pid: number; startTimeMs: number | undefined }>,
): T | Omit<T, RunnerProcessKeys> | Omit<T, RunnerMetadataKeys> {
  if (metadata.hostPid !== expected.pid || metadata.hostProcessStartTimeMs !== expected.startTimeMs) return metadata;
  if (metadata.lifecycleState !== 'running') {
    const { hostPid: _pid, hostProcessStartTimeMs: _birth, ...retired } = metadata;
    return retired;
  }
  const { hostPid: _pid, hostProcessStartTimeMs: _birth, lifecycleState: _state, lifecycleStateSince: _since, ...withoutRunning } = metadata;
  return withoutRunning;
}
