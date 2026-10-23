import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, onTestFinished } from 'vitest';
import { staticCommandDescriptors } from './commandDescriptors';
import { BUNDLED_ACTION_CLI_COMMAND_PATHS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';

const execute = promisify(execFile);
type Coverage = readonly { url: string; functions: readonly { ranges: readonly { count: number }[] }[] }[];
type Trace = { coverage: Coverage; events: readonly { kind: string; transport?: string }[] };
const evaluated = (coverage: Coverage) => coverage.filter((script) => script.functions.some((fn) => fn.ranges.some((range) => range.count > 0)));
const heavy = (path: string) => /packages\/(?:protocol|plugin-sdk|agents|plugins)\/|apps\/cli\/src\/(?:configuration\.ts|providers\/|agent\/catalog\/|plugins\/runtime\/|plugins\/projection\/registry\/createResolvedContributionRegistry)/u.test(path);
const outputs = process.env.CLISTART_METAFILE
  ? (JSON.parse(await readFile(process.env.CLISTART_METAFILE, 'utf8')) as { outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }> }).outputs
  : null;
function evaluatedPaths(coverage: Coverage): readonly string[] {
  const scripts = evaluated(coverage);
  return outputs ? [...new Set(scripts.flatMap((script) => {
    const output = Object.entries(outputs).find(([path]) => script.url.endsWith(path.replace(/^(?:\.\.\/)+/u, '')))?.[1];
    return Object.entries(output?.inputs ?? {}).filter(([, data]) => data.bytesInOutput > 0).map(([path]) => path);
  }))] : scripts.map((script) => script.url);
}

const managerRoots = [...new Set([
  ...Object.entries(staticCommandDescriptors).filter(([, descriptor]) => descriptor.help).map(([root]) => root),
  ...BUNDLED_ACTION_CLI_COMMAND_PATHS.map((command) => command.path[0]!),
])];
// The accepted d012 reference predates help support for these roots. Several
// ignored --help and performed the operation; never invoke those as a fixture.
const rootsWithoutReferenceHelp = new Set(['completion', 'status', 'self-update', 'logout', 'acp-catalog', 'capabilities', 'tools']);

it.skipIf(!process.env.CLISTART_FAMILY_SOURCE && !process.env.CLISTART_BUNDLE).each(managerRoots)('keeps %s family help out of executable catalogs', async (root) => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-manager-help-'));
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  try {
    const tracePath = join(directory, 'trace.json');
    const child = await execute(process.execPath, [
      '--require', resolve('../stack/scripts/perf/cli-startup-probe.cjs'),
      ...(process.env.CLISTART_BUNDLE ? [] : ['--import', 'tsx']),
      process.env.CLISTART_BUNDLE ?? resolve('src/index.ts'), root, '--help',
    ], {
      env: { ...process.env, HAPPIER_CLI_INVOKER_NAME: 'happier', HAPPIER_HOME_DIR: join(directory, 'home'), CLISTART_IMPORT_TRACE: '1', CLISTART_TRACE: tracePath },
      maxBuffer: 8 * 1024 * 1024,
      signal: controller.signal,
    });
    const trace: Trace = JSON.parse(await readFile(tracePath, 'utf8'));
    const paths = evaluatedPaths(trace.coverage);
    expect(child.stdout.trim()).not.toBe('');
    if (process.env.CLISTART_REFERENCE_BUNDLE && !rootsWithoutReferenceHelp.has(root)) {
      const reference = await execute(process.execPath, [process.env.CLISTART_REFERENCE_BUNDLE, root, '--help'], {
        env: { ...process.env, HAPPIER_CLI_INVOKER_NAME: 'happier', HAPPIER_HOME_DIR: join(directory, 'home') }, maxBuffer: 8 * 1024 * 1024, signal: controller.signal,
      });
      const currentLines = child.stdout.split('\n');
      const referenceLines = reference.stdout.split('\n');
      const differentLine = currentLines.findIndex((line, index) => line !== referenceLines[index]);
      expect(child.stdout === reference.stdout, JSON.stringify({ root, differentLine,
        current: currentLines[differentLine], reference: referenceLines[differentLine] })).toBe(true);
    }
    expect(paths.some((path) => /apps\/cli\/src\/cli\/familyHelp\.ts(?:\?|$)/u.test(path))).toBe(true);
    expect(paths.filter((path) => /packages\/(?:plugin-sdk|agents|plugins)\/|apps\/cli\/src\/(?:configuration\.ts|providers\/|agent\/catalog\/|plugins\/runtime\/|plugins\/projection\/registry\/createResolvedContributionRegistry|cli\/actions\/(?:commandPresentation|compiledCommands)\.ts)/u.test(path))).toEqual([]);
    expect(trace.events.filter((event) => event.kind === 'http:request' || event.kind === 'socket:start' && event.transport !== 'ipc')).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it.skipIf(!process.env.CLISTART_FAMILY_SOURCE_TRACE)('does not evaluate runtime catalogs for source family help', async () => {
  // A saved genuine-process trace may supply RED when the old source graph
  // takes minutes. GREEN uses the current entry process below, not a fixture.
  const trace: Trace = JSON.parse(await readFile(process.env.CLISTART_FAMILY_SOURCE_TRACE!, 'utf8'));
  const urls = evaluated(trace.coverage).map((script) => script.url);
  expect(urls.some((path) => /apps\/cli\/src\/cli\/commands\/providers\.ts(?:\?|$)/u.test(path))).toBe(true);
  expect(urls.filter(heavy)).toEqual([]);
});

it.skipIf(!process.env.CLISTART_BUNDLE && !process.env.CLISTART_FAMILY_SOURCE)('renders family help with the same bytes and import boundary as root help', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-family-help-'));
  try {
    const entry = process.env.CLISTART_BUNDLE ?? resolve('src/index.ts');
    const run = async (argv: string[]) => {
      const tracePath = join(directory, `${argv.join('-')}.json`);
      const child = await execute(process.execPath, [
        '--require', resolve('../stack/scripts/perf/cli-startup-probe.cjs'),
        ...(process.env.CLISTART_BUNDLE ? [] : ['--import', 'tsx']), entry, ...argv,
      ], {
        env: { ...process.env, HAPPIER_HOME_DIR: join(directory, 'home'), CLISTART_IMPORT_TRACE: '1', CLISTART_TRACE: tracePath },
        maxBuffer: 8 * 1024 * 1024,
      });
      const trace: Trace = JSON.parse(await readFile(tracePath, 'utf8'));
      const paths = evaluatedPaths(trace.coverage);
      expect(paths.some((path) => /apps\/cli\/src\/index\.[jt]s$/u.test(path))).toBe(true);
      expect(trace.events.filter((event) => event.kind === 'http:request' || event.kind === 'socket:start' && event.transport !== 'ipc')).toEqual([]);
      return { stdout: child.stdout, paths };
    };
    const root = await run(['--help']);
    expect(root.paths.filter(heavy)).toEqual([]);
    const provider = await run(['provider', '--help']);
    expect(provider.stdout).toBe(await readFile(process.env.CLISTART_FAMILY_HELP_BASELINE!, 'utf8'));
    const forbidden = provider.paths.filter(heavy);
    expect(forbidden.length, `root=${root.paths.length}; family=${provider.paths.length}; first=${forbidden.slice(0, 5).join(',')}`).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
