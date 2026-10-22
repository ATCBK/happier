import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommandSuite } from './lib/runCommandSuite.ts';
import { runPnpmCommand } from './lib/runPnpmCommand.ts';
import { discoverWorkspaceManifests } from './lib/workspaceManifests.ts';
import { runWorkspaceUnitProjects } from './runWorkspaceUnitProjects.ts';

import {
  buildPluginWorkspaceTestInvocations,
  discoverPluginWorkspaceTestPackageReport,
  type PluginWorkspaceScriptName,
  type PluginWorkspaceTestInvocation,
  type PluginWorkspaceTestPackageReport,
} from './lib/pluginWorkspaceTestPackages.ts';

export interface RunPluginWorkspaceTestsOptions {
  rootDir?: string;
  scriptName?: PluginWorkspaceScriptName;
  maxConcurrent?: number;
  discoverReport?: (rootDir: string) => Promise<PluginWorkspaceTestPackageReport>;
  runInvocation?: (invocation: PluginWorkspaceTestInvocation) => Promise<void>;
}

const DEFAULT_MAX_CONCURRENT_PLUGIN_WORKSPACES = 2;

function formatDiscoveryFailure(
  report: PluginWorkspaceTestPackageReport,
  scriptName: PluginWorkspaceScriptName,
): Error {
  return new Error(`Plugin workspace ${scriptName} selection failed:\n${report.issues.map((issue) => `- ${issue}`).join('\n')}`);
}

export async function runPluginWorkspaceTests(
  options: RunPluginWorkspaceTestsOptions = {},
): Promise<readonly PluginWorkspaceTestInvocation[]> {
  const rootDir = options.rootDir ?? process.cwd();
  const scriptName = options.scriptName ?? 'test';
  const report = await (options.discoverReport ?? discoverPluginWorkspaceTestPackageReport)(rootDir);
  if (report.issues.length > 0) {
    throw formatDiscoveryFailure(report, scriptName);
  }

  const invocations = buildPluginWorkspaceTestInvocations(report.packages, scriptName);
  if (invocations.length === 0) {
    throw new Error(`Plugin workspace ${scriptName} selection failed: no executable plugin workspace packages were selected.`);
  }

  if (scriptName === 'test' && options.runInvocation === undefined) {
    const selected = new Set(report.packages.map((workspace) => workspace.workspaceDirectory));
    const workspaces = (await discoverWorkspaceManifests(rootDir)).filter((workspace) => selected.has(workspace.workspaceDirectory));
    await runWorkspaceUnitProjects({ rootDir, workspaces });
    return invocations;
  }

  const runInvocation = options.runInvocation
    ?? ((invocation: PluginWorkspaceTestInvocation) => runPnpmCommand({ id: invocation.packageName, args: invocation.args }, rootDir));
  const maxConcurrent = Number.isInteger(options.maxConcurrent) && Number(options.maxConcurrent) > 0
    ? Number(options.maxConcurrent)
    : DEFAULT_MAX_CONCURRENT_PLUGIN_WORKSPACES;
  await runCommandSuite({
    commands: invocations.map((invocation) => ({ id: invocation.packageName, args: invocation.args, invocation })),
    maxConcurrent,
    suiteName: `Plugin workspace ${scriptName}`,
    runCommand: ({ invocation }) => runInvocation(invocation),
  });
  return invocations;
}

async function main(): Promise<void> {
  const scriptName = process.argv[2];
  if (scriptName !== undefined && scriptName !== 'typecheck') {
    throw new Error(`Unsupported plugin workspace script ${scriptName}.`);
  }
  await runPluginWorkspaceTests({ scriptName });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
