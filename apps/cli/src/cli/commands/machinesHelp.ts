import { renderHelpPage } from '@happier-dev/cli-common/output';

export async function showHelp(): Promise<void> {
  // Every `machines` leaf — the Account inventory and Machine Pool
  // administration — is a compiled Action command, so the usage rows come from
  // that descriptor rather than a table that could omit or misstate one.
  const { listPublishedActionCliUsageLinesForRoot: listCompiledActionCliUsageLinesForRoot } = await import('@/cli/actions/publishedHelp');
  console.log(renderHelpPage({
    title: 'happier machines',
    subtitle: 'Discover machines, inspect resources, and administer Machine Pools',
    usage: listCompiledActionCliUsageLinesForRoot(['machines']).map((label) => ({ label, description: '' })),
    notes: [
      'Authentication may come from happier auth login or HAPPIER_TOKEN.',
      'Canonical Actions include machines.list, machines.resources.*, machines.processes.*, and machines.pools.*.',
    ],
  }));
}

