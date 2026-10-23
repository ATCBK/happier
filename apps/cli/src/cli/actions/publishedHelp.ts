import { BUNDLED_ACTION_CLI_HELP } from '@/plugins/projection/registry/sources/generatedBundledActionCliHelp';
import { listActionCliHelpUsageLines, renderActionCliRootHelpFromDeclarations } from './helpDeclarations';
import { findActionCliCommandPattern } from './commandPatterns';
import { renderActionCliHelpModel } from './helpModel';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { actionCliEnvelopeKind } from './commandPresentationMetadata';

export function listPublishedActionCliUsageLinesForRoot(path: readonly string[]): readonly string[] {
  return listActionCliHelpUsageLines(path, BUNDLED_ACTION_CLI_HELP);
}

export function renderPublishedActionCliRootHelp(root: string, prefix: readonly string[] = [root]): string {
  return renderActionCliRootHelpFromDeclarations(root, prefix, BUNDLED_ACTION_CLI_HELP);
}

export async function printPublishedActionCliHelp(args: readonly string[], options: Readonly<{ rootOnly?: boolean; exactOnly?: boolean }> = {}): Promise<boolean> {
  const command = options.rootOnly ? null : findActionCliCommandPattern(args, BUNDLED_ACTION_CLI_HELP);
  const root = args[0] ?? '';
  if (!command && options.exactOnly) return false;
  if (!command && !BUNDLED_ACTION_CLI_HELP.some((candidate) => candidate.path[0] === root)) return false;
  const help = command ? renderActionCliHelpModel(command.help) : renderPublishedActionCliRootHelp(root);
  if (wantsJson(args)) {
    await printJsonEnvelope({ ok: true, kind: command?.envelopeKind ?? actionCliEnvelopeKind([root]), data: { help } });
  } else console.log(help);
  return true;
}
