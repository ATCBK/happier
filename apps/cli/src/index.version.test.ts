import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, onTestFinished } from 'vitest';

import packageJson from '../package.json';

const cliRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
const tracePrefix = 'CLI_VERSION_MODULES=';
const runProcess = promisify(execFile);
const preload = `
  import { Session } from 'node:inspector';
  const session = new Session();
  const scripts = [];
  session.connect();
  session.on('Debugger.scriptParsed', ({ params }) => scripts.push(params.url));
  session.post('Debugger.enable');
  process.once('exit', () => console.error(${JSON.stringify(tracePrefix)} + JSON.stringify(scripts)));
`;

describe('CLI version entrypoint cost', () => {
  it.each(['--version', '--help'])('preserves a successful exit when the stdout reader closes before %s output', async (flag) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', flag], {
      cwd: cliRoot,
      env: { ...process.env, HAPPIER_CLI_DIST_INTEGRITY_PROBE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onTestFinished(() => { if (child.exitCode === null) child.kill(); });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    // Close the OS pipe's reader while the real CLI process is still starting.
    child.stdout.destroy();
    expect(await exit, stderr).toBe(0);
  });

  it.each(['--version', '-v'])('%s evaluates only lightweight argument, version, and console modules', async (flag) => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-version-entry-'));
    try {
      // A real source process observes the production entrypoint, without mocking
      // bootstrap, configuration, dispatch, or the plugin/schema dependency graph.
      const result = await runProcess(process.execPath, [
        '--import', 'tsx',
        '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
        'src/index.ts', flag,
      ], {
        cwd: cliRoot,
        env: { ...process.env, HAPPIER_HOME_DIR: homeDir, HAPPIER_CLI_DIST_INTEGRITY_PROBE: '' },
        encoding: 'utf8',
      });
      expect(result.stdout.trim()).toBe(packageJson.version);
      const trace = result.stderr.split('\n').find((line) => line.startsWith(tracePrefix));
      expect(trace).toBeDefined();
      const scripts: string[] = JSON.parse(trace!.slice(tracePrefix.length));
      const loadedFiles = [...new Set(scripts
        .filter((url) => url.startsWith('file:'))
        .map((url) => fileURLToPath(url)))];
      const cliSources = loadedFiles.filter((path) => path.startsWith(sourceRoot));
      expect(cliSources).toContain(join(sourceRoot, 'index.ts'));
      expect(cliSources.filter((path) => ![
        'index.ts', 'cli/processArgs.ts', 'cli/version.ts', 'utils/writeConsoleBestEffort.ts',
      ].some((allowed) => path === join(sourceRoot, allowed)))).toEqual([]);
      expect(loadedFiles.filter((path) => path.startsWith(join(cliRoot, '../../packages') + sep))).toEqual([]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
