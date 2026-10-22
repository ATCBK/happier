import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveNpmCommandInvocation, resolvePnpmCommandInvocation } from '../workspaces/execPnpmCommand.mjs';
import { withDependencyRefreshLock } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';

const repoDir = resolve(process.argv[2] ?? process.cwd());
const { packageManager } = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
const pin = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([a-f0-9]{128})$/i.exec(packageManager ?? '');
if (!pin) throw new Error('Root packageManager must pin an exact pnpm version with SHA512 integrity');
const [, version, integrity] = pin;
const temporaryDir = mkdtempSync(join(tmpdir(), 'happier-setup-pnpm-'));

function run(invocation, stdio = 'inherit', cwd = repoDir) {
  return execFileSync(invocation.command, invocation.args, {
    cwd,
    stdio,
    encoding: 'utf8',
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

function installedVersionMatches() {
  try {
    // Query outside the workspace so a different manager cannot switch itself
    // to the declared version and conceal the executable that is installed.
    return run(resolvePnpmCommandInvocation(['--version'], { preferPath: true }), 'pipe', temporaryDir).trim() === version;
  } catch {
    return false;
  }
}

try {
  // npm ships with Node even where Corepack does not (Node 25+). Verify the
  // registry archive against the root pin before running its native installer.
  const packed = JSON.parse(run(resolveNpmCommandInvocation([
    'pack', `pnpm@${version}`, '--ignore-scripts', '--json', '--pack-destination', temporaryDir,
  ], { npmExecPath: process.env.npm_execpath }), 'pipe'));
  const archivePath = join(temporaryDir, packed[0].filename);
  const actualIntegrity = createHash('sha512').update(readFileSync(archivePath)).digest('hex');
  if (actualIntegrity !== integrity.toLowerCase()) throw new Error('pnpm archive integrity mismatch');
  if (!installedVersionMatches()) {
    // The existing dependency owner serializes cold setup with dependency
    // consumers. Warm launches must not replace pnpm's live node-gyp payload.
    await withDependencyRefreshLock({ installDir: repoDir }, async () => {
      if (!installedVersionMatches()) {
        run(resolveNpmCommandInvocation(['install', '--global', archivePath], { npmExecPath: process.env.npm_execpath }));
      }
      if (!installedVersionMatches()) throw new Error(`Expected installed pnpm ${version}`);
    });
  }
  console.log(`pnpm ${version} ready; root archive integrity verified`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
