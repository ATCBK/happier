import { PluginCommandActionInputRegistry, PLUGIN_COMMAND_INPUT_JSON_ALIASES, PluginCommandActionInputContract, normalizePluginCommandActionInputTokens, readActionInputJsonSchema, readActionInputHints, resolvePluginCommandActionInputContract } from './pluginCommandInputContract';
export { PLUGIN_COMMAND_INPUT_JSON_ALIASES, normalizePluginCommandActionInputTokens, resolvePluginCommandActionInputContract } from './pluginCommandInputContract';
export type { PluginCommandActionInputRegistry, PluginCommandActionInputContract } from './pluginCommandInputContract';
import { type ActionInputHints, type JsonSchemaObject } from '@happier-dev/protocol';

import {
  compileActionCliFieldsFromJsonSchema,
  type ActionCliField,
} from '@/cli/actions/compiledCommands';
import {
  resolveActionCliInputCompletionCandidates,
  resolveActionCliInputCompletionCandidatesWithDynamicOptions,
  type ActionCliDynamicOptionsResolver,
} from '@/cli/actions/commandCompletion';
import {
  type ActionCliFlagCollision,
  validateActionCliFlagCollisions,
} from '@/cli/actions/parseCommandInput';
import type { PluginCommandProjection } from './pluginCommandProjection';
import { findPluginCommandCompletionCommand } from './pluginCommandMetadata';








function resolvePluginCommandCompletionTarget(params: Readonly<{
  registry: PluginCommandActionInputRegistry;
  projection: PluginCommandProjection;
  committed: readonly string[];
}>): Readonly<{
  command: PluginCommandProjection['commands'][number];
  actionInput: PluginCommandActionInputContract | null;
}> | null {
  const command = findPluginCommandCompletionCommand(params.projection, params.committed);
  if (!command) return null;
  return Object.freeze({
    command,
    actionInput: resolvePluginCommandActionInputContract({
      registry: params.registry,
      qualifiedActionId: command.qualifiedActionId,
    }),
  });
}

/**
 * Completion for an exact available plugin command. The command contribution
 * owns its path while the contributed Action owns fields, aliases, and static
 * choices through the same helper used by first-party friendly commands.
 */
export function resolvePluginCommandCompletionCandidates(params: Readonly<{
  registry: PluginCommandActionInputRegistry;
  projection: PluginCommandProjection;
  committed: readonly string[];
  prefix: string;
  fallback: readonly string[];
}>): readonly string[] {
  const target = resolvePluginCommandCompletionTarget(params);
  if (!target) return Object.freeze([]);
  const { command, actionInput } = target;
  if (!actionInput) {
    return command.path.length === params.committed.length
      ? Object.freeze(params.fallback.filter((candidate) => candidate.startsWith(params.prefix)))
      : Object.freeze([]);
  }
  if (actionInput.flagCollision) return Object.freeze([]);

  const actionCommitted = params.committed.slice(command.path.length);
  const candidates = new Set(resolveActionCliInputCompletionCandidates({
    target: { fields: actionInput.fields, positionals: [] },
    committed: actionCommitted,
    prefix: params.prefix,
  }));
  // `--input` is the installed plugin-command compatibility spelling for the
  // canonical parser's `--input-json`. It remains an adapter, not Action input.
  const usedWholeInput = actionCommitted.some((token) => (
    token === '--input'
    || token.startsWith('--input=')
    || token === '--input-json'
    || token.startsWith('--input-json=')
  ));
  if (
    !actionCommitted.includes('--')
    && !usedWholeInput
    && '--input'.startsWith(params.prefix)
    && (params.prefix === '' || params.prefix.startsWith('-'))
  ) {
    candidates.add('--input');
  }
  return Object.freeze([...candidates].sort());
}

/** Dynamic contributed-command completion through the same options Action as built-ins. */
export async function resolvePluginCommandCompletionCandidatesWithDynamicOptions(params: Readonly<{
  registry: PluginCommandActionInputRegistry;
  projection: PluginCommandProjection;
  committed: readonly string[];
  prefix: string;
  fallback: readonly string[];
  resolveDynamicOptions: ActionCliDynamicOptionsResolver;
}>): Promise<readonly string[]> {
  const candidates = new Set(resolvePluginCommandCompletionCandidates(params));
  const target = resolvePluginCommandCompletionTarget(params);
  if (!target) return Object.freeze([...candidates].sort());
  const { command, actionInput } = target;
  if (!actionInput || actionInput.flagCollision) return Object.freeze([...candidates].sort());
  const actionCommitted = normalizePluginCommandActionInputTokens(
    params.committed.slice(command.path.length),
  );
  for (const candidate of await resolveActionCliInputCompletionCandidatesWithDynamicOptions({
    target: { fields: actionInput.fields, positionals: [] },
    actionId: command.qualifiedActionId,
    committed: actionCommitted,
    prefix: params.prefix,
    resolveDynamicOptions: params.resolveDynamicOptions,
  })) {
    candidates.add(candidate);
  }
  return Object.freeze([...candidates].sort());
}
