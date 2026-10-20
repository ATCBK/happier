import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { canonicalAbsolutePathsEqual, canonicalizePath, isCanonicalAbsolutePathInsideRoot,
  resolveConfiguredNativeHomePath, resolveConfiguredPath } from '@happier-dev/plugin-sdk/fs';
import { resolveClaudeConfigDirEnvOverlay, resolveClaudeManagedConfigDir } from '../environment.js';

type ResolveRoots = NonNullable<AgentPreflightSessionControlsContributionV1['resolveNativePluginSkillRoots']>;
type PluginRoot = Awaited<ReturnType<ResolveRoots>>[number];

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Claude plugin record');
  return value as Record<string, unknown>;
}
async function readObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    if (!(await stat(path)).isFile()) throw new TypeError('Claude plugin configuration is not a regular file');
    return object(JSON.parse(await readFile(path, 'utf8')));
  }
  catch (error) { if (missing(error)) return null; throw error; }
}

/** The native registry stores project installs against the main checkout identity. */
async function projectDirectories(directory: string): Promise<readonly string[]> {
  const start = await canonicalizePath(directory);
  let current = start;
  while (true) {
    const git = join(current, '.git');
    try {
      const metadata = await lstat(git);
      if (metadata.isFile()) {
        const declaration = (await readFile(git, 'utf8')).match(/^gitdir:\s*(.+)\s*$/u);
        if (!declaration) throw new TypeError('Invalid Claude project worktree identity');
        const gitdir = resolve(current, declaration[1]!.trim());
        let common: string;
        try { common = resolve(gitdir, (await readFile(join(gitdir, 'commondir'), 'utf8')).trim()); }
        catch (error) { if (!missing(error)) throw error; return [current]; }
        let backlink: string;
        try { backlink = await realpath(resolve(gitdir, (await readFile(join(gitdir, 'gitdir'), 'utf8')).trim())); }
        catch (error) { if (!missing(error)) throw error; return [current]; }
        if (!canonicalAbsolutePathsEqual(dirname(gitdir), join(common, 'worktrees'))
          || !canonicalAbsolutePathsEqual(backlink, await realpath(git))) return [current];
        const main = await canonicalizePath(dirname(common));
        return canonicalAbsolutePathsEqual(main, current) ? [current] : [main, current];
      }
      return [current];
    } catch (error) { if (!missing(error)) throw error; }
    const parent = dirname(current);
    if (parent === current) return [start];
    current = parent;
  }
}

/** Read-only Found projection of installed_plugins v2 and effective enabledPlugins.
 * Cache contents and timestamps never establish installed or enabled identity.
 */
export const resolveClaudeNativePluginSkillRoots = async (input: Parameters<ResolveRoots>[0], environment = process.env): Promise<readonly PluginRoot[]> => {
  const env = { ...environment, HOME: input.homeDirectory, USERPROFILE: input.homeDirectory,
    ...resolveClaudeConfigDirEnvOverlay(environment) };
  const config = resolveConfiguredNativeHomePath({ environmentKey: 'CLAUDE_CONFIG_DIR', defaultRelativePath: '.claude' }, env);
  input.signal?.throwIfAborted();
  const pluginDirectory = environment.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim();
  const pluginsPath = pluginDirectory ? resolveConfiguredPath(pluginDirectory, { homeDir: input.homeDirectory,
    ...(input.directory ? { cwd: resolveConfiguredPath(input.directory, { homeDir: input.homeDirectory }) } : {}) }) : join(config, 'plugins');
  const installed = await readObject(join(pluginsPath, 'installed_plugins.json'));
  if (!installed) return [];
  if (installed.version !== 2) throw new TypeError('Unsupported Claude installed plugin registry');
  const plugins = object(installed.plugins);
  const userSettings = await readObject(join(config, 'settings.json'));
  const managedSettings = await readObject(join(resolveClaudeManagedConfigDir(process.platform, environment), 'managed-settings.json'));
  const directory = input.directory ? resolveConfiguredPath(input.directory, { homeDir: input.homeDirectory }) : null;
  const directories = directory ? await projectDirectories(directory) : [];
  async function enablement(projects: readonly string[]): Promise<Record<string, unknown>> {
    const settings = [userSettings];
    for (const name of ['settings.json', 'settings.local.json']) {
      for (const project of projects) settings.push(await readObject(join(project, '.claude', name)));
    }
    settings.push(managedSettings);
    return Object.assign({}, ...settings.map(settings => settings?.enabledPlugins === undefined ? {} : object(settings.enabledPlugins)));
  }
  const enabled = await enablement(directories);
  const roots: PluginRoot[] = [];
  for (const [id, value] of Object.entries(plugins)) {
    input.signal?.throwIfAborted();
    if (!Array.isArray(value)) throw new TypeError('Invalid Claude installed plugin records');
    for (const raw of value) {
      const entry = object(raw);
      let effective = enabled;
      if (entry.scope === 'project' || entry.scope === 'local') {
        if (typeof entry.projectPath !== 'string' || typeof entry.installPath !== 'string') throw new TypeError('Invalid Claude project plugin record');
        const project = await canonicalizePath(resolveConfiguredPath(entry.projectPath, { homeDir: input.homeDirectory }));
        if (!directories.some(path => canonicalAbsolutePathsEqual(path, project))) {
          // A Found download carries only its known path. Revalidate that exact
          // recorded install in its own project rather than granting a cache-wide read.
          if (directory || !input.skillPath) continue;
          const install = await canonicalizePath(resolveConfiguredPath(entry.installPath, { homeDir: input.homeDirectory }));
          const skill = await canonicalizePath(input.skillPath);
          if (!isCanonicalAbsolutePathInsideRoot(install, skill)) continue;
          effective = await enablement(await projectDirectories(project));
        }
      } else if (entry.scope !== 'user' && entry.scope !== 'managed') continue;
      if (effective[id] !== true) continue;
      if (typeof entry.installPath !== 'string' || !entry.installPath.trim()) throw new TypeError('Invalid Claude plugin install path');
      const installPath = resolveConfiguredPath(entry.installPath, { homeDir: input.homeDirectory });
      const pluginName = id.slice(0, id.indexOf('@') < 0 ? id.length : id.indexOf('@'));
      let confinementRoot: string;
      try { confinementRoot = await realpath(installPath); }
      catch {
        roots.push({ path: installPath, pluginName, confinementRoot: installPath, layout: 'collection', status: 'failed' }); break;
      }
      try {
        const manifestPath = join(confinementRoot, '.claude-plugin', 'plugin.json');
        let manifest: Record<string, unknown> | null = null;
        try {
          if (!isCanonicalAbsolutePathInsideRoot(confinementRoot, await realpath(manifestPath))) throw new TypeError('Claude plugin manifest leaves its install');
          manifest = await readObject(manifestPath);
        } catch (error) { if (!missing(error)) throw error; }
        const declared = manifest?.skills;
        if (declared !== undefined && typeof declared !== 'string' && !Array.isArray(declared)) throw new TypeError('Invalid Claude plugin skill roots');
        const paths: unknown[] = ['skills', ...(typeof declared === 'string' ? [declared] : declared ?? [])];
        // The native single-skill layout applies only without a skills declaration/directory.
        let hasDefault = false;
        try { hasDefault = (await stat(join(confinementRoot, 'skills'))).isDirectory(); }
        catch (error) { if (!missing(error)) throw error; }
        if (declared === undefined && !hasDefault) paths.push('.');
        for (const relative of new Set(paths)) {
          if (typeof relative !== 'string') throw new TypeError('Invalid Claude plugin skill path');
          const path = resolve(confinementRoot, relative);
          if (!isCanonicalAbsolutePathInsideRoot(confinementRoot, path)) {
            roots.push({ path, pluginName, confinementRoot, layout: 'collection', status: 'failed' }); continue;
          }
          let content: string;
          try { content = await realpath(path); }
          catch (error) { if (missing(error)) continue; throw error; }
          if (!isCanonicalAbsolutePathInsideRoot(confinementRoot, content)) {
            roots.push({ path, pluginName, confinementRoot, layout: 'collection', status: 'failed' }); continue;
          }
          let single = false;
          try { single = (await stat(join(content, 'SKILL.md'))).isFile(); }
          catch (error) { if (!missing(error)) throw error; }
          // Without a root SKILL.md the fallback '.' must not scan arbitrary plugin folders.
          if (relative === '.' && declared === undefined && !single) continue;
          roots.push({ path, pluginName, confinementRoot, layout: single ? 'skill' : 'collection', status: 'ok' });
        }
      } catch {
        roots.push({ path: confinementRoot, pluginName, confinementRoot, layout: 'collection', status: 'failed' });
      }
      // Native registry order chooses the applicable install, never cache age.
      break;
    }
  }
  input.signal?.throwIfAborted();
  return roots;
};
