import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readWorkspacePackages, createWorkspaceSourceResolver } from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';

const repoRoot = process.cwd(); const run = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), 'happier-index-native-source-'));
const workspacePackages = await readWorkspacePackages(repoRoot);
const common = { absWorkingDir: repoRoot, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    conditions: ['happier-source'], alias: { '@': join(repoRoot, 'apps/cli/src') },
    banner: { js: "import {createRequire as __nativeCreateRequire} from 'node:module'; const require=__nativeCreateRequire(import.meta.url);" },
    plugins: [createWorkspaceSourceResolver({ workspacePackages, requireFromProject: createRequire(join(repoRoot, 'apps/cli/package.json')), externalPackages: [] })] };
try {
    const probe = join(scratch, 'probe.mjs');
    await build({ ...common, entryPoints: [resolve('apps/cli/src/storage/scan/scan.native.mjs')], outfile: probe });
    const stage = join(scratch, 'stage.mjs');
    await build({ ...common, stdin: { resolveDir: repoRoot, contents:
        `export { stageProcessCustodyRuntime } from './packages/cli-common/src/componentArtifacts/stageProcessCustodyRuntime.ts';
         export { CLI_BINARY_TARGETS, resolveCurrentBinaryTarget } from './packages/cli-common/src/componentArtifacts/targets.ts';` }, outfile: stage });
    const { stageProcessCustodyRuntime, CLI_BINARY_TARGETS, resolveCurrentBinaryTarget } = await import(pathToFileURL(stage).href);
    const windows = process.argv.includes('--windows');
    const target = windows ? CLI_BINARY_TARGETS.find(value => value.os === 'windows') : resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS });
    await stageProcessCustodyRuntime({ repoRoot, payloadDir: scratch, target, runCommand: async (command, args, options) =>
        run(command, args, { cwd: options?.cwd, env: options?.env, maxBuffer: 16 * 1024 * 1024 }) });
    if (windows) {
        const source = (await run('wslpath', ['-w', scratch])).stdout.trim().replaceAll("'", "''");
        const script = `$ErrorActionPreference='Stop'; $probeRoot=Join-Path ([IO.Path]::GetTempPath()) ('happier-index-native-'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $probeRoot | Out-Null; try { Copy-Item -LiteralPath '${source}\\probe.mjs' -Destination $probeRoot; Copy-Item -LiteralPath '${source}\\tools' -Destination $probeRoot -Recurse; $env:HAPPIER_TEST_SCAN_PAYLOAD_DIR=$probeRoot; & (Get-Command node.exe -ErrorAction Stop).Source --test (Join-Path $probeRoot 'probe.mjs'); $probeExit=$LASTEXITCODE; if ($probeExit -ne 0) { throw ('Native index probe failed '+$probeExit) } } finally { Remove-Item -LiteralPath $probeRoot -Recurse -Force; Write-Output 'OWNED_FIXTURE_REMOVED' }`;
        const result = await run('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 16 * 1024 * 1024 });
        process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    } else {
        const result = await run(process.execPath, ['--test', probe], { env: { ...process.env, HAPPIER_TEST_SCAN_PAYLOAD_DIR: scratch }, maxBuffer: 16 * 1024 * 1024 });
        process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    }
} catch (error) {
    if (error.stdout) process.stdout.write(error.stdout); if (error.stderr) process.stderr.write(error.stderr); throw error;
} finally { await rm(scratch, { recursive: true, force: true }); }
