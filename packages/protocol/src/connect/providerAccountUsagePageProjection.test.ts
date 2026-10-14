import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from './providerAccountUsagePrimitives.js';
import { buildProviderAccountUsagePageProjectionV1, openProviderAccountUsagePageProjectionV1, sealProviderAccountUsagePageProjectionV1, StoredProviderAccountUsagePageProjectionV1Schema } from './providerAccountUsagePageProjection.js';
import { deriveProviderAccountUsagePace, deriveProviderAccountUsageUnusedCapacity, deriveProviderAccountUsageEarlierWindowCurves, hasProviderAccountUsageWitnessedReset } from './deriveProviderAccountUsagePace.js';

const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
const sample = (at: number, used: number, reset = 1000) => ProviderAccountUsageSnapshotV1Schema.parse({
  v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test',
  accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: at, fetchedAtMs: at,
  staleAfterMs: 5000, source: 'providerHttp', confidence: 'confirmed', planLabel: 'Standard',
  subscription: { status: 'subscribed', renewal: 'on', observedAtMs: at, staleAfterMs: 5000 },
  meters: [{ meterId: 'week', label: 'Weekly', used, limit: 100, remaining: 100 - used, unit: 'requests',
    utilizationPct: used, resetsAt: reset, windowDurationMs: 1000, status: 'ok', details: {} }],
});
const history = { entries: [sample(100, 10), sample(500, 50), sample(1000, 80), sample(1100, 10, 2000)]
  .map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot })), nextCursor: null };
const range = { startAtMs: 0, endAtMs: 1200 };
const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };

describe('B page projection', () => {
  it('rejects a plain projection whose declared coverage differs from its protected observations', () => {
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: history.entries[0]!.snapshot.recordId, range, history });
    const last = history.entries.at(-1)!;
    const stored = { recordId: projection.recordId, demand: { range, resolution: projection.resolution },
      frontier: { id: last.id, observedAtMs: last.observedAtMs }, observationCount: history.entries.length,
      content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection }) };
    expect(StoredProviderAccountUsagePageProjectionV1Schema.safeParse(stored).success).toBe(true);
    for (const mismatch of [{ observationCount: 0 }, { frontier: null }, { frontier: { ...stored.frontier, id: 'other' } },
      { demand: { ...stored.demand, range: { ...range, endAtMs: range.endAtMs + 1 } } }]) {
      expect(StoredProviderAccountUsagePageProjectionV1Schema.safeParse({ ...stored, ...mismatch }).success).toBe(false);
    }
  });
  it.each(['plain', 'e2ee'] as const)('round trips every accepted fact and immutable witness in %s mode', accountMode => {
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: history.entries[0]!.snapshot.recordId, range, history });
    const content = sealProviderAccountUsagePageProjectionV1({ projection, accountMode, material,
      randomBytes: length => new Uint8Array(length).fill(9) });
    const opened = openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode, material, content });
    expect(opened).toEqual(projection);
    const snapshots = opened.history.entries.map(entry => entry.snapshot);
    expect(opened.history).toEqual(history);
    const current = snapshots.at(-1)!;
    const before = history.entries.map(entry => entry.snapshot);
    for (const values of [snapshots, before]) {
      expect(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'week', nowMs: 1100, history: values }))
        .toEqual(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'week', nowMs: 1100, history: before }));
      expect(deriveProviderAccountUsageUnusedCapacity({ history: values, nowMs: 1100 }))
        .toEqual(deriveProviderAccountUsageUnusedCapacity({ history: before, nowMs: 1100 }));
      expect(deriveProviderAccountUsageEarlierWindowCurves({ current, meterId: 'week', history: values }))
        .toEqual(deriveProviderAccountUsageEarlierWindowCurves({ current, meterId: 'week', history: before }));
      expect(hasProviderAccountUsageWitnessedReset({ previous: values[2]!, current, meterId: 'week', nowMs: 1100 })).toBe(true);
    }
    if (content.t === 'encrypted') expect(JSON.stringify(content)).not.toContain('Standard');
    expect(() => openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId,
      accountMode: accountMode === 'plain' ? 'e2ee' : 'plain', material, content })).toThrow();
  });

  it('shares repeated material without deleting interior observations or manufacturing range completeness', () => {
    const repeated = { entries: Array.from({ length: 1000 }, (_, index) => ({ id: String(index), observedAtMs: index + 1, snapshot: sample(index + 1, 20) })), nextCursor: null };
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: repeated.entries[0]!.snapshot.recordId, range, history: repeated });
    const content = sealProviderAccountUsagePageProjectionV1({ projection, accountMode: 'plain' });
    expect(JSON.stringify(content).length).toBeLessThan(JSON.stringify(repeated).length / 3);
    const opened = openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode: 'plain', content });
    expect(opened.history).toEqual(repeated);
    // A page with thousands of timestamp-only observations must not expand the
    // same admitted meter tree into thousands of retained copies.
    expect(opened.history.entries[0]!.snapshot.meters[0]).toBe(opened.history.entries[999]!.snapshot.meters[0]);
    expect(() => buildProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, range,
      history: { ...repeated, nextCursor: { id: '999', observedAtMs: 1000 } } })).toThrow();
  });
});
