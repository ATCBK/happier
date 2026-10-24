import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startVitest } from 'vitest/node';
import type { Plugin, TestProjectConfiguration } from 'vitest/config';

import { runPnpmCommand } from './lib/runPnpmCommand.ts';
import type { WorkspaceManifest } from './lib/workspaceManifests.ts';
import { resolveVitestPoolEnv, resolveVitestWorkers } from './vitestWorkers.ts';

const cwdSetup = fileURLToPath(new URL('./vitestProjectCwd.mjs', import.meta.url));

async function createProject(rootDir: string, workspace: WorkspaceManifest): Promise<TestProjectConfiguration> {
  const root = resolve(rootDir, workspace.workspaceDirectory);
  // Current package-owned configs are vitest.config.ts. Packages without one
  // use the same root baseline as their standalone Vitest command.
  let configPath = resolve(root, 'vitest.config.ts');
  try {
    await access(configPath);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    configPath = resolve(rootDir, 'vitest.config.ts');
  }
  const cwdPlugin: Plugin = {
    name: 'happier-package-test-cwd',
    config(config) {
      const test = config.test ?? (config.test = {});
      const setupFiles = test.setupFiles;
      // Vite's normal deep merge appends arrays. Mutate here so cwd is already
      // correct during existing setup imports, not only inside test bodies.
      test.setupFiles = [cwdSetup, ...(Array.isArray(setupFiles) ? setupFiles : setupFiles ? [setupFiles] : [])];
      test.sequence = { ...test.sequence, setupFiles: 'list' };
      test.pool = 'forks';
      test.isolate = true;
    },
  };
  return {
    extends: configPath,
    root,
    plugins: [cwdPlugin],
    test: {
      name: workspace.packageName ?? workspace.workspaceDirectory,
      env: { HAPPIER_VITEST_PROJECT_ROOT: root },
    },
  };
}

/** Combine the per-project Vitest JSON reports into the single report CI consumes. */
async function mergeJsonReports(parts: readonly string[], output: string): Promise<void> {
  const merged: Record<string, unknown> & { testResults: unknown[]; success: boolean } = { testResults: [], success: true };
  for (const part of parts) {
    const report = JSON.parse(await readFile(part, 'utf8')) as Record<string, unknown>;
    for (const [key, value] of Object.entries(report)) {
      if (key === 'testResults' && Array.isArray(value)) merged.testResults.push(...value);
      else if (key === 'success') merged.success &&= value === true;
      else if (key === 'startTime' && typeof value === 'number') merged[key] = Math.min(value, typeof merged[key] === 'number' ? merged[key] : value);
      else if (typeof value === 'number') merged[key] = (typeof merged[key] === 'number' ? merged[key] : 0) + value;
      else if (!(key in merged)) merged[key] = value;
    }
    await rm(part, { force: true });
  }
  await writeFile(output, JSON.stringify(merged));
}

/** One Vitest instance per project; package manifests retain ownership of non-Vitest checks. */
export async function runWorkspaceUnitProjects(options: {
  rootDir: string;
  workspaces: readonly WorkspaceManifest[];
  filters?: readonly string[];
}): Promise<void> {
  if (options.workspaces.length === 0) throw new Error('No unit test workspaces were selected.');
  const failures: string[] = [];
  const ready: WorkspaceManifest[] = [];
  const runHook = async (workspace: WorkspaceManifest, hook: string): Promise<boolean> => {
    if (workspace.scripts[hook] === undefined) return true;
    try {
      await runPnpmCommand({
        id: workspace.packageName ?? workspace.workspaceDirectory,
        args: ['--dir', resolve(options.rootDir, workspace.workspaceDirectory), 'run', '--silent', hook],
      }, options.rootDir);
      return true;
    } catch (error) {
      failures.push(`${workspace.workspaceDirectory} ${hook}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  for (const workspace of options.workspaces) {
    if (workspace.invalidReason !== null) throw new Error(`Invalid workspace metadata: ${workspace.workspaceDirectory}`);
    if (await runHook(workspace, 'test:unit:prepare')) ready.push(workspace);
  }
  if (ready.length > 0) {
    const workers = resolveVitestWorkers();
    const poolEnv = resolveVitestPoolEnv(workers);
    const previous = Object.keys(poolEnv).map((key) => [key, process.env[key]] as const);
    const previousExitCode = process.exitCode;
    const jsonOutput = process.env.HAPPIER_UNIT_JSON_OUTPUT;
    const jsonParts: string[] = [];
    const passed: WorkspaceManifest[] = [];
    let selectedModuleCount = 0;
    try {
      Object.assign(process.env, poolEnv);
      // Every Vitest instance retains one Vite module graph per project until it
      // closes, so memory grows with the sum of projects. Run one project per
      // instance so each graph is released before the next project starts.
      for (const workspace of ready) {
        const name = workspace.packageName ?? workspace.workspaceDirectory;
        const partFile = jsonOutput ? `${jsonOutput}.part-${jsonParts.length}` : undefined;
        process.exitCode = undefined;
        const vitest = await startVitest('test', [...(options.filters ?? [])], {
          root: options.rootDir,
          config: false,
          run: true,
          watch: false,
          allowOnly: false,
          reporters: ['default', ...(partFile ? ['json' as const] : [])],
          ...(partFile ? { outputFile: partFile } : {}),
          ...workers,
        }, { test: { projects: [await createProject(options.rootDir, workspace)] } });
        if (!vitest) throw new Error('Vitest could not start the selected unit projects.');
        try {
          const selectedModules = vitest.state.getTestModules().filter((module) => module.project.name === name);
          selectedModuleCount += selectedModules.length;
          if (selectedModules.some((module) => module.state() === 'failed')) {
            failures.push(`${workspace.workspaceDirectory}: Vitest failed`);
          } else if (selectedModules.length === 0) {
            if (!options.filters?.length) failures.push(`${workspace.workspaceDirectory}: no test files matched`);
          } else {
            passed.push(workspace);
          }
          for (const error of vitest.state.getUnhandledErrors()) {
            const message = error !== null && typeof error === 'object' && 'message' in error ? error.message : undefined;
            failures.push(String(message ?? error));
          }
          if (process.exitCode && selectedModules.length > 0 && !failures.some((failure) => failure.startsWith(`${workspace.workspaceDirectory}`))) {
            failures.push(`${workspace.workspaceDirectory}: Vitest exited unsuccessfully.`);
          }
        } finally {
          await vitest.close();
        }
        if (partFile) jsonParts.push(partFile);
      }
      if (options.filters?.length && selectedModuleCount === 0) failures.push('No test files matched the requested filters.');
      if (jsonOutput) await mergeJsonReports(jsonParts, jsonOutput);
    } finally {
      process.exitCode = previousExitCode;
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    for (const workspace of passed) await runHook(workspace, 'test:unit:checks');
  }
  if (failures.length > 0) throw new Error(`Unit project suite failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
}

