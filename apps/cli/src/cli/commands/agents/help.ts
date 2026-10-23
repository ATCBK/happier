import { cmd, renderHelpPage } from '@happier-dev/cli-common/output';
import { resolveCliAgentHelpRows } from '@/cli/helpDeclarationFacts';

export async function printAgentsHelp(happyHomeDir: string): Promise<void> { console.log(usage(await resolveCliAgentHelpRows(happyHomeDir))); }

export function usage(agentRows: readonly Readonly<{ id: string; title: string; runtimeSpec: unknown }>[] = []): string {
    const agentRowsSection = agentRows.length > 0
      ? [{
          title: 'Available agents:',
          rows: agentRows.map((row) => ({
            label: cmd(`${row.title} (${row.id})`),
            description: row.runtimeSpec
                ? `Install with ${cmd(`happier agents install ${row.id}`)}`
                : 'Provided by an installed plugin runtime',
          })),
        }]
      : [];

    return renderHelpPage({
        title: 'happier agents',
        subtitle: 'Agent CLI helpers',
        usage: [
            { label: 'happier agents list [--json]', description: 'List agents and whether they are installed' },
            { label: 'happier agents status [--json]', description: 'Show agent status for the current environment' },
            { label: 'happier agents probe <agentId> [--models] [--modes] [--config-options] [--json]', description: 'Probe agent model, mode, and config-option availability' },
            { label: 'happier agents auth login <agentId>', description: 'Authenticate an agent-owned managed ACP runtime' },
            { label: 'happier agents browse [query] [--source <source>]', description: 'Browse registry Agents' },
            { label: 'happier agents add <source>/<item> [--version <version>] [--install now|first-use] [--machine <id>]', description: 'Add a pinned registry Agent' },
            { label: 'happier agents remove <agentId> [--definition-id <id>] --machine <id>', description: 'Remove a managed install' },
            { label: 'happier agents delete <definitionId>', description: 'Delete a configured Agent' },
            { label: 'happier agents install <agentId> [--machine <id>] [--dry-run] [--force]', description: 'Install one agent CLI' },
            { label: 'happier agents update <agentId> [--dry-run] [--yes]', description: 'Update an installed agent CLI through its owner' },
            { label: 'happier agents setup [--provider <id> ...] [--providers <id1,id2>] [--dry-run] [--force] [--yes]', description: 'Install one or more agents' },
        ],
        sections: agentRowsSection,
        notes: [
            'Agents are the local tools Happier can run sessions with.',
            'Installs are binary-safe and do not require Node or a package manager.',
            'Installs, updates and removals use Actions and require approval by default. --yes only grants vendor-recipe consent.',
            `For cloud-stored API keys and subscription OAuth, use ${cmd('happier connect')}.`,
            `Non-interactive defaults: ${cmd('happier agents setup --yes')} installs the recommended agents.`,
        ],
    });
}

