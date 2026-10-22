import { access } from 'node:fs/promises';
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

/** One Vitest instance; package manifests retain ownership of non-Vitest checks. */
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
    const projects = await Promise.all(ready.map((workspace) => createProject(options.rootDir, workspace)));
    const workers = resolveVitestWorkers();
    const poolEnv = resolveVitestPoolEnv(workers);
    const previous = Object.keys(poolEnv).map((key) => [key, process.env[key]] as const);
    const passed: WorkspaceManifest[] = [];
    try {
      Object.assign(process.env, poolEnv);
      const vitest = await startVitest('test', [...(options.filters ?? [])], {
        root: options.rootDir,
        config: false,
        run: true,
        watch: false,
        allowOnly: false,
        reporters: ['default', ...(process.env.HAPPIER_UNIT_JSON_OUTPUT ? ['json' as const] : [])],
        ...(process.env.HAPPIER_UNIT_JSON_OUTPUT ? { outputFile: process.env.HAPPIER_UNIT_JSON_OUTPUT } : {}),
        ...workers,
      }, { test: { projects } });
      if (!vitest) throw new Error('Vitest could not start the selected unit projects.');
      try {
        const modules = vitest.state.getTestModules();
        for (const workspace of ready) {
          const name = workspace.packageName ?? workspace.workspaceDirectory;
          const selectedModules = modules.filter((module) => module.project.name === name);
          if (selectedModules.some((module) => module.state() === 'failed')) {
            failures.push(`${workspace.workspaceDirectory}: Vitest failed`);
          } else if (selectedModules.length === 0) {
            if (!options.filters?.length) failures.push(`${workspace.workspaceDirectory}: no test files matched`);
          } else {
            passed.push(workspace);
          }
        }
        for (const error of vitest.state.getUnhandledErrors()) {
          const message = error !== null && typeof error === 'object' && 'message' in error ? error.message : undefined;
          failures.push(String(message ?? error));
        }
        if (process.exitCode && failures.length === 0) failures.push('Vitest exited unsuccessfully.');
      } finally {
        await vitest.close();
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    for (const workspace of passed) await runHook(workspace, 'test:unit:checks');
  }
  if (failures.length > 0) throw new Error(`Unit project suite failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
}

