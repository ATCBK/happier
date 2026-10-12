#!/usr/bin/env node

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import './localSourceRuntimeBootstrap.mjs';

const { isBundledWorkspaceRuntimeInvocation, refreshLocalBundledWorkspacePackages } = await import('./localBundledWorkspacePreflight.mjs');

const cliRootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const runtimeRequested = isBundledWorkspaceRuntimeInvocation(argv);
if (!runtimeRequested) {
  await refreshLocalBundledWorkspacePackages(cliRootDir, { argv });
}

await import('../scripts/happier_main.mjs');
