import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type ProcessTrace = {
  events: Array<{ kind: string; path?: string }>;
};
type ProcessCoverage = { result: Array<{ url: string; functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }> };

async function measureInstalledHelp(pluginCount: number, command: 'help' | 'agents' | 'completion' | 'completion-path' | 'completion-enum' = 'help') {
  const directory = await mkdtemp(join(tmpdir(), 'happier-admitted-help-'));
  temporaryDirectories.push(directory);
  const happyHomeDir = join(directory, 'home');
  for (let index = 0; index < pluginCount; index += 1) {
    const pluginRoot = join(directory, `plugin-${index}`);
    const pluginId = `acme.help-${index}`;
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
      id: pluginId,
      contributes: {
        actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['brief', 'full'] } } } }],
        commands: [{ id: 'read-command', title: 'Read', description: `Read admitted note ${index}`, path: [`admitted-note-${index}`, 'read'], action: 'read' }],
        agents: [{
          id: 'reader', title: `Admitted Agent ${index}`, runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { surfaces: ['terminal'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }],
      },
    }));
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n');
    await writeFile(manifestPath, JSON.stringify(manifest));
    // Admission uses the real writer outside the measured cold process.
    await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: manifest.version, devWatch: true });
  }
  const tracePath = join(directory, 'trace.json');
  const coverageDir = join(directory, 'coverage');
  const compiledEntry = process.env.CLISTART_BUNDLE;
  if (!compiledEntry) throw new Error('CLISTART_BUNDLE must name the canonical compiled CLI under test');
  const argv = command === 'help' ? ['--help'] : command === 'agents' ? ['agents', 'list', '--json'] : [
    'completion', 'candidates', '--',
    ...(command === 'completion-path' ? ['admitted-note-0', 'r']
      : command === 'completion-enum' ? ['admitted-note-0', 'read', '--format', 'b']
        : ['admitted-note-']),
  ];
  const { stdout } = await executeFile(process.execPath, [
    '--require', resolve('../stack/scripts/perf/cli-startup-probe.cjs'),
    compiledEntry, ...argv,
  ], {
    cwd: resolve('.'),
    // Native V8 call counts avoid instrumenting the source-loader worker with
    // Debugger hooks. The probe observes only genuine filesystem boundaries.
    env: { ...process.env, HAPPIER_HOME_DIR: happyHomeDir, NODE_V8_COVERAGE: coverageDir, CLISTART_IMPORT_TRACE: '0', CLISTART_TRACE: tracePath },
    maxBuffer: 1024 * 1024,
  });
  if (process.env.CLISTART_REFERENCE_BUNDLE) {
    const reference = await executeFile(process.execPath, [process.env.CLISTART_REFERENCE_BUNDLE, ...argv], {
      cwd: resolve('.'), env: { ...process.env, HAPPIER_HOME_DIR: happyHomeDir }, maxBuffer: 1024 * 1024,
    });
    expect(stdout).toBe(reference.stdout);
  }
  const trace: ProcessTrace = JSON.parse(await readFile(tracePath, 'utf8'));
  const coverage = (await Promise.all((await readdir(coverageDir)).map(async (file) => (
    JSON.parse(await readFile(join(coverageDir, file), 'utf8')) as ProcessCoverage
  )))).flatMap((report) => report.result);
  const evaluated = coverage.filter((script) => script.functions.some((fn) => fn.ranges.some((range) => range.count > 0)));
  const validationCalls = evaluated.reduce((total, script) => (
    total + script.functions.filter((fn) => (
      /[/\\]zod[/\\]/u.test(script.url)
      || (!script.url.startsWith('node:') && /(?:parse|safeParse|refine|validate)/iu.test(fn.functionName))
    )).reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0)
  ), 0);
  const fullValidationCalls = evaluated.flatMap((script) => script.functions).filter((fn) => (
    /^(?:ingestPluginManifestV2|resolvePluginManifestSetReferencesV2|readInstallationStateRevision|readPluginRegistryCommitInstallationAuthority)$/u.test(fn.functionName)
  )).reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
  const fullValidationOwners = evaluated.filter((script) => /plugins[/\\](?:manifest[/\\](?:ingest|v2)|store[/\\]registry[/\\](?:generationStore|currentState))\.[cm]?[jt]s(?:\?|$)/u.test(script.url)).map((script) => script.url);
  const bodyReads = trace.events.filter((event) => event.kind === 'readFile:start').map((event) => event.path!);
  return { helpText: stdout, evaluatedScriptCount: evaluated.length, validationCalls, fullValidationCalls, fullValidationOwners, bodyReads };
}

it.skipIf(!process.env.CLISTART_BUNDLE)('reads compiled installed help from admitted state with constant validation work and no live-source reads', async () => {
  const single = await measureInstalledHelp(1);
  const several = await measureInstalledHelp(4);
  expect(single.helpText).toContain('Read admitted note 0');
  expect(several.helpText).toContain('Read admitted note 3');
  expect(single.fullValidationCalls, JSON.stringify({
    single: { fullValidationCalls: single.fullValidationCalls, validationCalls: single.validationCalls, reads: single.bodyReads.length },
    several: { fullValidationCalls: several.fullValidationCalls, validationCalls: several.validationCalls, reads: several.bodyReads.length },
  })).toBe(0);
  expect(several.fullValidationCalls).toBe(0);
  expect(single.fullValidationOwners).toEqual([]);
  expect(several.fullValidationOwners).toEqual([]);
  expect(several.validationCalls).toBe(single.validationCalls);
  expect(several.evaluatedScriptCount).toBe(single.evaluatedScriptCount);
  for (const measured of [single, several]) {
    expect(measured.bodyReads).toHaveLength(2);
    expect(measured.bodyReads.every((path) => /plugin-registry-current\.v1\.json$|plugin-installations\.v1\.json$/u.test(path))).toBe(true);
  }
}, 180_000);

it.skipIf(!process.env.CLISTART_BUNDLE)('reads compiled static completion from admitted state without whole-manifest validation', async () => {
  const single = await measureInstalledHelp(1, 'completion');
  const several = await measureInstalledHelp(4, 'completion');
  expect(single.helpText.trim().split('\n')).toEqual(['admitted-note-0']);
  expect(several.helpText.trim().split('\n')).toEqual(['admitted-note-0', 'admitted-note-1', 'admitted-note-2', 'admitted-note-3']);
  expect(single.fullValidationCalls, JSON.stringify({ single: single.fullValidationCalls, several: several.fullValidationCalls })).toBe(0);
  expect(several.fullValidationCalls).toBe(0);
  expect(several.validationCalls).toBe(single.validationCalls);
  expect(several.evaluatedScriptCount).toBe(single.evaluatedScriptCount);
  expect(single.bodyReads.length).toBe(several.bodyReads.length);
  expect(several.bodyReads.some((path) => /plugin\.json$|ui-artifacts/u.test(path))).toBe(false);
}, 180_000);

it.skipIf(!process.env.CLISTART_BUNDLE)('reads compiled Agent listing from admitted state without whole-manifest validation', async () => {
  const single = await measureInstalledHelp(1, 'agents');
  const several = await measureInstalledHelp(4, 'agents');
  expect(JSON.parse(several.helpText).data.agents).toContainEqual({
    id: 'acme.help-3/reader', title: 'Admitted Agent 3', installed: false, source: null, command: null,
  });
  expect(single.fullValidationCalls, JSON.stringify({ single: single.fullValidationCalls, several: several.fullValidationCalls })).toBe(0);
  expect(several.fullValidationCalls).toBe(0);
  expect(several.validationCalls).toBe(single.validationCalls);
  expect(several.evaluatedScriptCount).toBe(single.evaluatedScriptCount);
  expect(single.bodyReads.length).toBe(several.bodyReads.length);
  expect(several.bodyReads.some((path) => /plugin\.json$|ui-artifacts/u.test(path))).toBe(false);
}, 180_000);

it.skipIf(!process.env.CLISTART_BUNDLE).each([
  ['completion-path', 'read'],
  ['completion-enum', 'brief'],
] as const)('reads compiled %s from the admitted command and Action declarations', async (command, expected) => {
  const single = await measureInstalledHelp(1, command);
  const several = await measureInstalledHelp(4, command);
  expect(single.helpText.trim()).toBe(expected);
  expect(several.helpText).toBe(single.helpText);
  expect(single.fullValidationCalls, JSON.stringify({ single: single.fullValidationCalls, several: several.fullValidationCalls })).toBe(0);
  expect(several.fullValidationCalls).toBe(0);
  expect(several.validationCalls).toBe(single.validationCalls);
  expect(several.evaluatedScriptCount).toBe(single.evaluatedScriptCount);
  expect(single.bodyReads.length).toBe(several.bodyReads.length);
  expect(several.bodyReads.some((path) => /plugin\.json$|ui-artifacts/u.test(path))).toBe(false);
}, 180_000);
