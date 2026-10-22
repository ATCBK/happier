import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommandSuite, type CommandSuiteEntry } from './lib/runCommandSuite.ts';
import { runPnpmCommand } from './lib/runPnpmCommand.ts';
import { selectSharedPackageTestCommands } from './runSharedPackageTests.ts';
import { resolveGatePackageForWorkspaceDirectory } from '../ci/selectAffectedGatePackages.mjs';
import { discoverWorkspaceManifests } from './lib/workspaceManifests.ts';
import { discoverPluginWorkspaceTestPackageReport } from './lib/pluginWorkspaceTestPackages.ts';

export const ROOT_TEST_COMMANDS = {
  unit: [
    ...selectSharedPackageTestCommands('local'),
    { id: '@happier-dev/plugin-sdk', args: ['--filter', '@happier-dev/plugin-sdk', '--silent', 'run', 'test'] },
    { id: '@happier-dev/plugin-ui', args: ['--filter', '@happier-dev/plugin-ui', '--silent', 'run', 'test'] },
    { id: '@happier-dev/sdk', args: ['--filter', '@happier-dev/sdk', '--silent', 'run', 'test'] },
    { id: '@happier-dev/app', args: ['--filter', '@happier-dev/app', '--silent', 'run', 'test'] },
    { id: '@happier-dev/cli', args: ['--filter', '@happier-dev/cli', '--silent', 'run', 'test:unit'] },
    { id: 'apps/server', args: ['--dir', 'apps/server', '--silent', 'run', 'test:unit'] },
    { id: 'apps/stack', args: ['--dir', 'apps/stack', '--silent', 'run', 'test:unit'] },
  ],
  integration: [
    { id: '@happier-dev/app', args: ['--filter', '@happier-dev/app', '--silent', 'run', 'test:integration'] },
    { id: '@happier-dev/cli', args: ['--filter', '@happier-dev/cli', '--silent', 'run', 'test:integration'] },
    { id: 'apps/server', args: ['--dir', 'apps/server', '--silent', 'run', 'test:integration'] },
    { id: 'apps/stack', args: ['--dir', 'apps/stack', '--silent', 'run', 'test:integration'] },
  ],
} as const satisfies Record<string, readonly CommandSuiteEntry[]>;

export async function runRootTests(lane: string, args: readonly string[] = [], rootDir = process.cwd()): Promise<void> {
  if (lane === 'gate-unit') {
    const separator = args.indexOf('--');
    const selectionArgs = separator < 0 ? args : args.slice(0, separator);
    const packages = selectionArgs.filter((arg) => !arg.startsWith('--filter='));
    const filters = [
      ...selectionArgs.filter((arg) => arg.startsWith('--filter=')).map((arg) => arg.slice('--filter='.length)),
      ...(separator < 0 ? [] : args.slice(separator + 1)),
    ];
    if (filters.some((filter) => !filter)) throw new Error('Gate unit file filters must not be empty.');
    if (packages.length === 0) throw new Error('Gate unit requires selected package labels.');
    const manifests = await discoverWorkspaceManifests(rootDir);
    const available = new Set<string>(manifests.map((workspace) => resolveGatePackageForWorkspaceDirectory(workspace.workspaceDirectory)).filter((label) => label !== null && label !== 'ui'));
    for (const label of packages) {
      if (!available.has(label)) throw new Error(`Unsupported Gate unit package ${label}.`);
    }
    if (packages.includes('plugins')) {
      const report = await discoverPluginWorkspaceTestPackageReport(rootDir);
      if (report.issues.length > 0) throw new Error(`Plugin workspace test selection failed:\n${report.issues.join('\n')}`);
    }
    const selected = new Set(packages);
    const { runWorkspaceUnitProjects } = await import('./runWorkspaceUnitProjects.ts');
    await runWorkspaceUnitProjects({ rootDir, filters, workspaces: manifests.filter((workspace) => {
      const label = resolveGatePackageForWorkspaceDirectory(workspace.workspaceDirectory);
      return label !== null && selected.has(label);
    }) });
    return;
  }
  if (lane !== 'unit' && lane !== 'integration') throw new Error('Test lane must be unit or integration');
  await runCommandSuite<CommandSuiteEntry>({
    commands: ROOT_TEST_COMMANDS[lane],
    suiteName: `Root ${lane} test suite`,
    runCommand: (command) => runPnpmCommand(command, rootDir),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runRootTests(process.argv[2], process.argv.slice(3)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
