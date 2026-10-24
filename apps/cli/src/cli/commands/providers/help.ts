import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';

export const PROVIDERS_HELP = `happier providers

Manage model-provider connections.

  happier providers list [--available] [--json]
  happier providers show <connection-id> [--machine <machine-id>] [--json]
  happier providers add <qualified-contribution-key> [--name <name>] [--candidate-id <id>] [--saved-secret-id <id>] [--json]
  happier providers add --custom --name <name> --protocol <protocol> --base-url <url> --catalog manual|probe
  happier providers edit <connection-id> (--name <name>|--automatic-name)
  happier providers edit <connection-id> --scope account|machine --endpoint-template <id> (--base-url <url>|--clear-endpoint)
  happier providers enable|disable <connection-id> [--machine <machine-id>]
  happier providers bind-secret <connection-id> --scope account|machine --saved-secret-id <id>
  happier providers unbind-secret|replace-secret <connection-id> --scope account|machine
  happier providers add-model <connection-id> --models <newline-separated-ids> [--reasoning-effort-levels <comma-separated-tiers>]
  happier providers remove-model <connection-id> --model <model-id>
  happier providers probe|test|models <connection-id> [--machine <machine-id>]
  happier providers load-model <connection-id> --model <model-id> [--machine <machine-id>]
  happier providers remove <connection-id>

Agent CLI setup moved to 'happier agents'.`;

export async function printProvidersHelp(json: boolean): Promise<void> {
  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'providers_help', data: { help: PROVIDERS_HELP } });
    return;
  }
  console.log(PROVIDERS_HELP);
}

