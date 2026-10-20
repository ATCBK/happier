import { describe, expect, it } from 'vitest';
import { MachineVitalsAlertsPolicyV1Schema } from './machineVitalsAlertsV1.js';
import type { MachineVitalsAlertEpisodeV1, MachineVitalsMinuteRecordV1 } from './machineVitalsHistoryV1.js';
import { evaluateMachineVitalsAlertsV1 } from './evaluateMachineVitalsAlertsV1.js';

const minute = (n: number, patch: Partial<MachineVitalsMinuteRecordV1> = {}): MachineVitalsMinuteRecordV1 => ({
  t: n * 60_000, cpu: 95, cpuMax: 100, mem: 900, memMax: 900, lvl: 'critical', swp: null, rx: null, tx: null, ...patch,
});
const policy = MachineVitalsAlertsPolicyV1Schema.parse({ memory: { enabled: true, sustainMs: 120_000 },
  cpu: { enabled: true, sustainMs: 120_000 }, disk: { enabled: true } });
const fired: MachineVitalsAlertEpisodeV1 = { kind: 'alert', rule: 'memory', state: 'fired', at: 120_000 };

describe('machine vitals alert evaluation', () => {
  it.each([{ freeFraction: 0 }, { freeBytes: 0 }])('uses the shared full-disk decision even with threshold %j', (threshold) => {
    const diskPolicy = MachineVitalsAlertsPolicyV1Schema.parse({ disk: { enabled: true, threshold } });
    const input = { policy: diskPolicy, records: [], episodes: [], now: 60_000,
      disk: { reported: true as const, volumes: [{ id: 'a', label: 'A', mount: '/a', totalBytes: 1000,
        availableBytes: 900, inodesExhausted: true }] } };
    const started = evaluateMachineVitalsAlertsV1(input);
    expect(started.map(value => value.episode)).toEqual([
      { kind: 'alert', rule: 'disk', volumeId: 'a', state: 'fired', at: 60_000 },
    ]);
    const episodes = started.map(value => value.episode);
    expect(evaluateMachineVitalsAlertsV1({ ...input, episodes, now: 120_000 })).toEqual([]);
    expect(evaluateMachineVitalsAlertsV1({ ...input, episodes, now: 180_000,
      disk: { ...input.disk, volumes: [{ ...input.disk.volumes[0], inodesExhausted: false }] } })
      .map(value => value.episode.state)).toEqual(['recovered']);
    expect(evaluateMachineVitalsAlertsV1({ ...input,
      disk: { ...input.disk, volumes: [{ ...input.disk.volumes[0], availableBytes: 0, inodesExhausted: false }] } })
      .map(value => value.episode.state)).toEqual(['fired']);
  });

  it('fires once after covered minute means, never CPU maxima or broken coverage', () => {
    const input = { policy, episodes: [], now: 120_000, records: [minute(1), minute(2)] };
    const transitions = evaluateMachineVitalsAlertsV1(input);
    expect(transitions.map(value => value.episode)).toEqual([
      fired, { kind: 'alert', rule: 'cpu', state: 'fired', at: 120_000 },
    ]);
    expect(evaluateMachineVitalsAlertsV1({ ...input, episodes: transitions.map(value => value.episode) })).toEqual([]);
    expect(evaluateMachineVitalsAlertsV1({ ...input, records: [minute(2)] })).toEqual([]);
    expect(evaluateMachineVitalsAlertsV1({ ...input, records: [minute(1, { cpu: 20 }), minute(2, { cpu: 20 })] })
      .map(value => value.episode.rule)).toEqual(['memory']);
    expect(evaluateMachineVitalsAlertsV1({ ...input, records: [minute(1), minute(2), minute(3, { lvl: 'calm', cpu: 20 })] })
      .map(value => value.episode.rule)).toEqual(['memory', 'cpu']);
  });

  it('requires observed false minutes for recovery, and can fire a new episode afterwards', () => {
    const input = { policy, episodes: [fired], now: 240_000 };
    expect(evaluateMachineVitalsAlertsV1({ ...input, records: [minute(3, { lvl: 'calm' }), minute(4, { lvl: 'not_reported', cpu: null })] })).toEqual([]);
    const recovered = evaluateMachineVitalsAlertsV1({ ...input, records: [minute(3, { lvl: 'calm', cpu: null }), minute(4, { lvl: 'calm', cpu: null })] });
    expect(recovered.map(value => value.episode)).toEqual([{ ...fired, state: 'recovered', at: 240_000 }]);
    expect(evaluateMachineVitalsAlertsV1({ policy, episodes: [fired, ...recovered.map(value => value.episode)], now: 360_000,
      records: [minute(5), minute(6)] }).map(value => value.episode.state)).toEqual(['fired', 'fired']);
  });

  it('keeps disk episodes independent per volume and never recovers unobserved volumes', () => {
    const disk = { reported: true as const, volumes: [
      { id: 'a', label: 'A', mount: '/a', totalBytes: 1000, availableBytes: 50 },
      { id: 'b', label: 'B', mount: '/b', totalBytes: 1000, availableBytes: 100 },
    ] };
    const input = { policy, records: [minute(1)], episodes: [], now: 60_000, disk };
    const transitions = evaluateMachineVitalsAlertsV1(input);
    expect(transitions.map(value => value.episode)).toEqual([{ kind: 'alert', rule: 'disk', volumeId: 'a', state: 'fired', at: 60_000 }]);
    expect(evaluateMachineVitalsAlertsV1({ ...input, episodes: transitions.map(value => value.episode), disk: { reported: false, reason: 'unavailable' } })).toEqual([]);
    expect(evaluateMachineVitalsAlertsV1({ ...input, episodes: transitions.map(value => value.episode), now: 120_000,
      disk: { ...disk, volumes: disk.volumes.map(volume => ({ ...volume, availableBytes: volume.id === 'a' ? 100 : 50 })) } })
      .map(value => value.episode)).toEqual([
        { kind: 'alert', rule: 'disk', volumeId: 'a', state: 'recovered', at: 120_000 },
        { kind: 'alert', rule: 'disk', volumeId: 'b', state: 'fired', at: 120_000 },
      ]);
  });

  it('honors custom plain-number thresholds, chosen memory level, and disabled rules', () => {
    const custom = MachineVitalsAlertsPolicyV1Schema.parse({ memory: { enabled: true, level: 'elevated', sustainMs: 60_000 },
      cpu: { enabled: true, abovePct: 42.5, sustainMs: 60_000 }, disk: { enabled: true, threshold: { freeBytes: 123 } } });
    expect(evaluateMachineVitalsAlertsV1({ policy: custom, records: [minute(1, { lvl: 'elevated', cpu: 42.6 })], now: 60_000, episodes: [],
      disk: { reported: true, volumes: [{ id: 'a', label: 'A', mount: '/a', totalBytes: 1000, availableBytes: 122 }] } })
      .map(value => value.episode.rule)).toEqual(['memory', 'cpu', 'disk']);
    expect(evaluateMachineVitalsAlertsV1({ policy: MachineVitalsAlertsPolicyV1Schema.parse({}), records: [minute(1)], now: 60_000, episodes: [fired] })).toEqual([]);
  });
});
