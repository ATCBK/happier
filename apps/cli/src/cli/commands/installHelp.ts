import chalk from 'chalk';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { resolveCliAgentHelpRows } from '@/cli/helpDeclarationFacts';

type ProviderStatusRow = Readonly<{ id: string; title: string; runtimeSpec: AgentCliRuntimeDescriptor }>;

/** Shared projection over already normalized/admitted Agent descriptors. */
export function readInstallableProviderRows(registry: Readonly<{ agents: readonly Readonly<{ id: string; runtimeSpec?: AgentCliRuntimeDescriptor | null }>[] }>): ProviderStatusRow[] {
  return registry.agents.map((contribution) => {
    const runtimeSpec = contribution.runtimeSpec ?? null;
    if (!runtimeSpec || runtimeSpec.manualInstallKind === 'none') return null;
    return { id: contribution.id, title: runtimeSpec.title, runtimeSpec } satisfies ProviderStatusRow;
  }).filter((row): row is ProviderStatusRow => row !== null).sort((a, b) => a.id.localeCompare(b.id));
}

export async function printInstallHelp(happyHomeDir: string): Promise<void> {
  console.log(usage(readInstallableProviderRows({ agents: await resolveCliAgentHelpRows(happyHomeDir) })));
}

export function usage(providerRows: readonly Readonly<{ id: string; title: string }>[] = []): string {
  const lines = [
    `${chalk.bold('happier install')} - Installation helpers`,
    '',
    `${chalk.bold('Usage:')}`,
    '  happier install doctor',
    '  happier install provider <providerId> [--dry-run] [--force]',
    '',
  ];
  if (providerRows.length > 0) {
    lines.push(
      `${chalk.bold('Available providers:')}`,
      ...providerRows.map((row) => `  ${row.title} (${row.id}) — Install with happier install provider ${row.id}`),
      '',
    );
  }
  return lines.join('\n');
}

