import type { ToolCall } from '@happier-dev/session-core/messages';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import {
  isRecord,
  readHappierActionToolResultCandidates,
} from '@happier-dev/protocol/actions/happierActionToolResult';
import { readHappierActionCallId } from '@/components/sessions/transcript/references/happierActionToolResult';

import {
  resolveToolActionFailure,
  type ToolActionFailurePresentation,
} from './resolveToolActionFailure';
import {
  resolveToolStatusIndicatorKind,
  type DeclinedApprovalDisposition,
  type ToolStatusIndicatorKind,
} from './resolveToolStatusIndicatorKind';

/**
 * What a call came to, read once for the tool-details page's header and its Result section:
 * a typed refusal or failure, a request sent for approval (the effect waits on it), an accepted
 * request that had not settled when the call returned, or the call's plain status.
 */
export type ToolCallOutcome =
  | Readonly<{ kind: 'failure'; failure: ToolActionFailurePresentation }>
  | Readonly<{ kind: 'approval_requested'; artifactId: string }>
  | Readonly<{
      kind: 'pending';
      confirmed: boolean;
      details: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ kind: 'status'; indicator: ToolStatusIndicatorKind }>;

/** Structured MCP output takes precedence over supplementary text; otherwise retain text/bridge decoding. */
export function readDecodedToolResult(tool: ToolCall): unknown {
  const candidates = readHappierActionToolResultCandidates(
    tool.result,
    tool.input,
  );
  const envelope = candidates[0];
  if (isRecord(envelope) && envelope.structuredContent != null)
    return envelope.structuredContent;
  return candidates.length > 0
    ? candidates[candidates.length - 1]
    : maybeParseJson(tool.result);
}

export function resolveToolCallOutcome(
  tool: ToolCall,
  declinedApproval: DeclinedApprovalDisposition | null = null,
): ToolCallOutcome {
  const indicator = resolveToolStatusIndicatorKind(tool, declinedApproval);
  const failure = indicator === 'error' ? resolveToolActionFailure(tool) : null;
  if (failure) return { kind: 'failure', failure };
  if (indicator !== 'completed' || tool.result == null)
    return { kind: 'status', indicator };
  const actionId = readHappierActionCallId(tool.name, tool.input);
  if (!actionId) return { kind: 'status', indicator };
  const decoded = readDecodedToolResult(tool);
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(decoded);
  if (approval.success)
    return { kind: 'approval_requested', artifactId: approval.data.artifactId };
  // Only Session creation's strict settlement union gives `pending` this meaning.
  const settlement = actionId === 'session.spawn_new' ? SessionSpawnNewResultV1Schema.safeParse(decoded) : null;
  if (settlement?.success && settlement.data.type === 'pending') {
    const {
      type: _type,
      outcome,
      retryWithSameCreationKey: _retry,
      ...details
    } = settlement.data;
    return { kind: 'pending', confirmed: outcome === 'accepted', details };
  }
  return { kind: 'status', indicator };
}
