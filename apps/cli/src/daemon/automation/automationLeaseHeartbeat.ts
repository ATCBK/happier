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
    void params.onHeartbeat().then(async expiresAtMs => {
      if (!active) return;
      if (Date.now() >= leaseExpiresAtMs || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        expire();
        return;
      }
      leaseExpiresAtMs = expiresAtMs;
      clearTimeout(timer);
      schedule();
      // Lease transport uncertainty is distinct from the executor's existing
      // authorization/control checks. Preserve their fail-closed boundary.
      await params.onRenewed?.().catch(fail);
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
