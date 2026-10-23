import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

import {
  bundleCliSourceSidecars,
  createWorkspaceSourceResolver,
  readWorkspacePackages,
  SOURCE_CONDITION,
  SOURCE_RUNTIME_OUTPUT_OPTIONS,
} from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { withTempDir } from '@/testkit/fs/tempDir';

it('loads Memory process and child named exports from the compiled lazy-import paths', async () => {
  await withTempDir('happier-memory-bundle-', async outputDir => {
    const env = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    const home = join(outputDir, 'home');
    await mkdir(home);
    applyEnvValues({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://api.example.test', HAPPIER_WEBAPP_URL: 'https://app.example.test' });
    try {
      const repoDir = fileURLToPath(new URL('../../../../../', import.meta.url));
      const cliDir = join(repoDir, 'apps/cli');
      const workspacePackages = await readWorkspacePackages(repoDir);
      const requireFromProject = createRequire(join(cliDir, 'package.json'));
      const sources = {
        facade: fileURLToPath(new URL('./memoryWorker.ts', import.meta.url)),
        process: fileURLToPath(new URL('./processMemoryIndexer.ts', import.meta.url)),
        command: fileURLToPath(new URL('../../cli/commands/daemon.ts', import.meta.url)),
        child: fileURLToPath(new URL('./memoryIndexerServiceEntry.ts', import.meta.url)),
      };
      // Match the canonical source-runtime package-dist/chunks + scripts root
      // layout, retaining real external dependencies through its resolver.
      const result = await build({
        absWorkingDir: repoDir,
        entryPoints: { 'package-dist/facade': sources.facade, 'package-dist/command': sources.command },
        outdir: outputDir, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20',
        chunkNames: 'package-dist/chunks/[name]-[hash]',
        ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
        conditions: [SOURCE_CONDITION], metafile: true, logLevel: 'silent',
        tsconfig: join(cliDir, 'tsconfig.json'),
        plugins: [createWorkspaceSourceResolver({ workspacePackages, requireFromProject })],
        banner: { js: "import { createRequire as __artifactCreateRequire } from 'node:module'; import { fileURLToPath as __artifactFileURLToPath } from 'node:url'; import { dirname as __artifactDirname } from 'node:path'; const require = __artifactCreateRequire(import.meta.url); const __artifactFilename = __artifactFileURLToPath(import.meta.url); const __artifactDirectory = __artifactDirname(__artifactFilename);" },
        define: { __dirname: '__artifactDirectory', __filename: '__artifactFilename' },
      });
      await bundleCliSourceSidecars({ repoDir, outputDir: join(outputDir, 'scripts'), build,
        workspacePackages, requireFromProject });
      await writeFile(join(outputDir, 'package.json'), '{"type":"module"}');
      const outputFor = (source: string) => {
        const output = Object.entries(result.metafile.outputs).find(([, metadata]) =>
          metadata.entryPoint !== undefined && resolve(repoDir, metadata.entryPoint) === source);
        if (!output) throw new Error(`Missing compiled Memory entry: ${source}`);
        return { path: resolve(repoDir, output[0]), metadata: output[1] };
      };
      const facade = outputFor(sources.facade);
      const processOutput = outputFor(sources.process);
      const command = outputFor(sources.command);
      const child = outputFor(sources.child);
      const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, metadata]) =>
        [resolve(repoDir, path), metadata]));
      const hasLazyImport = (from: string, target: string, seen = new Set<string>()): boolean => {
        if (seen.has(from)) return false;
        seen.add(from);
        return outputs.get(from)?.imports.some(edge => !edge.external && (edge.kind === 'dynamic-import'
          ? resolve(repoDir, edge.path) === target
          : hasLazyImport(resolve(repoDir, edge.path), target, seen))) ?? false;
      };
      for (const [owner, target] of [[facade, processOutput], [command, child]]) {
        expect(hasLazyImport(owner.path, target.path)).toBe(true);
      }
      const entries = [
        [facade, 'startMemoryWorker'], [processOutput, 'connectProcessMemoryIndexer'],
        [command, 'handleDaemonCliCommand'], [child, 'runMemoryIndexerService'],
      ] as const;
      // Like controlHttp.bundledUndici, execute emitted exports outside the
      // Vitest VM. This probe imports only; it invokes no daemon/worker entry.
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        const callable = [];
        for (const [url, exported] of JSON.parse(process.argv[1])) {
          const loaded = await import(url);
          callable.push(typeof loaded[exported]);
        }
        process.stdout.write(JSON.stringify(callable));
      `, JSON.stringify(entries.map(([output, exported]) => [pathToFileURL(output.path).href, exported]))],
      { cwd: outputDir, encoding: 'utf8' });
      expect(JSON.parse(stdout)).toEqual(['function', 'function', 'function', 'function']);
    } finally { restoreEnvValues(env); }
  });
});
