import { describe, expect, it } from 'vitest';
import type { ProcessCensusRow } from '../census/processCensus';
import { ancestorsOf, descendantsOf, indexCensus, membersOfCgroup, membersOfJob, membersOfPgid, protectedSet } from './processTree';

function row(pid: number, ppid: number, pgid = pid): ProcessCensusRow {
    return { pid, ppid, pgid, start: { startTimeMs: pid * 10 }, principal: { kind: 'uid', value: '1000' }, name: 'process', memory: null, cpuTimeUs: null };
}

describe('census tree', () => {
    it('protects only reader and ancestor groups, not a non-ancestor login session leader', () => {
        const index = indexCensus([row(20, 1), { ...row(30, 1), sessionId: 20 }, row(40, 1)]);
        expect(protectedSet(index, 30).has(20)).toBe(false);
        expect(protectedSet(index, 30).has(40)).toBe(false);
    });
    it('walks deep trees and cycles once without including roots or system pids', () => {
        const rows = [row(1, 0), ...Array.from({ length: 8 }, (_, index) => row(index + 10, index + 9)), row(30, 31), row(31, 30)];
        const index = indexCensus(rows);
        expect(descendantsOf(index, [10]).map(value => value.pid)).toEqual([11, 12, 13, 14, 15, 16, 17]);
        expect(ancestorsOf(index, 17).map(value => value.pid)).toEqual([16, 15, 14, 13, 12, 11, 10]);
        expect(descendantsOf(index, [30]).map(value => value.pid)).toEqual([31]);
        expect(ancestorsOf(index, 30).map(value => value.pid)).toEqual([31]);
    });

    it('matches containment boundaries and protects ancestors and their groups', () => {
        const index = indexCensus([
            { ...row(2, 1, 2), cgroup: '/parent/job', jobs: ['job'] },
            { ...row(3, 2, 2), cgroup: '/parent/job/child', jobs: ['job'] },
            { ...row(4, 2, 4), cgroup: '/parent/job-other' },
            row(5, 1, 2),
            row(1, 0),
        ]);
        expect(membersOfCgroup(index, '/parent/job').map(value => value.pid)).toEqual([2, 3]);
        expect(membersOfJob(index, 'job').map(value => value.pid)).toEqual([2, 3]);
        expect(membersOfPgid(index, 2).map(value => value.pid)).toEqual([2, 3, 5]);
        expect([...protectedSet(index, 3)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 5]);
    });
});
