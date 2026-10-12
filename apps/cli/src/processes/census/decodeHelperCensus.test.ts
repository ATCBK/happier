import { describe, expect, it } from 'vitest';
import { decodeHelperCensus } from './decodeHelperCensus';

const envelope = {
    v: 1, capturedAtMs: 1000, logicalCpus: 4,
    rows: [{ pid: 42, ppid: 1, start: { startTimeMs: 900 }, principal: { kind: 'sid', value: 'S-1-5-21-1000' }, name: 'runner', memory: { kind: 'private', bytes: 8192 }, cpuTimeUs: 9007199254 }],
    partial: [],
};

describe('native census decoding', () => {
    it('distinguishes verified absent Jobs from unreadable Jobs and rejects incomplete membership responses', () => {
        const name = 'Local\\happier-svc09-owned';
        for (const state of ['absent', 'unavailable'] as const) {
            const decoded = decodeHelperCensus(JSON.stringify({ ...envelope, jobObservations: [{ name, state }] }), 42, [name]);
            expect(decoded.status === 'ok' && decoded.jobObservations).toEqual([{ name, state }]);
        }
        for (const jobObservations of [[], [{ name, state: 'live', pids: [] }], [{ name, state: 'absent', pids: [43] }],
            [{ name, state: 'unavailable', pids: [] }], [{ name, state: 'live', pids: [43, 43] }],
            [{ name, state: 'absent' }, { name, state: 'absent' }]]) {
            expect(decodeHelperCensus(JSON.stringify({ ...envelope, jobObservations }), 42, [name])).toEqual({ status: 'unavailable', reason: 'read_failed' });
        }
    });
    it('preserves cumulative microsecond counters and original Windows command lines', () => {
        const decoded = decodeHelperCensus(JSON.stringify({ ...envelope, rows: [{ ...envelope.rows[0], commandLine: '"C:\\path with space\\runner.exe"  argument', argv: ['C:\\path with space\\runner.exe', 'argument'] }] }), 42);
        expect(decoded.status).toBe('ok');
        if (decoded.status !== 'ok') return;
        expect(decoded.rows[0]?.cpuTimeUs).toBe(9007199254);
        expect(decoded.rows[0]?.commandLine).toBe('"C:\\path with space\\runner.exe"  argument');
    });

    it('preserves the POSIX session leader in native Darwin rows', () => {
        const decoded = decodeHelperCensus(JSON.stringify({ ...envelope, rows: [{ ...envelope.rows[0],
            principal: { kind: 'uid', value: '501' }, sessionId: 17, memory: { kind: 'rss', bytes: 8192 },
            start: { startTimeMs: 1754041400000, native: 'darwin-proc:42:1754041400:900000' },
        }] }), 42);
        expect(decoded.status === 'ok' && decoded.rows[0]?.sessionId).toBe(17);
    });

    it('fails closed on unknown fields, duplicate pids, missing self and foreign private fields', () => {
        expect(decodeHelperCensus(JSON.stringify({ ...envelope, extra: true }), 42).status).toBe('unavailable');
        expect(decodeHelperCensus(JSON.stringify({ ...envelope, rows: [...envelope.rows, ...envelope.rows] }), 42).status).toBe('unavailable');
        expect(decodeHelperCensus(JSON.stringify(envelope), 43)).toEqual({ status: 'unavailable', reason: 'self_absent' });
        expect(decodeHelperCensus(JSON.stringify({ ...envelope, rows: [...envelope.rows, { ...envelope.rows[0], pid: 43, principal: { kind: 'sid', value: 'S-1-5-21-2000' }, argv: ['secret'] }] }), 42).status).toBe('unavailable');
        expect(decodeHelperCensus(JSON.stringify({ ...envelope, rows: [{ ...envelope.rows[0], ownershipEnvironment: { SECRET: 'private' } }] }), 42).status).toBe('unavailable');
    });
});
