import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';
import type { AutomationLeaseRenewalProgress } from './automationClaimClient';

export type AutomationLeaseObservation = Readonly<{
  event: 'renewal_started' | 'renewed' | 'transient_failure' | 'refused' | 'expired' | 'stopped' | 'late_response';
  observedAtMs: number;
  scheduledAtMs: number;
  leaseExpiresAtMs: number;
  renewalStartedAtMs: number | null;
  renewalScheduledAtMs: number | null;
  renewalTransport: AutomationLeaseRenewalProgress | null;
  renewalInFlight: boolean;
  currentnessInFlight: boolean;
}>;

export function startAutomationLeaseHeartbeat(params: {
  heartbeatMs: number;
  leaseExpiresAtMs: number;
  onHeartbeat: (onProgress: (progress: AutomationLeaseRenewalProgress) => void) => Promise<number>;
  onRenewed?: () => Promise<void>;
  onError: (error: unknown) => void;
  onTransientError?: (error: unknown) => void;
  onObservation?: (observation: AutomationLeaseObservation) => void;
}): { stop: () => void } {
  let active = true;
  let leaseExpiresAtMs = params.leaseExpiresAtMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let currentnessInFlight = false;
  let scheduledAtMs = Date.now();
  let renewalStartedAtMs: number | null = null;
  let renewalScheduledAtMs: number | null = null;
  let renewalTransport: AutomationLeaseRenewalProgress | null = null;
  const observe = (event: AutomationLeaseObservation['event']) => {
    try {
      params.onObservation?.({ event, observedAtMs: Date.now(), scheduledAtMs, leaseExpiresAtMs,
        renewalStartedAtMs, renewalScheduledAtMs, renewalTransport, renewalInFlight: inFlight, currentnessInFlight });
    } catch { /* Local diagnostics cannot change claim ownership. */ }
  };
  const stop = () => {
    if (!active) return;
    observe('stopped');
    active = false;
    clearTimeout(timer);
  };
  const fail = (error: unknown, event: 'expired' | 'refused' = 'refused') => {
    if (!active) return;
    observe(event);
    active = false;
    clearTimeout(timer);
    params.onError(error);
  };
  const expire = () => fail(Object.assign(new Error('automation_claim_lease_expired'), { code: 'automation_claim_lease_expired' }), 'expired');
  const schedule = () => {
    if (!active) return;
    const remainingMs = leaseExpiresAtMs - Date.now();
    if (remainingMs <= 0) { expire(); return; }
    // One existing cadence timer also observes the lease boundary while its
    // transport request is pending. A lost response never extends that lease.
    const delayMs = Math.min(Math.max(1_000, params.heartbeatMs), remainingMs);
    scheduledAtMs = Date.now() + delayMs;
    timer = setTimeout(tick, delayMs);
  };
  const tick = () => {
    if (!active) return;
    if (Date.now() >= leaseExpiresAtMs) { expire(); return; }
    if (inFlight) { schedule(); return; }
    inFlight = true;
    renewalScheduledAtMs = scheduledAtMs;
    renewalStartedAtMs = Date.now();
    renewalTransport = null;
    observe('renewal_started');
    schedule();
    void params.onHeartbeat(progress => { renewalTransport = progress; }).then(expiresAtMs => {
      if (!active) { observe('late_response'); return; }
      if (Date.now() >= leaseExpiresAtMs || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        expire();
        return;
      }
      leaseExpiresAtMs = expiresAtMs;
      observe('renewed');
      clearTimeout(timer);
      schedule();
      // Authorization/control reads can outlive this lease. Keep them serialized
      // without holding up its transport renewal; their failure still retires it.
      if (params.onRenewed && !currentnessInFlight) {
        currentnessInFlight = true;
        void Promise.resolve().then(() => active ? params.onRenewed?.() : undefined)
          .catch((error: unknown) => fail(error)).finally(() => { currentnessInFlight = false; });
      }
    }).catch((error: unknown) => {
      if (!active) { observe('late_response'); return; }
      const { kind } = classifyDaemonServerWorkError(error);
      if (kind === 'network' || kind === 'timeout' || kind === 'server_error'
        || kind === 'dependency_unavailable' || kind === 'rate_limited') {
        observe('transient_failure');
        params.onTransientError?.(error);
      } else {
        fail(error);
      }
    }).finally(() => { inFlight = false; });
  };
  schedule();
  return { stop };
}
