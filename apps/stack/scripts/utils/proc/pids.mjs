import { observeProcessLivenessSync } from '../../../../../packages/cli-common/processInstance.mjs';

export function observePidLiveness(pid, boundary = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return { status: 'dead', reason: 'invalid_pid' };
  return observeProcessLivenessSync(n, boundary);
}

export function isPidAlive(pid) {
  return observePidLiveness(pid).status === 'alive';
}
