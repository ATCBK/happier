import { listActionSpecs } from '../actions/actionSpecs.js';
import { CHANGE_TITLE_TOOL_NAME_ALIASES, isChangeTitleToolLikeName } from './v2/aliases.js';

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
const spellings = new Set<string>();
for (const name of toolNames) {
  spellings.add(name);
  for (const server of ['happier', 'happy']) {
    spellings.add(`mcp__${server}__${name}`);
    spellings.add(`${server}__${name}`);
    spellings.add(`${server}_${name}`);
  }
}
if (names.has('session_title_set')) {
  for (const alias of CHANGE_TITLE_TOOL_NAME_ALIASES) spellings.add(alias);
  spellings.add('set_session_title');
}
const toolNameSpellings: readonly string[] = Object.freeze([...spellings].sort());
const normalizedSpellings = new Set(toolNameSpellings.map((name) => name.toLowerCase()));

/** Bare names for native Agent permission projections and session-scoped servers. */
export function listHappierToolAutoApprovedNamesV1(): readonly string[] {
  return toolNames;
}

export function listHappierToolAutoApprovedNameSpellingsV1(): readonly string[] {
  return toolNameSpellings;
}

export function isHappierToolAutoApprovedByAgentLayerV1(toolName: string): boolean {
  return normalizedSpellings.has(toolName.trim().toLowerCase())
    || (names.has('session_title_set') && isChangeTitleToolLikeName(toolName));
}
