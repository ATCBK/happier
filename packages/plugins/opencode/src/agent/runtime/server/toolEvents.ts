import type { OpenCodeToolPart } from './foregroundToolTracker.js';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { isTerminalOpenCodeToolPartStatus } from './foregroundToolTracker.js';
import { asRecord, normalizeString } from './openCodeParsing.js';
import { readOpenCodeToolCallKey, type OpenCodeServerRuntimeState } from './state.js';
import type { OpenCodeRuntimeEvent } from './runtimeEvents.js';
import type { OpenCodeRuntimeScope } from './runtimeEvents.js';
import { projectOpenCodeRuntimeScope } from './openCodeRuntimeEvents.js';
import {
  resolveOpenCodeProjectedMcpToolName,
  type OpenCodeSessionMcpProjection,
} from './mcpRegistration.js';

export function buildOpenCodeToolResultOutput(part: OpenCodeToolPart): unknown {
  const title = normalizeString(part.state.title);
  const metadata = asRecord(part.state.metadata);
  if (!title && !metadata) return part.state.output ?? {};

  const outputRecord = asRecord(part.state.output);
  if (outputRecord) {
    return {
      ...outputRecord,
      ...(title ? { title } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }

  return {
    output: part.state.output ?? '',
    ...(title ? { title } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function publishOpenCodeToolPartRuntimeEvents(params: Readonly<{
  part: OpenCodeToolPart;
  state: OpenCodeServerRuntimeState;
  scope: OpenCodeRuntimeScope;
  publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => void;
  mcpProjection: OpenCodeSessionMcpProjection;
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
  nowMs?: () => number;
}>): void | Promise<void> {
  const turnId = params.state.activeTurnId;
  if (!params.part.nativeChildLaunch && (!params.state.turnInFlight || !turnId)) return;
  const outputScope = params.part.nativeChildLaunch || !turnId ? {} : { turnId };

  const callKey = readOpenCodeToolCallKey(params.part);
  const emittedAtMs = params.nowMs?.() ?? Date.now();
  const isTerminal = isTerminalOpenCodeToolPartStatus(params.part.state.status);
  const toolInput = params.part.state.input ?? {};

  const publish = (toolName: string): void => {
    // Alias reads may settle after the parent turn ended or changed. Do not
    // publish its evidence or mutate the successor turn's reused dedupe sets.
    if (!params.part.nativeChildLaunch && (!params.state.turnInFlight || params.state.activeTurnId !== turnId)) return;
    if (!params.state.currentTurnPublishedToolCallKeys.has(callKey)) {
      params.state.currentTurnPublishedToolCallKeys.add(callKey);
      params.publishRuntimeEvent({
        kind: 'tool-call',
        ...projectOpenCodeRuntimeScope(params.scope),
        ...outputScope,
        toolCallId: params.part.callID,
        toolName,
        toolInput,
        emittedAtMs,
      });
    }

    if (!isTerminal || params.state.currentTurnPublishedToolResultKeys.has(callKey)) return;

    params.state.currentTurnPublishedToolResultKeys.add(callKey);
    const status = params.part.state.status;
    params.publishRuntimeEvent({
      kind: 'tool-result',
      ...projectOpenCodeRuntimeScope(params.scope),
      ...outputScope,
      toolCallId: params.part.callID,
      output: buildOpenCodeToolResultOutput(params.part),
      emittedAtMs,
      ...(status === 'completed' ? {} : { isError: true }),
    });
  };
  // A result for an already published call needs no further identity read.
  if (params.state.currentTurnPublishedToolCallKeys.has(callKey)) return publish(params.part.tool);
  const name = resolveOpenCodeProjectedMcpToolName(params.part.tool, params.mcpProjection, params.mcpToolPolicy);
  return typeof name === 'string' ? publish(name) : name.then(publish);

}
