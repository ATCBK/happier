import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The CLI owns esbuild; this observes the plugin's real source graph without
// introducing a runtime dependency or substituting any internal implementation.
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const { build } = createRequire(resolve(repoRoot, 'apps/cli/package.json'))('esbuild') as typeof import('esbuild');
const pluginRoot = fileURLToPath(new URL('./', import.meta.url));
const triageOperations = ['triage/operations.ts', 'triage/detailOperations.ts', 'triage/mutationOperations.ts'];

describe('GitHub daemon import boundary', () => {
  it('retains Triage execution for first use without loading it for the Event observer activation', async () => {
    const { metafile } = await build({
      absWorkingDir: pluginRoot,
      entryPoints: ['index.ts'],
      outdir: 'unused-daemon-graph',
      platform: 'node',
      format: 'esm',
      bundle: true,
      write: false,
      metafile: true,
      conditions: ['happier-source'],
      external: ['@happier-dev/*'],
      logLevel: 'silent',
    });
    const inputs = metafile!.inputs;
    const eager = new Set<string>();
    function visit(path: string): void {
      if (eager.has(path)) return;
      eager.add(path);
      const input = inputs[path];
      if (!input) throw new Error(`Missing bundled input: ${path}`);
      for (const dependency of input.imports) {
        if (!dependency.external && dependency.kind !== 'dynamic-import') visit(dependency.path);
      }
    }
    visit('index.ts');
    for (const path of triageOperations) {
      expect(inputs[path], `${path} must remain available to its registered Actions`).toBeDefined();
    }
    // The named startup consumer must remain reachable; deleting the plugin or
    // making its observer cold is not a fix for unrelated Action execution code.
    expect(eager.has('observations/githubAutomationEventObserver.ts')).toBe(true);
    expect(triageOperations.filter(path => eager.has(path)), 'unused Triage operations must stay cold at activation').toEqual([]);
  });
});
