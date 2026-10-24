import { describe, expect, it } from 'vitest';
import type { MachineVitalsAlertsPolicyV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsAlertsV1';

import {
  describeMachineAlertsRow,
  formatAlertSustain,
  formatDiskThreshold,
  parseCustomCpuPercent,
  parseCustomDiskThreshold,
  parseCustomSustainMinutes,
} from './machineAlertsPresentation';

const off: MachineVitalsAlertsPolicyV1 = {
  memory: { enabled: false, level: 'critical', sustainMs: 300_000 },
  cpu: { enabled: false, abovePct: 90, sustainMs: 900_000 },
  disk: { enabled: false, threshold: { freeFraction: 0.1 } },
};

describe('custom alert values (R43: the full meaningful range, bounded by units only)', () => {
  it('takes any whole minute from one minute up to the week the evaluator can read', () => {
    expect(parseCustomSustainMinutes('7')).toBeNull();
    expect(parseCustomSustainMinutes('7 min')).toBe(7);
    expect(parseCustomSustainMinutes(' 45 min ')).toBe(45);
    expect(parseCustomSustainMinutes('7 d')).toBe(10_080);
    expect(parseCustomSustainMinutes('10081 min')).toBeNull();
    expect(parseCustomSustainMinutes('0 min')).toBeNull();
    expect(parseCustomSustainMinutes('2.5 min')).toBeNull();
    expect(parseCustomSustainMinutes('1.5 h')).toBe(90);
  });

  it('takes a CPU line between 1 and 100 percent', () => {
    expect(parseCustomCpuPercent('97')).toBe(97);
    expect(parseCustomCpuPercent('62.5%')).toBe(62.5);
    expect(parseCustomCpuPercent('0')).toBeNull();
    expect(parseCustomCpuPercent('101')).toBeNull();
  });

  it('reads the disk line as a share or as an amount that fits on the largest volume', () => {
    expect(parseCustomDiskThreshold('15%', null)).toEqual({
      freeFraction: 0.15,
    });
    expect(parseCustomDiskThreshold('12,5', null)).toEqual({
      freeFraction: 0.125,
    });
    expect(parseCustomDiskThreshold('30 GB', 1e12)).toEqual({
      freeBytes: 30e9,
    });
    expect(parseCustomDiskThreshold('1.5 TB', 1e12)).toBeNull();
    expect(parseCustomDiskThreshold('1.5 TB', null)).toEqual({
      freeBytes: 1.5e12,
    });
    expect(parseCustomDiskThreshold('0 GB', null)).toBeNull();
    expect(parseCustomDiskThreshold('lots', null)).toBeNull();
    expect(parseCustomDiskThreshold('1 B', null)).toEqual({ freeBytes: 1 });
    expect(parseCustomDiskThreshold('2 PB', null)).toEqual({ freeBytes: 2e15 });
    expect(parseCustomDiskThreshold('10 PB', null)).toBeNull();
  });
});

describe('alert figures and the Alerts row', () => {
  it('says a sustain in the largest whole unit and the disk line as it was stored', () => {
    expect(formatAlertSustain(300_000)).toContain('5');
    expect(formatAlertSustain(2 * 86_400_000)).toContain('2');
    expect(formatDiskThreshold({ freeFraction: 0.1 })).toContain('10');
    expect(formatDiskThreshold({ freeBytes: 20e9 })).toBe('20 GB');
  });

  it('describes one rule that is on in full, several by name, and a recipient’s row by who sets them', () => {
    const machineName = 'nl2';
    const allOff = describeMachineAlertsRow({
      machineName,
      alerts: off,
      readOnlyReason: null,
    });
    const diskOn = describeMachineAlertsRow({
      machineName,
      alerts: { ...off, disk: { ...off.disk, enabled: true } },
      readOnlyReason: null,
    });
    const two = describeMachineAlertsRow({
      machineName,
      alerts: {
        ...off,
        disk: { ...off.disk, enabled: true },
        memory: { ...off.memory, enabled: true },
      },
      readOnlyReason: null,
    });
    const recipient = describeMachineAlertsRow({
      machineName,
      alerts: off,
      readOnlyReason: 'not_custodian',
    });
    expect(new Set([allOff, diskOn, two, recipient]).size).toBe(4);
    expect(diskOn).toContain('10');
    expect(two).not.toContain('10');
  });
});
