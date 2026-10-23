import { resolveAgentRequestKind, type AgentRequestKind } from '@happier-dev/protocol/activity/agentRequestSummary';

export type NewPermissionRequest = Readonly<{
  requestId: string;
  turnId?: string;
  requestKind: AgentRequestKind;
  toolName: string;
  toolArgs: unknown;
}>;

type RequestsMap = Record<string, unknown>;

function toRecord(value: unknown): RequestsMap {
  if (!value || typeof value !== 'object') return {};
  return value as RequestsMap;
}

function compareNewRequests(a: NewPermissionRequest, b: NewPermissionRequest, nextRaw: RequestsMap): number {
  const aRaw = toRecord(nextRaw[a.requestId]);
  const bRaw = toRecord(nextRaw[b.requestId]);
  const aCreatedAt = typeof aRaw?.createdAt === 'number' && Number.isFinite(aRaw.createdAt) ? aRaw.createdAt : null;
  const bCreatedAt = typeof bRaw?.createdAt === 'number' && Number.isFinite(bRaw.createdAt) ? bRaw.createdAt : null;

  if (aCreatedAt != null && bCreatedAt != null && aCreatedAt !== bCreatedAt) {
    return aCreatedAt - bCreatedAt;
  }
  return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
}

export function deriveNewAgentRequests(prevRequests: unknown, nextRequests: unknown): NewPermissionRequest[] {
  const prev = toRecord(prevRequests);
  const next = toRecord(nextRequests);
  const results: NewPermissionRequest[] = [];

  for (const [requestId, value] of Object.entries(next)) {
    const raw = toRecord(value);
    const previous = toRecord(prev[requestId]);
    const turnId = typeof raw.turnId === 'string' ? raw.turnId.trim() : '';
    const previousTurnId = typeof previous.turnId === 'string' ? previous.turnId.trim() : '';
    if (Object.prototype.hasOwnProperty.call(prev, requestId) && (!turnId || turnId === previousTurnId)) continue;
    const toolName = typeof raw?.tool === 'string' ? raw.tool.trim() : '';
    if (!toolName) continue;
    results.push({
      requestId,
      ...(turnId ? { turnId } : {}),
      requestKind: resolveAgentRequestKind({ toolName, requestKind: raw?.kind }),
      toolName,
      toolArgs: raw?.arguments,
    });
  }

  results.sort((a, b) => compareNewRequests(a, b, next));
  return results;
}
