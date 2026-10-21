import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';

export function startAutomationLeaseHeartbeat(params: {
  heartbeatMs: number;
  leaseExpiresAtMs: number;
  onHeartbeat: () => Promise<number>;
  onRenewed?: () => Promise<void>;
  onError: (error: unknown) => void;
  onTransientError?: (error: unknown) => void;
}): { stop: () => void } {
  let active = true;
  let leaseExpiresAtMs = params.leaseExpiresAtMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let currentnessInFlight = false;
  const stop = () => {
    active = false;
    clearTimeout(timer);
  };
  const fail = (error: unknown) => {
    if (!active) return;
    stop();
    params.onError(error);
  };
  const expire = () => fail(Object.assign(new Error('automation_claim_lease_expired'), { code: 'automation_claim_lease_expired' }));
  const schedule = () => {
    if (!active) return;
    const remainingMs = leaseExpiresAtMs - Date.now();
    if (remainingMs <= 0) { expire(); return; }
    // One existing cadence timer also observes the lease boundary while its
    // transport request is pending. A lost response never extends that lease.
    timer = setTimeout(tick, Math.min(Math.max(1_000, params.heartbeatMs), remainingMs));
  };
  const tick = () => {
    if (!active) return;
    if (Date.now() >= leaseExpiresAtMs) { expire(); return; }
    schedule();
    if (inFlight) return;
    inFlight = true;
    void params.onHeartbeat().then(expiresAtMs => {
      if (!active) return;
      if (Date.now() >= leaseExpiresAtMs || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        expire();
        return;
      }
      leaseExpiresAtMs = expiresAtMs;
      clearTimeout(timer);
      schedule();
      // Authorization/control reads can outlive this lease. Keep them serialized
      // without holding up its transport renewal; their failure still retires it.
      if (params.onRenewed && !currentnessInFlight) {
        currentnessInFlight = true;
        void Promise.resolve().then(() => active ? params.onRenewed?.() : undefined)
          .catch(fail).finally(() => { currentnessInFlight = false; });
      }
    }).catch((error: unknown) => {
      if (!active) return;
      const { kind } = classifyDaemonServerWorkError(error);
      if (kind === 'network' || kind === 'timeout' || kind === 'server_error'
        || kind === 'dependency_unavailable' || kind === 'rate_limited') {
        params.onTransientError?.(error);
      } else {
        fail(error);
      }
    }).finally(() => { inFlight = false; });
  };
  schedule();
  return { stop };
}
