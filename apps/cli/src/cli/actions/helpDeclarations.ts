import { renderHelpPage } from '@happier-dev/cli-common/output';
import type { ActionCliHelpModel } from './helpModel';
import type { ActionCliCommandPathDeclaration } from './commandPatterns';

export type ActionCliHelpDeclaration = ActionCliCommandPathDeclaration & Readonly<{
  title: string;
  envelopeKind: string;
  usageLine: string;
  rootUsageLine: string;
  help: ActionCliHelpModel;
}>;

export function listActionCliHelpUsageLines(path: readonly string[], commands: readonly ActionCliHelpDeclaration[]): readonly string[] {
  return commands.filter((command) => command.visibility !== 'hidden'
    && command.path.length >= path.length && path.every((segment, index) => command.path[index] === segment))
    .map((command) => command.usageLine);
}

/** Both live compiled commands and published facts render through this owner. */
export function renderActionCliRootHelpFromDeclarations(root: string, prefix: readonly string[], commands: readonly ActionCliHelpDeclaration[]): string {
  return renderHelpPage({
    title: `happier ${prefix.join(' ')}`,
    subtitle: `Action-backed ${root} commands`,
    usage: commands.filter((command) => command.visibility !== 'hidden'
      && prefix.every((part, index) => command.path[index] === part))
      .map((command) => ({ label: command.rootUsageLine, description: command.title })),
    notes: [
      `Use \`happier ${root} <subcommand> --help\` for that command's arguments.`,
      'Every subcommand accepts --input-json for whole structured input and --json for a stable envelope.',
    ],
  });
}
