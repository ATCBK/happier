import { listActionSpecs } from '../actions/actionSpecs.js';
import { isChangeTitleToolLikeName } from './v2/aliases.js';

// The Agent's permission layer must not duplicate the approval performed by
// Action execution. Direct dangerous tools retain their native prompt; these
// meta tools always enter the Action policy owner before an effect is applied.
const names = new Set([
  'action_execute',
  'action_spec_search',
  'action_spec_get',
  'action_options_resolve',
]);
for (const spec of listActionSpecs()) {
  if (spec.safety === 'safe' && spec.bindings?.mcpToolName) names.add(spec.bindings.mcpToolName);
}
// change_title is the existing native title bridge to session.title.set.
if (names.has('session_title_set')) names.add('change_title');

const toolNames: readonly string[] = Object.freeze([...names].sort());
const normalizedNames = new Set(toolNames.map((name) => name.toLowerCase()));
const recognizedPrefixes = ['mcp__happier__', 'mcp__happy__', 'happier__', 'happy__', 'happier_', 'happy_'];

/** Bare names for native Agent permission projections and session-scoped servers. */
export function listHappierToolAutoApprovedNamesV1(): readonly string[] {
  return toolNames;
}

/** Project only the native server prefix used by this launch, never recognition aliases. */
export function listHappierToolAutoApprovedNameSpellingsV1(nativePrefix: string): readonly string[] {
  return Object.freeze(toolNames.map((name) => `${nativePrefix}${name}`));
}

export function isHappierToolAutoApprovedByAgentLayerV1(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalizedNames.has(normalized)
    || recognizedPrefixes.some((prefix) => normalized.startsWith(prefix) && normalizedNames.has(normalized.slice(prefix.length)))
    || (names.has('session_title_set') && isChangeTitleToolLikeName(normalized));
}
