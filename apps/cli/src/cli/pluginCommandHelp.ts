import { type PluginCommandProjection } from './pluginCommandProjection';
import type { PluginCommandActionInputRegistry } from './pluginCommandInputContract';

/** The command path words, which always precede any option token. */
export function readPluginCommandPath(args: readonly string[]): readonly string[] {
  const path: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) break;
    path.push(token);
  }
  return Object.freeze(path);
}

export async function renderPluginCommandHelp(params: Readonly<{
  projection: PluginCommandProjection;
  root: string;
  args: readonly string[];
  registry: PluginCommandActionInputRegistry;
}>): Promise<string> {
  const requestedPath = readPluginCommandPath(params.args);
  const exact = params.projection.commands.find((command) => (
    command.path.length === requestedPath.length
    && command.path.every((segment, index) => segment === requestedPath[index])
  ));
  if (exact) {
    const [{ resolvePluginCommandActionInputContract }, { listActionCliCommandFlags }, { buildFieldOptionRows }] = await Promise.all([
      import('./pluginCommandInputContract'), import('./actions/fieldFlags'), import('./actions/fieldHelp'),
    ]);
    // Help reads the same derivation the parser does, so a documented flag is
    // always an accepted one.
    const actionInput = resolvePluginCommandActionInputContract({
      registry: params.registry,
      qualifiedActionId: exact.qualifiedActionId,
    });
    const documentedFields = actionInput && !actionInput.flagCollision ? actionInput.fields : [];
    const fieldUsage = documentedFields.length > 0
      ? `${listActionCliCommandFlags({ fields: documentedFields, positionals: [] }).map((flag) => `[${flag}]`).join(' ')} `
      : '';
    return [
      `${exact.title}`,
      exact.description ?? '',
      '',
      `Usage: happier ${exact.path.join(' ')} ${fieldUsage}[--input-json <json>] [--json]`,
      'Alias: --input <json>',
      ...(documentedFields.length > 0
        ? ['', 'Options:', ...buildFieldOptionRows(documentedFields).map((row) => `  ${row.label}  ${row.description}`), '']
        : []),
      `Command: ${exact.qualifiedId}`,
      `Action: ${exact.qualifiedActionId}`,
      ...(exact.status === 'available'
        ? actionInput?.flagCollision
          ? [`Unavailable: ${actionInput.flagCollision.code}`]
          : []
        : [`Unavailable: ${exact.unavailableCode ?? 'plugin_command_unavailable'}`]),
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1] !== '')).join('\n');
  }

  const commands = params.projection.commands.filter((command) => (
    command.path[0] === params.root
    && command.status === 'available'
    && command.visibility === 'default'
  ));
  return [
    `Usage: happier ${params.root} <command> [--input-json <json>] [--json]`,
    'Alias: --input <json>',
    '',
    ...commands.map((command) => `  ${command.path.slice(1).join(' ')}  ${command.description ?? command.title}`),
  ].join('\n');
}

export async function resolveReadOnlyPluginCommandHelp(args: readonly string[], happyHomeDir: string): Promise<string | null> {
  const { resolveReadOnlyHelpDeclarations, resolveReadOnlyCommandActionInputRegistry } = await import('./rootHelp');
  const declarations = await resolveReadOnlyHelpDeclarations(happyHomeDir);
  const root = args[0] ?? '';
  if (!declarations.projection.roots.includes(root)) return null;
  const path = readPluginCommandPath(args);
  const command = declarations.projection.commands.find((candidate) => candidate.path.length === path.length
    && candidate.path.every((segment, index) => path[index] === segment));
  return await renderPluginCommandHelp({
    projection: declarations.projection, root, args,
    registry: await resolveReadOnlyCommandActionInputRegistry(declarations, command?.qualifiedActionId),
  });
}

