import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanNativeSkillRoots } from './scanNativeSkillRoots';
import { buildPromptBundleBodyFromDirectory } from '@/prompts/assets/shared/promptBundleDirectory';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { SkillFoundListInputV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

async function createSkill(root: string, name: string) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Native\n---\nNative body`);
  return directory;
}

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
it('uses declared roots, walks only to the repository boundary and retains failed-root uncertainty', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-scan-')); homes.push(home);
  const root = join(home, 'repo'), directory = join(root, 'nested');
  await mkdir(join(root, '.git'), { recursive: true }); await mkdir(directory);
  const skill = async (parent: string, name: string) => {
    const dir = join(parent, name); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Native\n---\nNative body`);
  };
  await skill(join(root, '.skills'), 'project');
  await skill(join(home, '.skills'), 'above-repo');
  await skill(join(home, '.native'), 'user');
  await writeFile(join(home, '.unreadable'), 'A file cannot be scanned as a root');
  const result = await scanNativeSkillRoots({ home, directory, nativeRoots: { user: [['.native'], ['.unreadable']], project: [['.skills']] } });
  expect(result.status).toBe('failed');
  expect(result.names.map(item => item.name).sort()).toEqual(['project', 'user']);
  expect(result).toMatchObject({ roots: [join(home, '.unreadable')] });
});

it.each(['~/repo/nested', '~\\repo\\nested'])('expands the public Found directory against the captured machine home (%s)', async directory => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-home-')); homes.push(home);
  const repository = join(home, 'repo');
  await mkdir(join(repository, '.git'), { recursive: true });
  await mkdir(join(repository, 'nested'));
  const skillDirectory = await createSkill(join(repository, '.skills'), 'project');
  const request = SkillFoundListInputV1Schema.parse({ machineId: 'machine', directory });
  const found = await scanNativeSkillRoots({ purpose: 'found', home, directory: request.directory,
    agents: [{ agentId: 'claude', nativeRoots: { project: [['.skills']] } }] });
  expect(found.items.map(item => item.path)).toEqual([skillDirectory]);
});

it('aggregates shared Agent roots and hashes complete skill files and executable modes through the existing bundle owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-found-')); homes.push(home);
  const skillDirectory = await createSkill(join(home, '.shared'), 'shared');
  await mkdir(join(skillDirectory, 'scripts'));
  const script = join(skillDirectory, 'scripts', 'run.sh');
  await writeFile(script, '#!/bin/sh\necho first\n');
  await chmod(script, 0o644);
  await writeFile(join(home, '.unreadable'), 'A file cannot be scanned as a root');
  const repository = join(home, 'repo');
  const directory = join(repository, 'nested');
  await mkdir(join(repository, '.git'), { recursive: true });
  await mkdir(directory);
  const projectSkill = await createSkill(join(repository, '.project'), 'project');
  await createSkill(join(home, '.project'), 'above-repository');
  const input = { purpose: 'found' as const, home, directory, agents: [
    { agentId: 'first', nativeRoots: { user: [['.shared'], ['.unreadable']], project: [['.project']] } },
    { agentId: 'second', nativeRoots: { user: [['.shared']] } },
  ] };
  const before = await scanNativeSkillRoots(input);
  expect(before.roots).toEqual([
    { path: join(home, '.shared'), scope: 'user', agents: ['first', 'second'], status: 'ok' },
    { path: join(home, '.unreadable'), scope: 'user', agents: ['first'], status: 'failed' },
    { path: join(directory, '.project'), scope: 'project', agents: ['first'], status: 'ok' },
    { path: join(repository, '.project'), scope: 'project', agents: ['first'], status: 'ok' },
  ]);
  expect(before.items).toEqual([{ name: 'shared', description: 'Native', path: skillDirectory,
    digest: computePromptBundleDigestV1(buildPromptBundleBodyFromDirectory({ rootDirectory: skillDirectory })),
    agents: ['first', 'second'], scope: 'user', pluginOwned: null },
    { name: 'project', description: 'Native', path: projectSkill,
      digest: computePromptBundleDigestV1(buildPromptBundleBodyFromDirectory({ rootDirectory: projectSkill })),
      agents: ['first'], scope: 'project', pluginOwned: null },
  ]);
  await writeFile(script, '#!/bin/sh\necho other\n');
  const changedContent = await scanNativeSkillRoots(input);
  expect(changedContent.items[0]?.digest).not.toBe(before.items[0]?.digest);
  if (process.platform !== 'win32') {
    // Windows chmod does not expose POSIX executable-bit changes.
    await chmod(script, 0o755);
    const changedMode = await scanNativeSkillRoots(input);
    expect(changedMode.items[0]?.digest).not.toBe(changedContent.items[0]?.digest);
  }
});

it('selects the newest plugin version, confines plugin links and excludes plugin roots from masking', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-native-plugin-')); homes.push(home);
  const cache = join(home, '.claude', 'plugins', 'cache');
  const oldVersion = join(cache, 'market', 'fixture', 'old');
  const newVersion = join(cache, 'market', 'fixture', 'new');
  await createSkill(join(oldVersion, 'skills'), 'old');
  const newest = await createSkill(join(newVersion, 'skills'), 'new');
  await utimes(oldVersion, new Date(1000), new Date(1000));
  await utimes(newVersion, new Date(2000), new Date(2000));
  const outside = join(home, 'outside');
  await createSkill(join(outside, 'skills'), 'escaped');
  await symlink(outside, join(cache, 'market', 'fixture', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await createSkill(join(home, '.native'), 'native');
  const nativeRoots = { user: [['.native']], plugin: [['.claude', 'plugins', 'cache', '*', '{plugin}', '*', 'skills']] };
  const found = await scanNativeSkillRoots({ purpose: 'found', home, agents: [
    { agentId: 'claude', nativeRoots }, { agentId: 'other', nativeRoots: { plugin: nativeRoots.plugin } },
  ] });
  expect(found.items.map(item => ({ name: item.name, path: item.path, pluginOwned: item.pluginOwned }))).toEqual([
    { name: 'native', path: join(home, '.native', 'native'), pluginOwned: null },
    { name: 'new', path: newest, pluginOwned: { pluginName: 'fixture' } },
  ]);
  expect(found.roots).toEqual(expect.arrayContaining([
    { path: join(newVersion, 'skills'), scope: 'plugin', agents: ['claude', 'other'], status: 'ok' },
    expect.objectContaining({ scope: 'plugin', status: 'failed' }),
  ]));
  const masking = await scanNativeSkillRoots({ home, nativeRoots });
  expect(masking).toEqual({ status: 'ok', names: [{ name: 'native', path: join(home, '.native', 'native', 'SKILL.md'), root: join(home, '.native') }] });
});
