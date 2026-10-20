import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CLAUDE_PLUGIN } from '@happier-dev/plugins-claude/manifest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { scanNativeSkillRoots } from './scanNativeSkillRoots';
import { readFoundSkillBundle } from './resolveFoundSkillDownloadSource';
import { resolveAgentFoundSkillSources } from '@/agent/skills/resolveAgentSkillsCapability';

const homes: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });

async function fixture() {
  vi.stubEnv('CLAUDE_CONFIG_DIR', ''); vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '');
  vi.stubEnv('CLAUDE_CODE_PLUGIN_CACHE_DIR', '');
  const home = await mkdtemp(join(tmpdir(), 'happier-claude-found-')); homes.push(home);
  const config = join(home, '.claude');
  await mkdir(join(config, 'plugins'), { recursive: true });
  const plugin = await createPluginTestkit({ manifest: CLAUDE_PLUGIN.manifest, module: CLAUDE_PLUGIN });
  const admitted = ingestPluginManifestV2(CLAUDE_PLUGIN.manifest);
  if (!admitted.ok) throw new Error('Invalid Agent manifest fixture');
  const controls = plugin.registration('agents', 'claude')!.preflightSessionControls!;
  let current = true;
  const projected = projectAgentPreflightSessionControlsCatalogEntry({ agentId: 'claude', preflightSessionControls: controls,
    systemTools: [{ id: 'claude-cli', title: 'Claude', executableNames: ['claude'] }],
    retirementSignal: new AbortController().signal, isCurrent: () => current });
  const agents = resolveAgentFoundSkillSources({ catalogEntriesById: { claude: { ...projected,
    skills: admitted.manifest.contributes.agents[0]!.capabilities.skills } } });
  async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value)); }
  async function skill(root: string, name: string) {
    const path = join(root, name); await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\n---\nFixture`); return path;
  }
  return { home, config, json, skill, dispose: () => plugin.dispose(), retire: () => { current = false; },
    download: (path: string) => readFoundSkillBundle({ request: { path }, home, agents }),
    scan: (directory?: string) => scanNativeSkillRoots({ purpose: 'found', home, directory, agents }) };
}

it('uses enabled installed records rather than newer cache directories and reads confined manifest roots', async () => {
  const f = await fixture();
  try {
    const cache = join(f.config, 'plugins', 'cache', 'market');
    const installed = join(cache, 'fixture', 'installed');
    const stale = join(cache, 'fixture', 'newer-but-uninstalled');
    const disabled = join(cache, 'disabled', 'v1');
    await f.skill(join(installed, 'skills'), 'default');
    await f.skill(join(installed, 'custom'), 'extra');
    await f.skill(join(stale, 'skills'), 'stale');
    await f.skill(join(disabled, 'skills'), 'disabled');
    await mkdir(join(installed, '.claude-plugin'));
    await f.json(join(installed, '.claude-plugin', 'plugin.json'), { name: 'fixture', skills: ['./custom'] });
    await utimes(installed, new Date(1000), new Date(1000));
    await utimes(stale, new Date(2000), new Date(2000));
    await f.json(join(f.config, 'settings.json'), { enabledPlugins: { 'fixture@market': true, 'disabled@market': false } });
    await f.json(join(f.config, 'plugins', 'installed_plugins.json'), { version: 2, plugins: {
      'fixture@market': [{ scope: 'user', installPath: installed }],
      'disabled@market': [{ scope: 'user', installPath: disabled }],
    } });
    expect((await f.scan()).items.map(item => item.name).sort()).toEqual(['default', 'extra']);
    const outside = await f.skill(join(f.home, 'outside'), 'escape');
    await symlink(outside, join(installed, 'custom', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const confined = await f.scan();
    expect(confined.items.map(item => item.name).sort()).toEqual(['default', 'extra']);
    expect(confined.roots).toContainEqual(expect.objectContaining({ scope: 'plugin', status: 'failed' }));
    f.retire();
    expect((await f.scan()).roots).toContainEqual(expect.objectContaining({ scope: 'plugin', status: 'failed' }));
  } finally { await f.dispose(); }
});

it('supports single-skill manifest roots in the selected config home and retains invalid-registry uncertainty', async () => {
  const f = await fixture();
  try {
    const alternate = join(f.home, 'alternate');
    vi.stubEnv('CLAUDE_CONFIG_DIR', alternate);
    const plugins = join(f.home, 'plugin-cache');
    vi.stubEnv('CLAUDE_CODE_PLUGIN_CACHE_DIR', plugins);
    const install = join(plugins, 'cache', 'selected');
    await mkdir(alternate);
    await mkdir(join(install, '.claude-plugin'), { recursive: true });
    const path = await f.skill(install, 'one');
    await f.json(join(install, '.claude-plugin', 'plugin.json'), { name: 'selected', skills: ['./one', '../../escape'] });
    await f.json(join(alternate, 'settings.json'), { enabledPlugins: { 'selected@market': true } });
    const registry = join(plugins, 'installed_plugins.json');
    await f.json(registry, { version: 2, plugins: { 'selected@market': [{ scope: 'user', installPath: install }] } });
    expect((await f.scan()).items.map(item => item.path)).toEqual([path]);
    expect(await f.download(path)).toMatchObject({ name: 'one', pluginOwned: { pluginName: 'selected' } });
    await writeFile(registry, 'invalid');
    const unknown = await f.scan();
    expect(unknown.items).toEqual([]);
    expect(unknown.roots).toContainEqual(expect.objectContaining({ scope: 'plugin', status: 'failed' }));
  } finally { await f.dispose(); }
});

it('resolves project and local install scope against linked worktree identity and effective enablement', async () => {
  const f = await fixture();
  try {
    const project = join(f.home, 'project'), worktree = join(f.home, 'worktree'), other = join(f.home, 'other');
    const gitdir = join(project, '.git', 'worktrees', 'branch');
    await mkdir(gitdir, { recursive: true }); await mkdir(worktree); await mkdir(other);
    await mkdir(join(project, '.claude'));
    await mkdir(join(worktree, 'nested'));
    await writeFile(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
    await writeFile(join(gitdir, 'commondir'), '../..\n');
    await writeFile(join(gitdir, 'gitdir'), join(worktree, '.git') + '\n');
    const paths = Object.fromEntries(['user', 'project', 'local', 'foreign'].map(name => [name, join(f.home, 'installs', name)]));
    for (const [name, path] of Object.entries(paths)) await f.skill(join(path, 'skills'), name);
    await f.json(join(f.config, 'settings.json'), { enabledPlugins: { 'user@market': true, 'project@market': false,
      'local@market': true, 'foreign@market': true } });
    await f.json(join(project, '.claude', 'settings.json'), { enabledPlugins: { 'project@market': true, 'user@market': false } });
    await f.json(join(f.config, 'plugins', 'installed_plugins.json'), { version: 2, plugins: {
      'user@market': [{ scope: 'user', installPath: paths.user }],
      'project@market': [{ scope: 'project', projectPath: project, installPath: paths.project }],
      'local@market': [{ scope: 'local', projectPath: project, installPath: paths.local }],
      'foreign@market': [{ scope: 'project', projectPath: other, installPath: paths.foreign }],
    } });
    expect((await f.scan(join(worktree, 'nested'))).items.map(item => item.name).sort()).toEqual(['local', 'project']);
    expect((await f.scan()).items.map(item => item.name)).toEqual(['user']);
    expect(await f.download(join(paths.project!, 'skills', 'project'))).toMatchObject({ name: 'project',
      pluginOwned: { pluginName: 'project' } });
    await f.json(join(project, '.claude', 'settings.local.json'), { enabledPlugins: { 'project@market': false } });
    await expect(f.download(join(paths.project!, 'skills', 'project'))).rejects.toMatchObject({ code: 'not_found' });
  } finally { await f.dispose(); }
});
