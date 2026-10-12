import { describe, expect, it } from 'vitest';

import type { ResolvedProcessOwnership } from '../ownership/types';
import { createLeftBehindTracker, LEFT_BEHIND_CONFIRMATION_INTERVAL_MS } from './leftBehindTracker';

const candidate = (native = 'darwin-proc:300:10:1'): ResolvedProcessOwnership => ({
    pid: 300, start: { startTimeMs: 10_000, native },
    owner: { kind: 'session', sessionId: 'ended-session' }, ownerEnded: true,
    level: 'left_behind', evidence: [{ kind: 'marker', state: 'met', reason: 'marker_matches' }], chain: [],
});

describe('left-behind confirmation', () => {
    it('offers exactly the same ended-owner identities observed twice a minute apart', () => {
        const tracker = createLeftBehindTracker();
        tracker.observe({ status: 'ok', capturedAtMs: 100, rows: [candidate()] });
        expect(tracker.confirmed()).toEqual([]);
        tracker.observe({ status: 'ok', capturedAtMs: 100 + LEFT_BEHIND_CONFIRMATION_INTERVAL_MS - 1, rows: [candidate()] });
        expect(tracker.confirmed()).toEqual([]);
        tracker.observe({ status: 'ok', capturedAtMs: 100 + LEFT_BEHIND_CONFIRMATION_INTERVAL_MS, rows: [candidate()] });
        expect(tracker.confirmed()).toMatchObject([{ pid: 300, owner: { kind: 'session', sessionId: 'ended-session' }, firstSeenAtMs: 100 }]);
        expect(tracker.confirmed()[0]?.ref).toBe(Buffer.from('300:10000:darwin-proc:300:10:1').toString('base64url'));
    });

    it('resets confirmation on native generation change, disappearance or owner resumption', () => {
        const tracker = createLeftBehindTracker();
        tracker.observe({ status: 'ok', capturedAtMs: 0, rows: [candidate()] });
        tracker.observe({ status: 'ok', capturedAtMs: 60_000, rows: [candidate('darwin-proc:300:10:2')] });
        expect(tracker.confirmed()).toEqual([]);
        tracker.observe({ status: 'ok', capturedAtMs: 120_000, rows: [candidate('darwin-proc:300:10:2')] });
        expect(tracker.confirmed()).toHaveLength(1);
        tracker.observe({ status: 'ok', capturedAtMs: 120_001, rows: [{ ...candidate('darwin-proc:300:10:2'), level: 'proven', ownerEnded: false }] });
        expect(tracker.confirmed()).toEqual([]);
        tracker.observe({ status: 'ok', capturedAtMs: 120_002, rows: [candidate()] });
        tracker.observe({ status: 'ok', capturedAtMs: 180_002, rows: [] });
        expect(tracker.confirmed()).toEqual([]);
    });

    it('does not turn an unavailable census into an empty successful observation', () => {
        const tracker = createLeftBehindTracker();
        tracker.observe({ status: 'ok', capturedAtMs: 0, rows: [candidate()] });
        tracker.observe({ status: 'unavailable', reason: 'read_failed' });
        expect(tracker.confirmed()).toEqual([]);
        tracker.observe({ status: 'ok', capturedAtMs: 60_000, rows: [candidate()] });
        expect(tracker.confirmed()).toHaveLength(1);
    });
});
