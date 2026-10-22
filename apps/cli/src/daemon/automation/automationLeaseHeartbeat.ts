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
  onHeartbeat: (onProgress: (progress: AutomationLeaseRenewalProgress) => void, renewalDeadlineAtMs: number, signal: AbortSignal) => Promise<number>;
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
  let renewalController: AbortController | null = null;
  let renewalDeadlineAtMs: number | null = null;
  const cadenceMs = Math.max(1_000, params.heartbeatMs);
  const nextHealthyRenewalAtMs = () => {
    const now = Date.now();
    const remainingMs = leaseExpiresAtMs - now;
    // Delivery and proof/HTTP latency consume the granted lease. A nearly
    // spent claim renews immediately; healthy fresh leases keep their cadence.
    return now + (remainingMs <= cadenceMs ? 0 : Math.min(cadenceMs, Math.floor(remainingMs / 2)));
  };
  let nextRenewalAtMs = nextHealthyRenewalAtMs();
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
    renewalController?.abort();
  };
  const fail = (error: unknown, event: 'expired' | 'refused' = 'refused') => {
    if (!active) return;
    observe(event);
    active = false;
    clearTimeout(timer);
    renewalController?.abort(error);
    params.onError(error);
  };
  const expire = () => fail(Object.assign(new Error('automation_claim_lease_expired'), { code: 'automation_claim_lease_expired' }), 'expired');
  const schedule = () => {
    if (!active) return;
    const remainingMs = leaseExpiresAtMs - Date.now();
    if (remainingMs <= 0) { expire(); return; }
    // One timer observes the active attempt's deadline and confirmed expiry.
    // Settlement resumes any cadence tick missed during a slow request.
    const nextBoundaryAtMs = inFlight
      ? (renewalController?.signal.aborted ? leaseExpiresAtMs : renewalDeadlineAtMs ?? leaseExpiresAtMs)
      : nextRenewalAtMs;
    const delayMs = Math.min(Math.max(0, nextBoundaryAtMs - Date.now()), remainingMs);
    scheduledAtMs = Date.now() + delayMs;
    timer = setTimeout(tick, delayMs);
  };
  const tick = () => {
    if (!active) return;
    if (Date.now() >= leaseExpiresAtMs) { expire(); return; }
    if (inFlight) {
      if (renewalDeadlineAtMs !== null && Date.now() >= renewalDeadlineAtMs) {
        renewalController?.abort(Object.assign(new Error('automation_claim_renewal_deadline_exceeded'), { code: 'ETIMEDOUT' }));
      }
      schedule();
      return;
    }
    inFlight = true;
    renewalScheduledAtMs = scheduledAtMs;
    const startedAtMs = Date.now();
    renewalStartedAtMs = startedAtMs;
    // Only failed attempts use a shorter cadence: reserve three windows in
    // the actual remaining lease (retry spacing, first attempt, next attempt),
    // retaining the existing one-second floor rather than spinning on errors.
    const retryCadenceMs = Math.min(cadenceMs, Math.max(1_000, Math.floor((leaseExpiresAtMs - renewalStartedAtMs) / 3)));
    nextRenewalAtMs = renewalStartedAtMs + retryCadenceMs;
    renewalTransport = null;
    renewalController = new AbortController();
    // Reserve half the confirmed remaining lease for a serialized second
    // attempt. Proof preparation and HTTP consume this same absolute budget.
    renewalDeadlineAtMs = renewalStartedAtMs + Math.floor((leaseExpiresAtMs - renewalStartedAtMs) / 2);
    observe('renewal_started');
    schedule();
    void params.onHeartbeat(progress => { renewalTransport = progress; }, renewalDeadlineAtMs, renewalController.signal).then(expiresAtMs => {
      if (!active) { observe('late_response'); return; }
      if (Date.now() >= leaseExpiresAtMs || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        expire();
        return;
      }
      leaseExpiresAtMs = expiresAtMs;
      observe('renewed');
      nextRenewalAtMs = Math.max(startedAtMs + 1_000, nextHealthyRenewalAtMs());
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
    }).finally(() => {
      inFlight = false;
      renewalController = null;
      renewalDeadlineAtMs = null;
      clearTimeout(timer);
      schedule();
    });
  };
  schedule();
  return { stop };
}
