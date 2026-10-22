import type { ToolCall } from '@happier-dev/session-core/messages';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions';
import {
  isRecord,
  readHappierActionToolResultCandidates,
} from '@happier-dev/protocol/actions/happierActionToolResult';

import {
  resolveToolActionFailure,
  type ToolActionFailurePresentation,
} from './resolveToolActionFailure';
import {
  resolveToolStatusIndicatorKind,
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

/** The most decoded form of a result: the parsed text of an MCP text envelope, its structured content, or the payload. */
export function readDecodedToolResult(tool: ToolCall): unknown {
  const candidates = readHappierActionToolResultCandidates(
    tool.result,
    tool.input,
  );
  return candidates.length > 0
    ? candidates[candidates.length - 1]
    : maybeParseJson(tool.result);
}

export function resolveToolCallOutcome(tool: ToolCall): ToolCallOutcome {
  const indicator = resolveToolStatusIndicatorKind(tool);
  const failure = indicator === 'error' ? resolveToolActionFailure(tool) : null;
  if (failure) return { kind: 'failure', failure };
  if (indicator !== 'completed' || tool.result == null)
    return { kind: 'status', indicator };
  const decoded = readDecodedToolResult(tool);
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(decoded);
  if (approval.success)
    return { kind: 'approval_requested', artifactId: approval.data.artifactId };
  // A settlement union's `pending` arm: the request was taken, its effect had not settled yet.
  if (isRecord(decoded) && decoded.type === 'pending') {
    const {
      type: _type,
      outcome,
      retryWithSameCreationKey: _retry,
      ...details
    } = decoded;
    return { kind: 'pending', confirmed: outcome !== 'unknown', details };
  }
  return { kind: 'status', indicator };
}
