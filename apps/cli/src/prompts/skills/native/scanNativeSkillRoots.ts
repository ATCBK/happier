import type { PluginAgentSkillsCapabilityV2 } from '@happier-dev/protocol';
import type { NativeSkillScanV1 } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildPromptBundleBodyFromDirectory } from '@/prompts/assets/shared/promptBundleDirectory';
import { expandHomeDirPath, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

type NativeRoots = PluginAgentSkillsCapabilityV2['nativeRoots'];
type MaskingScanInput = Readonly<{ purpose?: 'masking'; nativeRoots: NativeRoots; directory?: string | null; home?: string }>;
export type FoundNativeSkillScanInput = Readonly<{
  purpose: 'found'; agents: readonly Readonly<{ agentId: string; nativeRoots: NativeRoots }>[];
  directory?: string | null; home?: string;
}>;
export type FoundNativeSkillRoot = Readonly<{
  path: string; scope: 'user' | 'project' | 'plugin'; agents: readonly string[]; status: 'ok' | 'failed';
}>;
export type FoundNativeSkillItem = Readonly<{
  name: string; description: string | null; path: string; digest: string; userInvocable: boolean;
  agents: readonly string[]; scope: FoundNativeSkillRoot['scope']; pluginOwned: Readonly<{ pluginName: string }> | null;
}>;
export type FoundNativeSkillScan = Readonly<{ roots: readonly FoundNativeSkillRoot[]; items: readonly FoundNativeSkillItem[] }>;
type ScanRoot = {
  path: string; scope: FoundNativeSkillRoot['scope']; agents: string[]; status: 'ok' | 'failed';
  pluginName: string | null; confinementRoot?: string;
};

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
}

async function resolveContentRoot(path: string, confinementRoot?: string): Promise<string> {
  const contentRoot = await realpath(path);
  if (confinementRoot && !isCanonicalAbsolutePathInsideRoot(confinementRoot, contentRoot)) {
    throw new Error('Plugin skill path leaves its declared cache root');
  }
  return contentRoot;
}

/** Expand only declared directory segments; vendor manifests never decide discovery. */
async function expandPluginRoots(home: string, pattern: readonly string[]): Promise<Array<{
  path: string; status: 'ok' | 'failed'; pluginName: string | null; confinementRoot: string;
}>> {
  const dynamicIndex = pattern.findIndex(segment => segment === '*' || segment === '{plugin}');
  const base = join(home, ...pattern.slice(0, dynamicIndex < 0 ? pattern.length : dynamicIndex));
  let confinementRoot: string;
  try { confinementRoot = await realpath(base); }
  catch (error) { return [{ path: base, status: missing(error) ? 'ok' : 'failed', pluginName: null, confinementRoot: base }]; }
  const failures: Array<{ path: string; status: 'failed'; pluginName: string | null; confinementRoot: string }> = [];
  let candidates: Array<{ path: string; pluginName: string | null; modifiedAtMs: number }> = [{ path: base, pluginName: null, modifiedAtMs: 0 }];
  for (const segment of pattern.slice(dynamicIndex < 0 ? pattern.length : dynamicIndex)) {
    const next: typeof candidates = [];
    for (const candidate of candidates) {
      let children: string[];
      try { children = segment === '*' || segment === '{plugin}' ? (await readdir(candidate.path)).sort() : [segment]; }
      catch (error) {
        if (!missing(error)) failures.push({ path: candidate.path, status: 'failed', pluginName: candidate.pluginName, confinementRoot });
        continue;
      }
      for (const child of children) {
        const path = join(candidate.path, child);
        try {
          const contentRoot = await resolveContentRoot(path, confinementRoot);
          const metadata = await stat(contentRoot);
          if (!metadata.isDirectory()) continue;
          next.push({ path, pluginName: segment === '{plugin}' ? child : candidate.pluginName,
            modifiedAtMs: segment === '*' && candidate.pluginName !== null ? metadata.mtimeMs : candidate.modifiedAtMs });
        } catch (error) {
          if (!missing(error)) failures.push({ path, status: 'failed', pluginName: candidate.pluginName, confinementRoot });
        }
      }
    }
    candidates = next;
  }
  const newest = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    if (candidate.pluginName === null) {
      failures.push({ path: candidate.path, status: 'failed', pluginName: null, confinementRoot });
      continue;
    }
    const incumbent = newest.get(candidate.pluginName);
    if (!incumbent || candidate.modifiedAtMs > incumbent.modifiedAtMs) newest.set(candidate.pluginName, candidate);
  }
  return [...failures, ...[...newest.values()].map(candidate => ({ path: candidate.path, status: 'ok' as const,
    pluginName: candidate.pluginName, confinementRoot }))];
}

/** Masking reads only the Agent's declared user/project roots; plugin-owned roots belong to Found. */
export function scanNativeSkillRoots(input: MaskingScanInput): Promise<NativeSkillScanV1>;
export function scanNativeSkillRoots(input: FoundNativeSkillScanInput): Promise<FoundNativeSkillScan>;
export async function scanNativeSkillRoots(input: MaskingScanInput | FoundNativeSkillScanInput): Promise<NativeSkillScanV1 | FoundNativeSkillScan> {
  const agents = input.purpose === 'found' ? input.agents : [{ agentId: '', nativeRoots: input.nativeRoots }];
  const home = input.home ?? homedir();
  const roots = new Map<string, ScanRoot>();
  function addRoot(path: string, scope: ScanRoot['scope'], agentIds: readonly string[], options?: Partial<Pick<ScanRoot, 'status' | 'pluginName' | 'confinementRoot'>>) {
    const key = resolve(path);
    let root = roots.get(key);
    if (!root) {
      root = { path, scope, agents: [], status: 'ok', pluginName: null, ...options };
      roots.set(key, root);
    } else if (options?.status === 'failed') root.status = 'failed';
    for (const agentId of agentIds) if (agentId && !root.agents.includes(agentId)) root.agents.push(agentId);
  }
  for (const agent of agents) for (const segments of agent.nativeRoots?.user ?? []) addRoot(join(home, ...segments), 'user', [agent.agentId]);
  const failed: string[] = [];
  if (input.directory) {
    let directory = resolve(expandHomeDirPath(input.directory, { ...process.env, HOME: home, USERPROFILE: home }));
    while (true) {
      for (const agent of agents) for (const segments of agent.nativeRoots?.project ?? []) addRoot(join(directory, ...segments), 'project', [agent.agentId]);
      try { await lstat(join(directory, '.git')); break; }
      catch (error) {
        if (!missing(error)) {
          failed.push(directory);
          if (input.purpose === 'found') addRoot(directory, 'project', agents.filter(agent => agent.nativeRoots?.project?.length).map(agent => agent.agentId), { status: 'failed' });
          break;
        }
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if (input.purpose === 'found') {
    const patterns = new Map<string, { pattern: readonly string[]; agentIds: string[] }>();
    for (const agent of agents) for (const pattern of agent.nativeRoots?.plugin ?? []) {
      const key = JSON.stringify(pattern);
      let declaration = patterns.get(key);
      if (!declaration) {
        declaration = { pattern, agentIds: [] };
        patterns.set(key, declaration);
      }
      if (!declaration.agentIds.includes(agent.agentId)) declaration.agentIds.push(agent.agentId);
    }
    for (const { pattern, agentIds } of patterns.values()) for (const root of await expandPluginRoots(home, pattern)) addRoot(root.path, 'plugin', agentIds, root);
  }
  const names: Array<{ name: string; path: string; root: string }> = [];
  const items: FoundNativeSkillItem[] = [];
  for (const root of roots.values()) {
    if (root.status === 'failed') continue;
    let children: string[];
    try { children = await readdir(root.path); }
    catch (error) {
      if (missing(error)) continue;
      root.status = 'failed'; failed.push(root.path); continue;
    }
    for (const child of children.sort()) {
      const skillDirectory = join(root.path, child);
      const path = join(skillDirectory, 'SKILL.md');
      try {
        const contentRoot = input.purpose === 'found' ? await resolveContentRoot(skillDirectory, root.confinementRoot) : null;
        if (root.confinementRoot) await resolveContentRoot(path, root.confinementRoot);
        const frontmatter = readSkillFrontmatterV1(await readFile(path, 'utf8'));
        // Native Agents may accept names outside the library's authoring pattern.
        const name = frontmatter.name ?? child;
        names.push({ name, path, root: root.path });
        if (contentRoot) items.push({ name, description: frontmatter.description ?? null, path: skillDirectory, userInvocable: frontmatter.userInvocable,
          digest: computePromptBundleDigestV1(buildPromptBundleBodyFromDirectory({ rootDirectory: contentRoot, preferredFirstPath: 'SKILL.md' })),
          agents: [...root.agents], scope: root.scope, pluginOwned: root.pluginName === null ? null : { pluginName: root.pluginName } });
      } catch (error) {
        if (error && typeof error === 'object' && ['ENOENT', 'ENOTDIR'].includes(String(Reflect.get(error, 'code')))) continue;
        root.status = 'failed';
        if (!failed.includes(root.path)) failed.push(root.path);
      }
    }
  }
  if (input.purpose === 'found') return { roots: [...roots.values()].map(({ path, scope, agents, status }) => ({ path, scope, agents, status })), items };
  return failed.length > 0 ? { status: 'failed', roots: [...new Set(failed)], names } : { status: 'ok', names };
}
