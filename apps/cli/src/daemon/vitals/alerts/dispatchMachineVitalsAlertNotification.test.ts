import { describe, expect, it } from 'vitest';
import type { MachineVitalsAlertTransitionV1 } from '@happier-dev/protocol/machines/vitals/evaluateMachineVitalsAlertsV1';
import { MachineVitalsSampleV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { notificationSettingsFixture } from '@/notifications/activity/activityNotification.testkit';
import { buildMachineVitalsAlertNotificationV1, dispatchMachineVitalsAlertNotificationAsync, readMachineVitalsWorkingSessionCount } from './dispatchMachineVitalsAlertNotification';
import type { LiveWorkInventoryV1 } from '@/daemon/lifecycle/managedActivity';

describe('machine alert working-session count', () => {
  const session = { id: 'session' };
  const item = (category: 'session' | 'agents', state: 'active' | 'settled' | 'unknown', ownerRef: unknown, activeCount?: number)
    : LiveWorkInventoryV1['items'][number] => ({ category, state, ownerRef, attribution: { kind: 'unknown' }, activeCount });
  it('counts a background-agent Session once, and keeps distinct canonical Session references distinct', () => {
    expect(readMachineVitalsWorkingSessionCount({ coverage: 'complete', items: [
      item('session', 'settled', session), item('agents', 'active', session, 5),
    ] })).toBe(1);
    expect(readMachineVitalsWorkingSessionCount({ coverage: 'complete', items: [
      item('session', 'active', session), item('agents', 'active', session, 5),
      item('agents', 'active', { id: 'session' }, 2),
    ] })).toBe(2);
  });
  it('does not report a partial or unknown count as zero', () => {
    expect(readMachineVitalsWorkingSessionCount({ coverage: 'unknown', items: [] })).toBeUndefined();
    for (const category of ['session', 'agents'] as const) {
      expect(readMachineVitalsWorkingSessionCount({ coverage: 'complete', items: [item(category, 'unknown', session)] })).toBeUndefined();
      expect(readMachineVitalsWorkingSessionCount({ coverage: 'complete', items: [item(category, 'active', null)] })).toBeUndefined();
    }
    expect(readMachineVitalsWorkingSessionCount({ coverage: 'complete', items: [
      item('session', 'settled', session), item('agents', 'settled', session),
    ] })).toBe(0);
  });
});

describe('machine vitals notification producer', () => {
  const transition: MachineVitalsAlertTransitionV1 = { episode: { kind: 'alert', rule: 'disk', volumeId: 'data', state: 'fired', at: 60_000 },
    since: 0, evidence: { freeBytes: 10, totalBytes: 100, threshold: { freeFraction: 0.2 } } };
  const latest = MachineVitalsSampleV1Schema.parse({ v: 1, sampledAt: 60_000, intervalMs: 5000,
    cpu: { reported: false, reason: 'unavailable' }, memory: { reported: false, reason: 'unavailable' },
    disk: { reported: true, volumes: [{ id: 'data', label: 'Data', mount: '/private/path', totalBytes: 100, availableBytes: 10 }] },
    network: { reported: false, reason: 'unavailable' } });

  it('preserves evaluator evidence and captured volume label without claiming unknown working-session count', async () => {
    const notice = buildMachineVitalsAlertNotificationV1({ transition, latest, machineId: 'producer-disk', guardEnabled: true });
    expect(notice).toMatchObject({ topic: 'resource_limit', kind: 'disk_nearly_full', phase: 'started', volumeId: 'data', volumeLabel: 'Data',
      at: 60_000, since: 0, evidence: transition.evidence });
    expect(notice).not.toHaveProperty('workingSessionCount');
    expect(JSON.stringify(notice)).not.toContain('/private/path');
    const deliveries: unknown[][] = [];
    await expect(dispatchMachineVitalsAlertNotificationAsync({ transition, latest, machineId: 'producer-disk', guardEnabled: true,
      settings: notificationSettingsFixture({}), pluginNotifications: null,
      notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [
        NotificationChannelRecordV1Schema.parse({ v: 1, id: 'producer-push', kind: 'expo_push', topics: { machines: true } }),
      ] },
      expoPushSender: { sendToAllDevicesAsync: async (...args: unknown[]) => { deliveries.push(args); return true; } },
    })).resolves.toMatchObject({ deliveredChannels: 1 });
    expect(deliveries[0]![2]).toMatchObject({ nextSteps: ['free_up_space'], machineVitals: notice });
    expect(deliveries[0]![1]).not.toMatch(/0 sessions/);
  });

  it('adds known swap capacity to memory evidence and refuses rule/evidence mismatch before dispatch', () => {
    const memory = MachineVitalsSampleV1Schema.parse({ ...latest, memory: { reported: true, totalBytes: 100, availableBytes: 20, usedBytes: 80,
      pressure: { level: 'calm', source: 'kernel_level' }, swap: { kind: 'swap', usedBytes: 10, totalBytes: 50, swapping: false } } });
    const recovered: MachineVitalsAlertTransitionV1 = { episode: { kind: 'alert', rule: 'memory', state: 'recovered', at: 120_000 },
      since: 0, evidence: { level: 'critical', sustainMs: 120_000, swapUsedBytes: 10 } };
    expect(buildMachineVitalsAlertNotificationV1({ transition: recovered, latest: memory, machineId: 'memory-1', guardEnabled: false,
      workingSessionCount: 2 })).toMatchObject({ kind: 'memory_pressure', phase: 'recovered', workingSessionCount: 2,
      evidence: { level: 'critical', sustainMs: 120_000, swapUsedBytes: 10, swapTotalBytes: 50 } });
    expect(() => buildMachineVitalsAlertNotificationV1({ transition: { ...transition, evidence: recovered.evidence }, latest,
      machineId: 'bad-evidence', guardEnabled: false })).toThrow();
  });
});
