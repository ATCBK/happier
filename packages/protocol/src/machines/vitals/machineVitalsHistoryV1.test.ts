import { describe, expect, it } from 'vitest';

import { MachineVitalsAlertEpisodeV1StoredReadSchema, MachineVitalsHistoryV1Schema,
  MachineVitalsMinuteRecordV1Schema, MachineVitalsMinuteRecordV1StoredReadSchema } from './machineVitalsHistoryV1.js';

const minute = { t: 60_000, cpu: null, cpuMax: 84, mem: 1024, memMax: 2048,
  lvl: 'critical', swp: null, rx: null, tx: 10 };

describe('machine vitals history contracts', () => {
  it('retains missing counter readings and explicit gaps without treating them as zero', () => {
    expect(MachineVitalsHistoryV1Schema.parse({ range: '1h', bucketMs: 60_000,
      points: [null, minute], today: { rxBytes: 0, txBytes: 10 } }).points).toEqual([null, minute]);
  });

  it('drops future stored fields while rejecting them at canonical write admission', () => {
    expect(MachineVitalsMinuteRecordV1StoredReadSchema.parse({ ...minute, future: 1 })).toEqual(minute);
    expect(MachineVitalsMinuteRecordV1Schema.safeParse({ ...minute, future: 1 }).success).toBe(false);
    const alert = { kind: 'alert', rule: 'disk', volumeId: 'root', state: 'fired', at: 90_000 };
    expect(MachineVitalsAlertEpisodeV1StoredReadSchema.parse({ ...alert, future: true })).toEqual(alert);
    expect(MachineVitalsMinuteRecordV1StoredReadSchema.safeParse({ ...minute, mem: -1 }).success).toBe(false);
  });
});
