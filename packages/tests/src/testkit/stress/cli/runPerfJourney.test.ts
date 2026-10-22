import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as perfJourney from './runPerfJourney';

const { parsePerfJourneyArgs } = perfJourney;

const required = ['--repo-root=/comparison/baseline', '--ui-export-dir=/comparison/export', '--out=/evidence/run', '--journey=J4-stream', '--mode=counts', '--cache=warm'];

describe('isolated performance journey invocation', () => {
  it('preserves the comparison source side and explicit measurement mode', () => {
    expect(parsePerfJourneyArgs([...required, '--heap-cycles=5'])).toMatchObject({ repoRoot: '/comparison/baseline', uiExportDir: '/comparison/export', journey: 'J4-stream', mode: 'counts', cache: 'warm', heapCycles: 5 });
  });
  it('refuses to contaminate timing measurements with forced GC or silently select a journey', () => {
    expect(() => parsePerfJourneyArgs([...required, '--mode=timing', '--heap-cycles=5'])).toThrow(/Heap cycles/);
    expect(() => parsePerfJourneyArgs(required.filter(arg => !arg.startsWith('--journey=')))).toThrow(/journey/);
    expect(() => parsePerfJourneyArgs([...required, '--seed=not-a-seed'])).toThrow(/seed/);
  });
  it('preserves ordered paired captures and shares only a same-seed source environment', () => {
    expect(perfJourney.parsePerfJourneyRequest).toBeTypeOf('function');
    const { parsePerfJourneyRequest } = perfJourney;
    const bases = { candidate: { repoRoot: '/candidate', uiExportDir: '/candidate-export' }, baseline: { repoRoot: '/baseline', uiExportDir: '/baseline-export' } };
    const run = { side: 'candidate', journey: 'J1', cache: 'warm', mode: 'counts', seed: 42, out: '/evidence/one' };
    expect(parsePerfJourneyRequest({ bases, runs: [run, { ...run, side: 'baseline', out: '/evidence/two' }, { ...run, journey: 'J4-stream', out: '/evidence/three', heapCycles: 5 }] }).map(item => [item.side, item.repoRoot, item.out])).toEqual([
      ['candidate', '/candidate', '/evidence/one'], ['baseline', '/baseline', '/evidence/two'], ['candidate', '/candidate', '/evidence/three'],
    ]);
    expect(() => parsePerfJourneyRequest({ bases, runs: [run, { ...run, seed: 43, out: '/evidence/two' }] })).toThrow(/seed/);
    expect(() => parsePerfJourneyRequest({ bases: { candidate: bases.candidate }, runs: [{ ...run, side: 'baseline' }] })).toThrow(/base/);
    expect(() => parsePerfJourneyRequest({ bases, runs: [run, run] })).toThrow(/output/);
  });
  it('consumes the pipeline request file and refuses dependencies borrowed from another checkout before starting resources', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'happier-perf-request-'));
    try {
      const source = join(fixture, 'source');
      const sharedDependencies = join(fixture, 'shared-node-modules');
      await Promise.all([mkdir(source), mkdir(sharedDependencies)]);
      await symlink(sharedDependencies, join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      const out = join(fixture, 'evidence');
      const request = join(fixture, 'request.json');
      await writeFile(request, JSON.stringify({ bases: { candidate: { repoRoot: source, uiExportDir: join(source, 'web') } },
        runs: [{ side: 'candidate', journey: 'J1', mode: 'counts', cache: 'warm', seed: 42, out }] }));
      await expect(perfJourney.runPerfJourney([`--request-file=${request}`])).rejects.toThrow(/private comparison tree/);
      expect(JSON.parse(await readFile(join(out, 'scenario-failure.json'), 'utf8'))).toMatchObject({ phase: 'environment-prepare', status: 'FAILED' });
      expect(JSON.parse(await readFile(join(out, 'scenario-cleanup.json'), 'utf8'))).toMatchObject({ status: 'CLEANED', ownedEnvironments: 0 });
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
});
