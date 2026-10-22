#!/usr/bin/env node
// One-off cutover transform. Run after migratePnpmConfig.mjs and before regenerating pnpm-lock.yaml.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectWorkspacePackageJsonPaths } from '../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageManagerCommands = new Set(['install', 'add', 'remove', 'publish', 'pack', 'version', 'link', 'unlink', 'config', 'cache', 'list', 'why', 'exec', 'run']);

export function migrateScript(script, { scripts = {}, manifestsByName = new Map(), manifestPath = '', manifestsByPath = new Map() } = {}) {
  let output = script.replace(/\$npm_execpath\b/g, 'pnpm');
  const postinstallStart = 'const run=(cmd,args)=>cp.spawnSync(cmd,args,{stdio:\'inherit\'});const npmExec=process.env.npm_execpath;';
  if (output.includes(postinstallStart)) {
    const start = output.indexOf(postinstallStart);
    const end = output.lastIndexOf('process.exit(r.status??1);');
    if (end < start) throw new Error(`Unrecognized inline postinstall in ${manifestPath}`);
    output = output.slice(0, start).replace("const cp=require('child_process');", '')
      + "import('../../scripts/workspaces/execPnpmCommand.mjs').then(({execPnpm})=>{execPnpm(['--silent','run','postinstall:real'],{stdio:'inherit'});}).catch(error=>{console.error(error.message);process.exit(error.status??1);});"
      + output.slice(end + 'process.exit(r.status??1);'.length);
  }
  // Match command words only. In particular --yarn is a separate authored CLI flag.
  output = output.replace(/\b(?:corepack\s+)?yarn\s+((?:(?:--cwd\s+[^\s&|;]+|--silent|-s)\s+)*)(?:workspace\s+([^\s&|;]+)\s+)?([^\s&|;]+)/g, (_match, flags, workspace, command) => {
    const cwd = flags.match(/--cwd\s+([^\s&|;]+)/)?.[1];
    const quiet = /(?:^|\s)(?:-s|--silent)(?:\s|$)/.test(flags);
    const target = workspace ? manifestsByName.get(workspace) : cwd ? manifestsByPath.get(resolve(dirname(manifestPath), cwd)) : { scripts };
    const verb = packageManagerCommands.has(command) ? '' : target?.scripts?.[command] ? 'run ' : 'exec ';
    return ['pnpm', cwd && `--dir ${cwd}`, workspace && `--filter ${workspace}`, quiet && '--silent', verb + command].filter(Boolean).join(' ');
  });
  // npm_execpath uses above refer only to this repository's selected manager.
  output = output.replace(/\bpnpm (?!run\b)(test)(?=\s|$)/g, 'pnpm run $1');
  // Legacy package scripts used an install fallback; the repository has one package manager.
  output = output.replace(/\byarn\s*\|\|\s*npm(?:\s+install)?/g, 'pnpm install');
  output = output.replaceAll('scripts/workspaces/execYarnCommand.test.mjs', 'scripts/workspaces/execPnpmCommand.test.mjs')
    .replaceAll('scripts/workspaces/bundleWorkspaceDeps.execYarn.contract.test.mjs', 'scripts/workspaces/bundleWorkspaceDeps.execPnpm.contract.test.mjs');
  return output;
}

export async function migratePnpmScripts() {
  // Include new source manifests while excluding ignored installs and author-build outputs.
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'package.json', '**/package.json'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(path => path && !path.startsWith('dagger/')).map(path => resolve(root, path));
  const manifests = await Promise.all(paths.map(async path => ({ path, manifest: JSON.parse(await readFile(path, 'utf8')) })));
  const workspacePaths = new Set(await collectWorkspacePackageJsonPaths(root));
  const manifestsByName = new Map(manifests.filter(({ path }) => workspacePaths.has(path))
    .map(({ manifest }) => [manifest.name, manifest]));
  const manifestsByPath = new Map(manifests.map(({ path, manifest }) => [dirname(path), manifest]));
  const changed = [];
  for (const { path } of manifests) {
    // Other lanes own dependencies and workspace configuration. Preserve their latest bytes.
    const source = await readFile(path, 'utf8');
    const manifest = JSON.parse(source);
    let updated = source;
    for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
      const migrated = migrateScript(script, { scripts: manifest.scripts, manifestsByName, manifestsByPath, manifestPath: path });
      if (migrated !== script) {
        const oldEntry = `${JSON.stringify(name)}: ${JSON.stringify(script)}`;
        const newEntry = `${JSON.stringify(name)}: ${JSON.stringify(migrated)}`;
        if (!updated.includes(oldEntry)) throw new Error(`Cannot locate script ${name} in ${path}`);
        updated = updated.replace(oldEntry, newEntry);
      }
    }
    if (updated !== source) {
      await writeFile(path, updated);
      changed.push(path.slice(root.length + 1));
    }
  }
  console.log(JSON.stringify({ changed }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await migratePnpmScripts();
