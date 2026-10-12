import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineVitalsAlertTransitionV1 } from '@happier-dev/protocol/machines/vitals/evaluateMachineVitalsAlertsV1';
import { createMachineResourcesPolicyRuntime } from '../../resources/machineResourcesPolicy';
import { createMachineVitalsSampler } from '../createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../history/minuteHistoryStore';
import type { MachineVitalsReader } from '../readers/types';
import { createMachineVitalsAlerts } from './machineVitalsAlerts';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('machine vitals alert lifecycle', () => {
  it('persists transitions before delivery, restores without duplicate fire, applies metadata changes, and retires demand-free', async () => {
    vi.useFakeTimers();
    const initialTime = Date.UTC(2026, 9, 10);
    vi.setSystemTime(initialTime);
    const directory = await mkdtemp(join(tmpdir(), 'happier-alert-history-'));
    roots.push(directory);
    let pressure: 'calm' | 'critical' = 'critical';
    // Native reader is the OS boundary. All sampling, policy and history logic remains real.
    const reader: MachineVitalsReader = { read: async input => ({ state: 'reporting',
      host: { logicalCores: 4, memoryTotalBytes: 1000, bootedAt: initialTime - 1000 },
      sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs,
        cpu: { reported: true, busyPct: 10 }, memory: { reported: true, totalBytes: 1000,
          usedBytes: 900, availableBytes: 100, pressure: { level: pressure, source: 'events' } },
        disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
      minuteCounters: { monotonicMs: input.monotonicMs, cpu: { busy: input.monotonicMs / 10, total: input.monotonicMs }, network: null },
    }) };
    let enabled = true;
    const policy = createMachineResourcesPolicyRuntime({ port: {
      read: async () => ({ status: 'ready', metadataVersion: 1, metadata: { resourcesPolicyV1: { v: 1,
        alerts: { memory: { enabled, sustainMs: 60_000 } } } } }),
      compareAndSwap: async () => ({ status: 'unavailable' }),
    } });
    await policy.reload();
    let history = await createMinuteHistoryStore({ directory });
    let sampler = createMachineVitalsSampler({ readers: reader, historyStore: history, monotonicMs: () => Date.now() - initialTime });
    const deliveries: MachineVitalsAlertTransitionV1[] = [];
    // Notification delivery is an outward boundary; verify its durable precondition.
    const notify = async (transition: MachineVitalsAlertTransitionV1) => {
      expect(history.alerts()).toContainEqual(transition.episode);
      deliveries.push(transition);
    };
    let alerts = createMachineVitalsAlerts({ sampler, historyStore: history, policy, notify });
    await sampler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await sampler.start();
    await alerts.stop();
    await sampler.stop();
    expect(deliveries.map(value => value.episode.state)).toEqual(['fired']);
    history = await createMinuteHistoryStore({ directory });
    sampler = createMachineVitalsSampler({ readers: reader, historyStore: history, monotonicMs: () => Date.now() - initialTime });
    alerts = createMachineVitalsAlerts({ sampler, historyStore: history, policy, notify });
    await sampler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await sampler.start();
    expect(deliveries).toHaveLength(1);
    pressure = 'calm';
    await vi.advanceTimersByTimeAsync(60_000);
    await sampler.start();
    await alerts.stop();
    expect(deliveries.map(value => value.episode.state)).toEqual(['fired', 'recovered']);
    enabled = false;
    await policy.reload();
    alerts = createMachineVitalsAlerts({ sampler, historyStore: history, policy, notify });
    pressure = 'critical';
    await vi.advanceTimersByTimeAsync(60_000);
    await sampler.start();
    await alerts.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await sampler.stop();
    expect(deliveries).toHaveLength(2);
    expect(sampler.latest()?.intervalMs).toBe(60_000);
    expect(history.alerts().map(value => value.state)).toEqual(['fired', 'recovered']);
    policy.stop();
  });
});
