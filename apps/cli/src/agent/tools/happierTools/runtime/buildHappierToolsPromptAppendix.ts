import { buildHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';
import { DEFAULT_CODING_PROMPT_BEHAVIOR_V1, type CodingPromptSessionTitleUpdatesModeV1 } from '@happier-dev/protocol/prompts/codingPromptBehaviorV1';
import { buildHappierSessionTitleGuidanceV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

export function buildHappierToolsPromptAppendix(params: Readonly<{
  sessionId: string;
  directory: string;
  sessionTitleUpdatesMode?: CodingPromptSessionTitleUpdatesModeV1;
  sessionTitleToolAvailable?: boolean;
  createdAsBot?: boolean;
  memoryRecallGuidance?: Readonly<{
    enabled?: boolean;
    machineId?: string | null;
  }>;
}>): string {
  const listCommand = buildHappierToolsShellBridgeCommand([
    'list',
    '--session-id',
    params.sessionId,
    '--directory',
    params.directory,
    '--json',
  ]);
  const renameCommand = buildHappierToolsShellBridgeCommand([
    'call',
    '--session-id',
    params.sessionId,
    '--directory',
    params.directory,
    '--source',
    'happier',
    '--tool',
    'change_title',
    '--args-json',
    '{"title":"Short descriptive title"}',
    '--json',
  ]);
  const memoryMachineId = typeof params.memoryRecallGuidance?.machineId === 'string'
    ? params.memoryRecallGuidance.machineId.trim()
    : '';
  const memorySearchCommand = buildHappierToolsShellBridgeCommand([
    'call',
    '--session-id',
    params.sessionId,
    '--directory',
    params.directory,
    '--source',
    'happier',
    '--tool',
    'memory_search',
    '--args-json',
    JSON.stringify({
      machineId: memoryMachineId || '<machine-id>',
      query: {
        v: 1,
        query: 'topic from user',
        scope: { type: 'global' },
        mode: 'auto',
      },
    }),
    '--json',
  ]);
  const memoryWindowCommand = buildHappierToolsShellBridgeCommand([
    'call',
    '--session-id',
    params.sessionId,
    '--directory',
    params.directory,
    '--source',
    'happier',
    '--tool',
    'memory_get_window',
    '--args-json',
    JSON.stringify({
      machineId: memoryMachineId || '<machine-id>',
      sessionId: '<session-id-from-hit>',
      seqFrom: '<seq-from-hit>',
      seqTo: '<seq-to-hit>',
    }),
    '--json',
  ]);
  const explicitPluginActionExecuteCommand = buildHappierToolsShellBridgeCommand([
    'call',
    '--session-id',
    params.sessionId,
    '--directory',
    params.directory,
    '--source',
    'happier',
    '--tool',
    'action_execute',
    '--args-json',
    JSON.stringify({
      actionId: '<qualified-action-id-from-action_spec_get>',
      input: {},
    }),
    '--json',
  ]);
  const memoryGuidance = params.memoryRecallGuidance?.enabled === true
    ? `For recall questions about earlier conversations, use the Happier memory bridge tools before provider-native memory files, workspace search, or guesses from model memory.

Use \`${memorySearchCommand}\` first. ${memoryMachineId ? `Use machineId \`${memoryMachineId}\` for this session's daemon memory index.` : 'Fill in the current daemon machine id before running the command.'}

If \`memory_search\` returns a hit that you need to verify, use \`${memoryWindowCommand}\` with the returned \`sessionId\`, \`seqFrom\`, and \`seqTo\`.

Do not use provider-native memory files or ad-hoc workspace search as a substitute for \`memory_search\`. If \`memory_search\` returns no hits, say that plainly.`
    : '';

  const titleMode = params.sessionTitleUpdatesMode ?? DEFAULT_CODING_PROMPT_BEHAVIOR_V1.sessionTitleUpdates;
  const titleGuidance = buildHappierSessionTitleGuidanceV1({
    settings: { codingPromptBehaviorV1: { sessionTitleUpdates: titleMode } },
    sessionTitleToolAvailable: params.sessionTitleToolAvailable,
    createdAsBot: params.createdAsBot,
    preferredToolName: 'change_title',
  });
  const renameCommandGuidance = titleGuidance
    ? `Use \`${renameCommand}\` to perform a title update when the title guidance above permits it.`
    : '';
  const visualSpec = getActionSpec('session.board.item.upsert');
  const visualExample: Record<string, unknown> = JSON.parse(visualSpec.examples!.mcp!.argsExample!);
  const visualCommand = buildHappierToolsShellBridgeCommand([
    'call', '--session-id', params.sessionId, '--directory', params.directory,
    '--source', 'happier', '--tool', visualSpec.bindings!.mcpToolName!,
    '--args-json', JSON.stringify({ ...visualExample, sessionId: params.sessionId }), '--json',
  ]);
  const usageCommand = buildHappierToolsShellBridgeCommand([
    'call', '--session-id', params.sessionId, '--directory', params.directory,
    '--source', 'happier', '--tool', visualSpec.bindings!.mcpToolName!,
    '--args-json', JSON.stringify({
      itemId: 'daily-usage', expectedItemRevision: null, destination: 'transcript',
      item: { v: 1, title: 'Daily usage', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'widget', instance: { v: 1, id: 'daily-usage',
          definition: { kind: 'builtin', id: 'usage_daily' }, bindings: {
            period: { kind: 'value', value: { relative: 'today' } },
            agents: { kind: 'value', value: [] }, machines: { kind: 'value', value: [] },
            projects: { kind: 'value', value: [] }, sources: { kind: 'value', value: [] },
            session: { kind: 'value', value: params.sessionId },
            costBasis: { kind: 'value', value: 'auto' }, metric: { kind: 'value', value: 'tokens' },
          } } } },
    }), '--json',
  ]);

  return `Happier tools are available through the CLI bridge for this provider. They are not exposed as native tools in the provider tool inventory.
${titleGuidance}

Use \`${listCommand}\` when you need to discover the available built-in Happier tools and custom configured tools.
${renameCommandGuidance}

When you know a plugin's qualified Action ID (\`<plugin-id>/actions/<local-id>\`), use \`${explicitPluginActionExecuteCommand}\` with that exact ID. A Tool ID is not an Action ID; call a named Tool using its published Tool name. The current runtime must admit the Action: editing plugin source alone does not refresh the loaded catalog.

${memoryGuidance ? `${memoryGuidance}

` : ''}For any other Happier or custom tool, call the same CLI bridge form with \`call --source <source> --tool <tool> --args-json '<json>' --json\`. Use the listed tool \`name\` verbatim for \`--tool\`; ActionSpec IDs (for example, \`subagents.delegate.start\`) are not tool names. If you start from an ActionSpec ID, invoke the listed \`action_execute\` tool and pass the ID as \`actionId\` in \`--args-json\`. When a custom tool is written as \`<source>/<tool>\`, pass the part before the slash to \`--source\` and the part after the slash to \`--tool\`.

Never violate the user's explicit constraints on tool usage. If the user says to avoid tools or to use exactly one tool, follow that instruction even if it means skipping the title update for that turn.

Do not claim these Happier tools are unavailable without first using the CLI bridge to list or call them.

Prefer this exact CLI bridge command form over ad-hoc shell equivalents when the capability exists there.

## Showing visuals

When a visual communicates the result better, prefer typed declarative charts and tables. Charts map neutral rows through typed x/series/value fields: bar stacks values, area stacks ribbons, and line draws independent series. Each x/series pair names one observation; omit missing observations rather than inventing zero. Existing x/y charts remain the single-series form. Use an HTML bundle otherwise: a self-contained entrypoint plus relative assets, not an HTML-string item. A workspace file or folder can be acquired through the Action's workspace source. Do not start a browser, preview server or screenshot loop to validate declarative content; use the tool's validation result.

Show a visual with \`session.board.item.upsert\` (tool \`${visualSpec.bindings!.mcpToolName!}\`). The normal destination is the transcript; \`board\` or \`both\` needs an explicit first placement. Pin/Unpin changes the same item's layout, not a second copy. Keep its stable item id and use the returned exact revision when updating. For example:

\`${visualCommand}\`

For live Daily usage in this Session, show the builtin \`usage_daily\` widget with \`${usageCommand}\`. Its declared inputs filter to this Session; set the \`session\` binding value to \`null\` for Account-wide usage. The viewer's current Account reads it through ordinary \`usage.query\` Resource admission, so showing the widget does not disclose the agent's private Account snapshot or require a separate Resource tool call.

After a successful visual, do not restate its contents in prose. A short conclusion or necessary caveat is enough. If admission fails or needs approval, report that outcome; do not claim the visual was shown.

HTML declares no network by default, exact \`networkOrigins\` for bounded access, or \`network: 'open'\` for open access. The user's agent HTML network setting controls new creation: \`allowed\` honors the declaration (the default), \`ask\` requires approval for network, and \`off\` creates a no-network copy with an \`agent_html_network_off\` notice. Missing or malformed settings fail closed to \`ask\`. This setting does not silently rewrite existing visuals. Changing existing HTML's network consequence defaults to approval under the user's explicit Actions policy. Network access never authorizes Actions or Resources: every bridge request still runs with the current viewer's ordinary authority.`;
}
