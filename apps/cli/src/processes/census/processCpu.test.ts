import { describe, expect, it } from 'vitest';
import type { ProcessCensusSnapshot } from './processCensus';
import { createProcessCpuSampler } from './processCpu';

function snapshot(at: number, cpuTimeUs: number | null, startTimeMs = 1000): Extract<ProcessCensusSnapshot, { status: 'ok' }> {
  return { status: 'ok', capturedAtMs: at, logicalCpus: 4, rows: [{
    pid: 42, ppid: 1, name: 'node', start: { startTimeMs }, principal: null, memory: null, cpuTimeUs,
  }] };
}

describe('census CPU rates', () => {
  it('shows no first rate and reports CPU time as a share of the whole machine', () => {
    const sampler = createProcessCpuSampler();
    expect(sampler.sample(snapshot(1000, 100_000)).has(42)).toBe(false);
    expect(sampler.sample(snapshot(2000, 1_100_000)).get(42)).toBe(25);
    expect(sampler.sample(snapshot(3000, 9_100_000)).get(42)).toBe(100);
  });

  it('never carries a previous generation or unreadable counter into a new rate', () => {
    const sampler = createProcessCpuSampler();
    sampler.sample(snapshot(1000, 100_000));
    expect(sampler.sample(snapshot(2000, 100_000, 2000)).has(42)).toBe(false);
    expect(sampler.sample(snapshot(3000, null, 2000)).has(42)).toBe(false);
    expect(sampler.sample(snapshot(4000, 2_100_000, 2000)).has(42)).toBe(false);
    expect(sampler.sample(snapshot(5000, 3_100_000, 2000)).get(42)).toBe(25);
  });
});
