import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAutomationLeaseHeartbeat } from './automationLeaseHeartbeat';

afterEach(() => vi.useRealTimers());

describe('Automation claim lease observation', () => {
  it('identifies a delayed renewal and its late response without reviving the expired claim', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let acknowledge!: (expiry: number) => void;
    const response = new Promise<number>(resolve => { acknowledge = resolve; });
    const onObservation = vi.fn();
    const onError = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 3_000,
      onHeartbeat: () => response, onError, onObservation });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onObservation.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ event: 'renewal_started', observedAtMs: 1_000, scheduledAtMs: 1_000,
        leaseExpiresAtMs: 3_000, renewalStartedAtMs: 1_000 }),
      expect.objectContaining({ event: 'expired', observedAtMs: 3_000, renewalStartedAtMs: 1_000,
        renewalInFlight: true, currentnessInFlight: false }),
    ]);
    acknowledge(30_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onObservation).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'late_response',
      observedAtMs: 3_000, renewalStartedAtMs: 1_000, leaseExpiresAtMs: 3_000 }));
    expect(onError).toHaveBeenCalledOnce();
    heartbeat.stop();
  });

  it('renews the confirmed lease while a currentness read is pending without overlapping those reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let rejectCurrentness!: (error: Error) => void;
    const currentness = new Promise<void>((_resolve, reject) => { rejectCurrentness = reject; });
    const onRenewed = vi.fn(() => currentness);
    const onHeartbeat = vi.fn(async () => Date.now() + 3_000);
    const onError = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 3_000,
      onHeartbeat, onRenewed, onError });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onError).not.toHaveBeenCalled();
      expect(onHeartbeat).toHaveBeenCalledTimes(10);
      expect(onRenewed).toHaveBeenCalledOnce();
      const refusal = new Error('authorization_not_current');
      rejectCurrentness(refusal);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onError).toHaveBeenCalledExactlyOnceWith(refusal);
      expect(onHeartbeat).toHaveBeenCalledTimes(10);
    } finally { heartbeat.stop(); }
  });

  it('keeps a claim after a transient heartbeat failure and renews only from server expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onError = vi.fn();
    const onHeartbeat = vi.fn(async () => Date.now() + 5_000)
      .mockRejectedValueOnce(Object.assign(new Error('lost response'), { code: 'ECONNABORTED' }));
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 3_000, onHeartbeat, onError });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onHeartbeat).toHaveBeenCalledTimes(3);
      expect(onError).not.toHaveBeenCalled();
    } finally { heartbeat.stop(); }
  });

  it.each([401, 403, 404, 409])('ends claim observation on authoritative heartbeat refusal (%s)', async status => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const refusal = { response: { status } };
    const onError = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 30_000,
      onHeartbeat: async () => { throw refusal; }, onError });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(refusal);
    heartbeat.stop();
  });

  it.each(['transport_failure', 'pending_response'] as const)('ends observation at the last confirmed lease expiry (%s)', async scenario => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let acknowledge = (_expiry: number) => {};
    const response = new Promise<number>(resolve => { acknowledge = resolve; });
    const onError = vi.fn();
    const onHeartbeat = vi.fn(async () => {
      if (scenario === 'pending_response') return await response;
      throw Object.assign(new Error('lost response'), { code: 'ECONNABORTED' });
    });
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 2_500, onHeartbeat, onError });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledOnce();
    acknowledge(30_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledOnce();
    if (scenario === 'pending_response') expect(onHeartbeat).toHaveBeenCalledOnce();
    heartbeat.stop();
  });
});
