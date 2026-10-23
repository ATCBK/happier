import { isPidAlive } from '../proc/pids.mjs';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeRuntimePid(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && n > 1 ? n : null;
}

export function normalizeProcessInstanceRecord(value, pid) {
  const normalizedPid = normalizeRuntimePid(pid);
  const recordPid = normalizeRuntimePid(value?.pid);
  const fingerprint = String(value?.fingerprint ?? '').trim();
  return normalizedPid && recordPid === normalizedPid && fingerprint
    ? { pid: normalizedPid, fingerprint }
    : null;
}

// This source-only projection is also consumed before dependencies exist.
// Keep process inventory independent of the lifecycle/termination adapters.
export function readStackRuntimeProcessMembership(runtimeState) {
  const processes = { ...(isPlainObject(runtimeState?.processes) ? runtimeState.processes : {}) };
  // Target service state belongs to the remote host, but its SSH forward is a
  // controller-local child and must survive in stop custody until it is retired.
  for (const [targetName, state] of Object.entries(isPlainObject(runtimeState?.remoteTargets) ? runtimeState.remoteTargets : {})) {
    processes[`remoteTargets.${targetName}.forwardPid`] = state?.forwardPid ?? null;
  }
  return processes;
}

export function getStackRuntimeProcessInstanceFingerprint(runtimeState, key, pid) {
  const normalizedPid = normalizeRuntimePid(pid);
  if (!normalizedPid) return null;
  if (key === 'ownerPid') {
    return normalizeProcessInstanceRecord(runtimeState?.processInstances?.owner, normalizedPid)?.fingerprint ?? null;
  }
  const value = runtimeState?.processInstances?.processes?.[key];
  if (Array.isArray(value)) {
    return value
      .map((record) => normalizeProcessInstanceRecord(record, normalizedPid))
      .find(Boolean)?.fingerprint ?? null;
  }
  return normalizeProcessInstanceRecord(value, normalizedPid)?.fingerprint ?? null;
}

export function getStackRuntimeProcessEntries(runtimeState) {
  const processes = readStackRuntimeProcessMembership(runtimeState);
  const entries = [];
  for (const [rawKey, value] of Object.entries(processes)) {
    const key = String(rawKey);
    if (/Pid$/.test(key)) {
      const pid = Number(value);
      if (Number.isFinite(pid) && pid > 1) {
        const processInstanceFingerprint = getStackRuntimeProcessInstanceFingerprint(runtimeState, key, pid);
        entries.push({ key, pid, ...(processInstanceFingerprint ? { processInstanceFingerprint } : {}) });
      }
      continue;
    }
    if (/Pids$/.test(key) && Array.isArray(value)) {
      const seen = new Set();
      for (const entry of value) {
        const pid = Number(entry);
        if (!Number.isFinite(pid) || pid <= 1 || seen.has(pid)) continue;
        seen.add(pid);
        const processInstanceFingerprint = getStackRuntimeProcessInstanceFingerprint(runtimeState, key, pid);
        entries.push({ key, pid, ...(processInstanceFingerprint ? { processInstanceFingerprint } : {}) });
      }
    }
  }
  return entries;
}

export function hasLiveStackRuntimeProcesses(runtimeState, { isPidAliveImpl = isPidAlive } = {}) {
  return getStackRuntimeProcessEntries(runtimeState).some(({ pid }) => isPidAliveImpl(pid));
}
