import type { CliCommandSurfaceEntry } from './commandSurfaceManifest';
import type { ResolvedCommandContribution } from '@/plugins/projection/registry/types';
import type { ContributionAvailabilityDecision } from '@happier-dev/protocol/plugins/contributions/public-types';
import { findCliCommandPathConflicts } from './commandPathClaims';

export type PluginCommandProjectionEntry = Readonly<{
  qualifiedId: string;
  qualifiedActionId: string;
  path: readonly string[];
  title: string;
  description?: string;
  visibility: 'default' | 'advanced';
  tmux: 'inherit' | 'required' | 'forbidden';
  status: 'available' | 'unavailable' | 'ambiguous';
  unavailableCode?: string;
}>;

export type PluginCommandProjectionDiagnostic = Readonly<{
  code: string;
  qualifiedId: string;
}>;

export type PluginCommandProjection = Readonly<{
  roots: readonly string[];
  commands: readonly PluginCommandProjectionEntry[];
  rootHelpEntries: readonly CliCommandSurfaceEntry[];
  diagnostics: readonly PluginCommandProjectionDiagnostic[];
}>;

/** Longest available command prefix, shared by field compilation and admitted reads. */
export function findPluginCommandCompletionCommand(projection: PluginCommandProjection, committed: readonly string[]): PluginCommandProjectionEntry | null {
  return projection.commands.filter((candidate) => (
    candidate.status === 'available'
    && candidate.path.length <= committed.length
    && candidate.path.every((segment, index) => committed[index] === segment)
  )).sort((left, right) => right.path.length - left.path.length)[0] ?? null;
}

const COMMAND_PATH_SEGMENT = /^[a-z][a-z0-9-]*$/;
const TERMINAL_ESCAPE_SEQUENCE = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\|$)|[PX^_][\s\S]*?(?:\u001b\\|$)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])/gu;
const TERMINAL_CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

function sanitizePluginCommandDisplayText(value: string): string | null {
  const sanitized = value
    .replace(TERMINAL_ESCAPE_SEQUENCE, '')
    .replace(TERMINAL_CONTROL_OR_BIDI, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return sanitized || null;
}

function readLocalizedText(value: unknown): string | null {
  if (typeof value === 'string') {
    return sanitizePluginCommandDisplayText(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fallback = (value as Readonly<{ fallback?: unknown }>).fallback;
  return typeof fallback === 'string' ? sanitizePluginCommandDisplayText(fallback) : null;
}

function qualifiedCommandId(command: ResolvedCommandContribution): string | null {
  const pluginId = command.pluginId?.trim();
  const localId = command.definition.id.trim();
  return pluginId && localId ? pluginId + '/' + localId : null;
}

function compareCommands(
  left: PluginCommandProjectionEntry,
  right: PluginCommandProjectionEntry,
): number {
  const pathComparison = left.path.join('\u0000').localeCompare(right.path.join('\u0000'));
  return pathComparison || left.qualifiedId.localeCompare(right.qualifiedId);
}

export function resolvePluginCommandMetadata<T extends ResolvedCommandContribution>(params: Readonly<{
  registry: Readonly<{ commands?: readonly T[] }>;
  resolveAvailability(command: T): ContributionAvailabilityDecision;
  reservedRoots: ReadonlySet<string>;
}>): PluginCommandProjection {
  const diagnostics: PluginCommandProjectionDiagnostic[] = [];
  const admitted: PluginCommandProjectionEntry[] = [];

  for (const command of params.registry.commands ?? []) {
    const qualifiedId = qualifiedCommandId(command);
    if (!qualifiedId) continue;
    const path = command.definition.path.map((segment) => segment.trim());
    const root = path[0];
    if (!root || path.some((segment) => !COMMAND_PATH_SEGMENT.test(segment))) {
      diagnostics.push(Object.freeze({ code: 'plugin_command_path_invalid', qualifiedId }));
      continue;
    }
    if (params.reservedRoots.has(root)) {
      diagnostics.push(Object.freeze({ code: 'plugin_command_path_reserved', qualifiedId }));
      continue;
    }

    const availability = params.resolveAvailability(command);
    admitted.push(Object.freeze({
      qualifiedId,
      qualifiedActionId: command.definition.actionId,
      path: Object.freeze(path),
      title: readLocalizedText(command.definition.title) ?? command.definition.id,
      ...(readLocalizedText(command.definition.description)
        ? { description: readLocalizedText(command.definition.description)! }
        : {}),
      visibility: command.definition.visibility ?? 'default',
      tmux: command.definition.tmux ?? 'inherit',
      status: availability.outcome === 'visible' ? 'available' : 'unavailable',
      ...(availability.outcome !== 'visible'
        ? { unavailableCode: availability.code }
        : {}),
    }));
  }

  const ambiguousQualifiedIds = new Set(
    findCliCommandPathConflicts(admitted.map((command) => ({
      source: 'plugin' as const,
      ownerId: command.qualifiedId,
      path: command.path,
    }))).flatMap((conflict) => [conflict.left.ownerId, conflict.right.ownerId]),
  );

  const commands = admitted.map((command) => {
    if (!ambiguousQualifiedIds.has(command.qualifiedId)) return command;
    diagnostics.push(Object.freeze({
      code: 'plugin_command_path_ambiguous',
      qualifiedId: command.qualifiedId,
    }));
    return Object.freeze({
      ...command,
      status: 'ambiguous' as const,
      unavailableCode: 'plugin_command_path_ambiguous',
    });
  }).sort(compareCommands);

  const roots = [...new Set(commands.map((command) => command.path[0]!))].sort();
  const rootHelpEntries = roots.flatMap((root): CliCommandSurfaceEntry[] => {
    const visibleCommands = commands.filter((command) => (
      command.path[0] === root
      && command.status === 'available'
      && command.visibility === 'default'
    ));
    if (visibleCommands.length === 0) return [];
    const description = visibleCommands.length === 1
      ? visibleCommands[0]!.description ?? visibleCommands[0]!.title
      : 'Plugin commands';
    return [{
      command: root,
      rootHelpLabel: 'happier ' + root,
      rootHelpDescription: description,
      allowTmux: visibleCommands.some((command) => command.tmux !== 'forbidden'),
    }];
  });

  return Object.freeze({
    roots: Object.freeze(roots),
    commands: Object.freeze(commands),
    rootHelpEntries: Object.freeze(rootHelpEntries.map((entry) => Object.freeze(entry))),
    diagnostics: Object.freeze(diagnostics),
  });
}

