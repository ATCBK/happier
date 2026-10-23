import { renderHelpPage } from '@happier-dev/cli-common/output';
import { resolveInvokerName } from '@/cli/runtime/resolveInvokerName';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';

export async function printPluginSettingsHelp(args: readonly string[]): Promise<void> {
  const help = renderPluginSettingsHelp();
  if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind: 'plugins.settings', data: { help } });
  else console.log(help);
}

export function pluginSettingsHelpRows(pluginCommand: string): readonly Readonly<{
  label: string;
  description: string;
}>[] {
  return Object.freeze([
    { label: `${pluginCommand} settings list <pluginId> --scope <account|daemon> [--machine <id>] [--json]`, description: 'List declared Plugin Settings from one exact Account or daemon scope' },
    { label: `${pluginCommand} settings get <pluginId> <localId> --scope <account|daemon> [--machine <id>] [--json]`, description: 'Read one declared non-secret Plugin Setting' },
    { label: `${pluginCommand} settings set <pluginId> <localId> --scope <account|daemon> --value <json> [--expected-revision <revision>] [--machine <id>] [--json]`, description: 'Compare-and-set one declared non-secret Plugin Setting' },
    { label: `${pluginCommand} settings reset <pluginId> <localId> --scope <account|daemon> [--expected-revision <revision>] [--machine <id>] [--json]`, description: 'Reset one declared non-secret Plugin Setting to its default' },
    { label: `${pluginCommand} settings secret status <pluginId> <localId> [--scope <account|daemon>] [--machine <id>] [--json]`, description: 'Read safe configured status for one declared Plugin secret' },
    { label: `${pluginCommand} settings secret bind <pluginId> <localId> --saved-secret-id <id> [--scope <account|daemon>] [--expected-revision <revision>] [--json]`, description: 'Bind an Account-custodied Plugin secret to an existing Saved Secret' },
    { label: `${pluginCommand} settings secret unbind <pluginId> <localId> [--scope <account|daemon>] [--expected-revision <revision>] [--json]`, description: 'Remove an Account-custodied Plugin secret binding' },
    { label: `${pluginCommand} settings secret delete <pluginId> <localId> [--scope <account|daemon>] [--machine <id>] [--expected-revision <revision>] [--json]`, description: 'Delete a declared Plugin secret through its existing custody owner' },
  ]);
}

export function renderPluginSettingsHelp(): string {
  const pluginCommand = `${resolveInvokerName() ?? 'happier'} plugins`;
  return renderHelpPage({
    title: `${pluginCommand} settings`,
    subtitle: 'Read and update declared Plugin Settings through canonical Actions',
    usage: [...pluginSettingsHelpRows(pluginCommand)],
    notes: [
      'Daemon Settings require one exact --machine target.',
      'Secret commands never accept raw secret material.',
    ],
  });
}

