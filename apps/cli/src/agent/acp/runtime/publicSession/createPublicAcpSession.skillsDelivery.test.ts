import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { PluginAgentContributionV2Schema, PluginManifestV2Schema, type PluginAgentAcpSkillsSessionDeliveryV2 } from '@happier-dev/protocol';
import type { AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentLaunchObserver, createPluginTestkit, runAgentSkillDeliveryContract, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { COPILOT_PLUGIN } from '@happier-dev/plugins-copilot/manifest';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { normalizePluginDeclarativeAcpRuntime } from '@/agent/acp/runtime/definition/plugin';
import { readBundledPluginManifest } from '@/plugins/projection/registry/builtIn/locators';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { waitForCondition } from '@/testkit/async/waitFor';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpSession, createPublicAcpExecutionRun, type PublicAcpComposerDependencies } from './createPublicAcpSession';

const nativeConfig = {
  configRootEnvKey: { posix: 'XDG_CONFIG_HOME', win32: 'APPDATA' },
  homeRelativeConfigRoot: { posix: ['.config'], win32: ['AppData', 'Roaming'] },
  directory: 'devin', fileName: 'mcp_config.json', serversKey: 'mcpServers',
};
const knobs: readonly PluginAgentAcpSkillsSessionDeliveryV2[] = [
  { kind: 'env_path_list', envKey: 'COPILOT_SKILLS_DIRS', separator: ',', value: 'skills_root' },
  { kind: 'env_path_list', envKey: 'CODEBUDDY_PLUGIN_DIRS', separator: 'path_delimiter', value: 'plugin_root' },
  { kind: 'defaults_file_env', envKey: 'QWEN_CODE_SYSTEM_DEFAULTS_PATH', directoriesKeyPath: ['skills', 'directories'], disabledKeyPath: ['skills', 'disabled'] },
  { kind: 'native_config_skills_dir', subdirectory: 'skills' },
];
function declaredAgent(knob: PluginAgentAcpSkillsSessionDeliveryV2) {
  const agent = PluginAgentContributionV2Schema.parse({
    id: `fixture-${knob.kind.replaceAll('_', '-')}`, title: 'ACP skills fixture', primary: 'sessions',
    capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
      skills: { delivery: 'session_dir', nativeDisable: knob.kind === 'defaults_file_env' ? 'supported' : 'unsupported', liveReload: 'unsupported' } },
    runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } },
      definition: { skills: { sessionDelivery: knob },
        mcp: knob.kind === 'native_config_skills_dir' ? { policy: 'drop', nativeSessionConfig: nativeConfig } : { policy: 'pass_through' } } },
  });
  if (!('runtime' in agent) || agent.runtime.kind !== 'acp') throw new Error('Expected an ACP fixture');
  return agent;
}
const CaptureSchema = z.strictObject({ pid: z.number(), argv: z.array(z.string()), env: z.record(z.string(), z.string()), sessionNew: z.unknown() });
function fixture(dir: string, launchEnv: Readonly<Record<string, string>>, signal = new AbortController().signal, scenario = 'normal') {
  const capture = join(dir, 'launch.json');
  const script = writeAcpTestAgentScript({ dir, fileName: 'agent.mjs', source: `
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    const keys = ['HOME','XDG_CONFIG_HOME','APPDATA','COPILOT_SKILLS_DIRS','CODEBUDDY_PLUGIN_DIRS','QWEN_CODE_SYSTEM_DEFAULTS_PATH'];
    const record = sessionNew => writeFileSync(process.env.CAPTURE, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2),
      env: Object.fromEntries(keys.filter(key => typeof process.env[key] === 'string').map(key => [key,process.env[key]])), sessionNew }));
    for await (const line of createInterface({ input: process.stdin })) {
      const r = JSON.parse(line); if (r.id === undefined) continue;
      if (r.method === 'initialize') {
        record(null);
        if (process.env.SCENARIO === 'cancel') continue;
      }
      if (r.method === 'session/new' || r.method === 'session/load') record(r.params);
      if (r.method === 'session/new' && process.env.SCENARIO === 'fail') {
        process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:r.id, error:{code:-32000,message:'Fixture open failure'} })+'\\n'); continue;
      }
      const result = r.method === 'initialize' ? {protocolVersion:1,agentCapabilities:{loadSession:true}}
        : r.method === 'session/new' || r.method === 'session/load' ? {sessionId:'native-session'}
        : r.method === 'session/prompt' ? {stopReason:'end_turn'} : {};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
    }
  ` });
  const dependencies: PublicAcpComposerDependencies = {
    pluginId: 'fixture', agentId: 'fixture', signal, isCurrent: () => true,
    systemTools: { resolve: async request => ({ toolId: request.toolId, launch: { kind: 'binary', executablePath: process.execPath,
      args: [script], env: { COPILOT_SKILLS_DIRS: '', CODEBUDDY_PLUGIN_DIRS: '', QWEN_CODE_SYSTEM_DEFAULTS_PATH: '',
        XDG_CONFIG_HOME: join(launchEnv.HOME!, '.config'), APPDATA: join(launchEnv.HOME!, '.config'),
        ...launchEnv, CAPTURE: capture, SCENARIO: scenario } } }) },
    interactions: { async request() { throw new Error('Unexpected interaction'); } },
    media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
    models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
  };
  return { dependencies, capture, observe: () => CaptureSchema.parse(JSON.parse(readFileSync(capture, 'utf8'))) };
}
async function skillFixture(dir: string): Promise<AgentSessionSkillDelivery> {
  const pluginRoot = join(dir, 'session-skills');
  const skillsRoot = join(pluginRoot, 'skills');
  await mkdir(join(skillsRoot, 'review', 'scripts'), { recursive: true });
  await writeFile(join(skillsRoot, 'review', 'SKILL.md'), 'Review skill');
  await writeFile(join(skillsRoot, 'review', 'scripts', 'nested.txt'), 'supporting file');
  return { pluginRoot, skillsRoot, items: [{ name: 'review', skillId: 'review', digest: 'sha256:fixture', directory: join(skillsRoot, 'review') }],
    nativeDisables: [{ name: 'native-off', path: join(dir, 'native', 'native-off', 'SKILL.md') }] };
}
function options(knob: PluginAgentAcpSkillsSessionDeliveryV2) {
  const agent = declaredAgent(knob);
  if (agent.runtime.kind !== 'acp') throw new Error('Expected an ACP fixture');
  return normalizePluginDeclarativeAcpRuntime(agent.runtime);
}

describe('declarative ACP skills delivery through the production composer', () => {
  it('honors skills refresh cancellation through the SDK options argument', async () => {
    await withTempDir('happier-acp-skill-refresh-cancel-', async dir => {
      const skills = await skillFixture(dir);
      const f = fixture(dir, { HOME: dir });
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir, skills }, options(knobs[0]!), f.dependencies);
      try {
        if (!runtime.refreshSkills) throw new Error('Expected the Session skills refresh boundary');
        const controller = new AbortController();
        const reason = new Error('Skills refresh cancelled');
        controller.abort(reason);
        await expect(runtime.refreshSkills({ skills }, { signal: controller.signal })).rejects.toBe(reason);
        await expect(runtime.refreshSkills({ skills })).resolves.toEqual({
          kind: 'restart_required', reason: 'launch_path_unsupported',
        });
      } finally { await runtime.dispose(); }
    });
  });
  it.each(knobs.filter(knob => knob.kind === 'env_path_list'))('appends $envKey with its declared separator without changing native HOME', async knob => {
    if (knob.kind !== 'env_path_list') throw new Error('Expected a path list');
    await withTempDir('happier-acp-skill-list-', async dir => {
      const home = join(dir, 'native-home'); await mkdir(home);
      const skills = await skillFixture(dir);
      const f = fixture(dir, { HOME: home, [knob.envKey]: '/user/first' });
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir, skills }, options(knob), f.dependencies);
      try {
        const root = knob.value === 'skills_root' ? skills.skillsRoot : skills.pluginRoot;
        expect(f.observe().env[knob.envKey]).toBe(`/user/first${knob.separator === ',' ? ',' : delimiter}${root}`);
        expect(f.observe().env.HOME).toBe(home);
        expect(runtime.skillsDelivered).not.toBe(false);
      } finally { await runtime.dispose(); }
    });
  });
  it('unions inherited defaults directories and disables in a private file, preserving the native file', async () => {
    await withTempDir('happier-acp-skill-defaults-', async dir => {
      const userFile = join(dir, 'defaults.json');
      const original = { model: 'retained', skills: { directories: ['/user/extra'], disabled: ['already-off'], other: true } };
      await writeFile(userFile, JSON.stringify(original));
      const skills = await skillFixture(dir);
      const f = fixture(dir, { HOME: dir, QWEN_CODE_SYSTEM_DEFAULTS_PATH: userFile });
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir, skills }, options(knobs[2]!), f.dependencies);
      const overlay = f.observe().env.QWEN_CODE_SYSTEM_DEFAULTS_PATH!;
      try {
        expect(overlay).not.toBe(userFile);
        expect(JSON.parse(await readFile(overlay, 'utf8'))).toEqual({ ...original,
          skills: { ...original.skills, directories: ['/user/extra', skills.skillsRoot], disabled: ['already-off', 'native-off'] } });
        expect(JSON.parse(await readFile(userFile, 'utf8'))).toEqual(original);
        expect(runtime.skillsDelivered).not.toBe(false);
      } finally { await runtime.dispose(); }
      expect(existsSync(overlay)).toBe(false);
    });
  });
  it('builds a real native skills directory without MCP, preserving the user map, siblings and HOME', async () => {
    await withTempDir('happier-acp-skill-native-', async dir => {
      const sourceRoot = join(dir, 'user-config');
      await mkdir(join(sourceRoot, 'devin', 'skills', 'native'), { recursive: true });
      await mkdir(join(sourceRoot, 'git'));
      await writeFile(join(sourceRoot, 'git', 'config'), 'native git config');
      await writeFile(join(sourceRoot, 'devin', 'skills', 'native', 'SKILL.md'), 'Native skill');
      const original = '{"mcpServers":{"native":{"command":"native-tool"}},"other":true}';
      await writeFile(join(sourceRoot, 'devin', 'mcp_config.json'), original);
      const skills = await skillFixture(dir);
      const envKey = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
      const f = fixture(dir, { HOME: dir, [envKey]: sourceRoot });
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir, skills }, options(knobs[3]!), f.dependencies);
      const privateRoot = f.observe().env[envKey]!;
      try {
        expect(privateRoot).not.toBe(sourceRoot);
        const privateSkills = join(privateRoot, 'devin', 'skills');
        expect((await lstat(privateSkills)).isDirectory()).toBe(true);
        expect((await lstat(privateSkills)).isSymbolicLink()).toBe(false);
        expect(await readFile(join(privateSkills, 'native', 'SKILL.md'), 'utf8')).toBe('Native skill');
        expect(await readFile(join(privateSkills, 'review', 'scripts', 'nested.txt'), 'utf8')).toBe('supporting file');
        expect(JSON.parse(await readFile(join(privateRoot, 'devin', 'mcp_config.json'), 'utf8'))).toEqual({
          mcpServers: { native: { command: 'native-tool', env: { [envKey]: sourceRoot } } }, other: true,
        });
        expect(await readFile(join(privateRoot, 'git', 'config'), 'utf8')).toBe('native git config');
        expect(f.observe().env.HOME).toBe(dir);
        expect(existsSync(join(sourceRoot, 'devin', 'skills', 'review'))).toBe(false);
      } finally { await runtime.dispose(); }
      expect(existsSync(privateRoot)).toBe(false);
      expect(await readFile(join(sourceRoot, 'devin', 'mcp_config.json'), 'utf8')).toBe(original);
    });
  });
  it.each([
    { scenario: 'fail', knob: knobs[2]! }, { scenario: 'cancel', knob: knobs[2]! },
    { scenario: 'fail', knob: knobs[3]! }, { scenario: 'cancel', knob: knobs[3]! },
  ])('releases the private $knob.kind root after open $scenario', async ({ scenario, knob }) => {
    await withTempDir('happier-acp-skill-cleanup-', async dir => {
      const skills = await skillFixture(dir); const controller = new AbortController();
      const f = fixture(dir, { HOME: dir }, controller.signal, scenario);
      const opened = createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir, skills }, options(knob), f.dependencies);
      const failed = opened.catch((error: unknown) => error);
      if (scenario === 'cancel') {
        await waitForCondition(() => existsSync(f.capture), { timeoutMs: 5_000, intervalMs: 10, label: 'ACP initialize capture' });
        controller.abort();
      }
      expect(await failed).toBeInstanceOf(Error);
      const captured = f.observe();
      // The same owner that retires private launch files must observe this
      // exact native child gone; an aborted open alone is not cleanup proof.
      expect(() => process.kill(captured.pid, 0)).toThrow();
      const envKey = knob.kind === 'defaults_file_env' ? knob.envKey : process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
      const overlay = captured.env[envKey];
      expect(overlay).toBeTruthy();
      expect(existsSync(overlay!)).toBe(false);
    });
  });
  it('keeps the Session usable and reports refusal when inherited defaults cannot be read', async () => {
    await withTempDir('happier-acp-skill-refusal-', async dir => {
      const missing = join(dir, 'missing.json'); const skills = await skillFixture(dir);
      const f = fixture(dir, { HOME: dir, QWEN_CODE_SYSTEM_DEFAULTS_PATH: missing });
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir, skills }, options(knobs[2]!), f.dependencies);
      try { expect(runtime.skillsDelivered).toBe(false); expect(f.observe().env.QWEN_CODE_SYSTEM_DEFAULTS_PATH).toBe(missing); }
      finally { await runtime.dispose(); }
    });
  });
  it('preserves MCP delivery when the optional native skills root cannot be read', async () => {
    await withTempDir('happier-acp-skill-native-refusal-', async dir => {
      const invalidRoot = join(dir, 'not-a-directory'); await writeFile(invalidRoot, 'invalid skills root');
      const skills = { ...await skillFixture(dir), skillsRoot: invalidRoot };
      const f = fixture(dir, { HOME: dir });
      const envKey = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir, skills,
        mcpServers: { session: { command: 'session-tool', args: ['--stdio'] } } }, options(knobs[3]!), f.dependencies);
      const privateRoot = f.observe().env[envKey]!;
      try {
        expect(runtime.skillsDelivered).toBe(false);
        expect(JSON.parse(await readFile(join(privateRoot, 'devin', 'mcp_config.json'), 'utf8'))).toEqual({
          mcpServers: { session: { command: 'session-tool', args: ['--stdio'], env: { [envKey]: join(dir, '.config') } } },
        });
        expect(f.observe().sessionNew).toEqual({ cwd: dir, mcpServers: [] });
      } finally { await runtime.dispose(); }
      expect(existsSync(privateRoot)).toBe(false);
    });
  });
  it.each([['__proto__', 'directories'], ['constructor', 'prototype', 'directories']])('treats defaults path %j as own JSON data without mutating prototypes', async (...directoriesKeyPath) => {
    await withTempDir('happier-acp-skill-json-path-', async dir => {
      const skills = await skillFixture(dir); const f = fixture(dir, { HOME: dir });
      const knob: PluginAgentAcpSkillsSessionDeliveryV2 = { kind: 'defaults_file_env', envKey: 'QWEN_CODE_SYSTEM_DEFAULTS_PATH', directoriesKeyPath };
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir, skills }, options(knob), f.dependencies);
      try {
        const raw = await readFile(f.observe().env.QWEN_CODE_SYSTEM_DEFAULTS_PATH!, 'utf8');
        let value: unknown = JSON.parse(raw);
        for (const key of directoriesKeyPath) {
          expect(value !== null && typeof value === 'object' && Object.hasOwn(value, key)).toBe(true);
          value = Reflect.get(value as object, key);
        }
        expect(value).toEqual([skills.skillsRoot]);
        expect(Reflect.get({}, 'directories')).toBeUndefined();
      } finally { await runtime.dispose(); }
    });
  });
  it('delivers the same declared knob through the detached Run composer', async () => {
    await withTempDir('happier-acp-run-skills-', async dir => {
      const skills = await skillFixture(dir); const f = fixture(dir, { HOME: dir });
      const runtime = await createPublicAcpExecutionRun({ kind: 'create', runId: 'run', cwd: dir,
        profile: { pluginId: 'fixture', localId: 'default' }, input: { text: 'Use review' }, skills }, options(knobs[0]!), f.dependencies);
      try { expect(f.observe().env.COPILOT_SKILLS_DIRS).toBe(skills.skillsRoot); }
      finally { await runtime.dispose(); }
    });
  });
});

for (const knob of knobs) {
  const agent = declaredAgent(knob);
  let dir: string;
  let observer: ReturnType<typeof createAgentLaunchObserver>;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'happier-acp-public-skill-kit-')); await mkdir(join(dir, 'native-home')); observer = createAgentLaunchObserver({ home: join(dir, 'native-home') }); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  runAgentSkillDeliveryContract({ agent, async openSession(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
    const boundaries = observer.boundaries as AgentLaunchObserverBoundaries; boundaries.reset();
    const f = fixture(dir, { HOME: join(dir, 'native-home') });
    const runtime = await createPublicAcpSession(request, options(knob), f.dependencies);
    const actual = f.observe(); boundaries.recordLaunch(actual); boundaries.recordAcpSessionNew(actual.sessionNew);
    return runtime;
  }, observeLaunch: () => observer.observeLaunch() });
}

for (const agentId of ['copilot', 'qwen', 'codebuddy', 'devin']) {
  const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(candidate => candidate.pluginId === `happier.agent.${agentId}`);
  if (!locator) throw new Error('Expected a bundled Agent locator');
  const manifest = PluginManifestV2Schema.parse(readBundledPluginManifest(locator));
  const agent = manifest.contributes.agents?.find(candidate => candidate.id === agentId);
  if (!agent) throw new Error('Expected a bundled Agent declaration');
  let dir: string;
  let observer: ReturnType<typeof createAgentLaunchObserver>;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'happier-bundled-acp-skill-kit-')); await mkdir(join(dir, 'native-home')); observer = createAgentLaunchObserver({ home: join(dir, 'native-home') }); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  it(`projects the probed ${agentId} native carrier through the lazy declaration`, () => {
    expect('skills' in agent.capabilities ? agent.capabilities.skills?.delivery : undefined).toBe('session_dir');
    if ('runtime' in agent && agent.runtime.kind === 'acp') expect(agent.runtime.definition?.skills?.sessionDelivery).toBeDefined();
  });
  runAgentSkillDeliveryContract({ agent, async openSession(request) {
    const boundaries = observer.boundaries as AgentLaunchObserverBoundaries; boundaries.reset();
    const f = fixture(dir, { HOME: join(dir, 'native-home') });
    let runtime: AgentSessionRuntime;
    if ('runtime' in agent && agent.runtime.kind === 'acp') {
      runtime = await createPublicAcpSession(request, normalizePluginDeclarativeAcpRuntime(agent.runtime), f.dependencies);
    } else {
      const parsed = parsePluginManifest(manifest);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
      const host = await createPluginTestkit({ manifest: parsed.manifest, module: { activate: COPILOT_PLUGIN.activate } });
      const factory = host.registration('agents', agentId)?.factory;
      if (!factory) throw new Error('Expected the registered native ACP factory');
      const native = await factory({ plugin: { id: manifest.id, version: manifest.version }, agent: { id: agentId }, signal: f.dependencies.signal });
      if (!native.sessions) throw new Error('Expected a Session factory');
      const contextFixture = createAcpSessionRuntimeContextFixture({ agent, pluginId: manifest.id,
        pluginVersion: manifest.version, sessionId: request.sessionId, directory: request.cwd, signal: f.dependencies.signal,
        protocols: { acp: {
          open: (r, o) => createPublicAcpSession(r, o, f.dependencies),
          openExecutionRunV1: (r, o) => createPublicAcpExecutionRun(r, o, f.dependencies),
        } },
      });
      try {
        runtime = await native.sessions.open({ ...request, configuration: {
          mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: 'default', updatedAtMs: 1 }, options: {},
        } }, contextFixture.context);
      } catch (error) {
        try { await contextFixture.dispose(); } finally { await host.dispose(); }
        throw error;
      }
      const session = runtime;
      runtime = { ...session, async dispose() {
        try { await session.dispose(); } finally {
          try { await contextFixture.dispose(); } finally { await host.dispose(); }
        }
      } };
    }
    const actual = f.observe(); boundaries.recordLaunch(actual); boundaries.recordAcpSessionNew(actual.sessionNew);
    return runtime;
  }, observeLaunch: () => observer.observeLaunch() });
}
