#!/usr/bin/env node

// @ts-check

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  commandExists,
  execOrThrow,
  normalizeChannel,
  parseArgs,
  readVersionFromPackageJson,
  resolveRepoRoot,
  resolvePnpmCommand,
} from './lib/binary-release.mjs';
import { createUiWebReleaseArtifacts } from './lib/ui-web-bundle.mjs';
import {
  formatBrowserIrohAssetVerification,
  verifyBrowserIrohAssets,
} from '../../../apps/ui/tools/iroh/browserIrohAssetPackaging.mjs';

async function main() {
  const repoRoot = resolveRepoRoot();
  const { kv, flags } = parseArgs(process.argv.slice(2));

  if (!commandExists('tar')) {
    throw new Error('[release] tar is required to build the ui web bundle artifact');
  }

  const channel = normalizeChannel(kv.get('--channel'));
  const version = String(kv.get('--version') ?? '').trim()
    || readVersionFromPackageJson(join(repoRoot, 'apps', 'ui', 'package.json'));

  const outDir = String(kv.get('--out-dir') ?? '').trim() || join(repoRoot, 'dist', 'release-assets', 'ui-web');
  const requestedDistDir = String(kv.get('--dist-dir') ?? '').trim();
  const skipBuild = flags.has('--skip-build');
  const ownsTemporaryDist = !skipBuild && !requestedDistDir;
  let distDir = requestedDistDir
    ? resolve(repoRoot, requestedDistDir)
    : join(repoRoot, 'apps', 'ui', 'dist');

  if (ownsTemporaryDist) {
    const releaseWorkDir = join(repoRoot, 'dist', 'release-work');
    await mkdir(releaseWorkDir, { recursive: true });
    distDir = await mkdtemp(join(releaseWorkDir, 'ui-web-dist-'));
  }

  let result;
  try {
    if (!skipBuild) {
      // Metro resolves authored workspace exports. Prepare the source plugin-UI
      // byte inventory through the canonical UI owner before exporting.
      await execOrThrow(process.execPath, ['apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: process.env.CI ?? '1',
          EXPO_UNSTABLE_WEB_MODAL: '1',
        },
      });

      const pnpm = resolvePnpmCommand({});
      await execOrThrow(
        pnpm.cmd,
        [...pnpm.args, '--dir', 'apps/ui', 'exec', 'expo', 'export', '--platform', 'web', '--output-dir', distDir],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CI: process.env.CI ?? '1',
            EXPO_UNSTABLE_WEB_MODAL: '1',
          },
        },
      );

      // Lane 06 A8: the browser Iroh SharedWorker and the generated wasm-bindgen
      // boundary are staged into THIS build's web output, after the export
      // produced it. They are never staged into a source tree the export copies:
      // Tauri/desktop and native exports read that same tree, keep the native Iroh
      // implementation, and must not inherit a browser wasm endpoint. The producer
      // verifies the bytes it wrote and fails the release if they do not match.
      await execOrThrow(
        process.execPath,
        ['apps/ui/tools/iroh/buildBrowserIrohAssets.mjs', '--output-dir', distDir],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CI: process.env.CI ?? '1',
          },
        },
      );
    } else {
      // `--skip-build` consumes the caller's prebuilt web output as-is: no wasm
      // toolchain, no writes. It is still read and checked, because bytes the
      // build did not produce would be served exactly as readily as ones it did.
      const verification = verifyBrowserIrohAssets({ outputRoot: distDir });
      if (verification.status !== 'ok') {
        throw new Error(`[release] ${formatBrowserIrohAssetVerification(verification)}`);
      }
    }

    result = await createUiWebReleaseArtifacts({
      version,
      distDir,
      outDir,
    });
  } finally {
    if (ownsTemporaryDist) {
      await rm(distDir, { recursive: true, force: true });
    }
  }

  console.log(JSON.stringify({ ...result, channel }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
