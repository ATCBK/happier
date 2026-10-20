import { StoredApprovalRequestSchema, type ApprovalRequest } from './approvalRequestV1.js';
import { APPROVAL_ARTIFACT_KINDS_V1 } from './approvalArtifactKindV1.js';
import { ActionIdSchema } from '../actions/actionIds.js';
import type { ApprovalQueueListItemV1, ApprovalQueueListResultV1 } from '../actions/executor/types.js';
export { APPROVAL_ARTIFACT_KINDS_V1 } from './approvalArtifactKindV1.js';
import {
  StoredExecutionRunHostActionApprovalRequestV1Schema,
  type ExecutionRunHostActionApprovalRequestV1,
} from './executionRunHostActionApprovalRequestV1.js';
import {
  StoredTargetActionApprovalRequestV1Schema,
  type TargetActionApprovalRequestV1,
} from './targetActionApprovalRequestV1.js';

/**
 * What the three builders below actually produce: an Artifact index header that
 * always carries the human title, plus the family-specific binding fields the
 * matchers re-check. Artifact stores require the title, so it is declared rather
 * than left to the passthrough index signature.
 */
export type ApprovalArtifactHeaderV1 = Readonly<{ title: string } & Record<string, unknown>>;

/**
 * What a reader may be handed: any stored Artifact header, including one this
 * version never wrote. Nothing is assumed about it before the matchers agree.
 */
export type ApprovalArtifactHeaderCandidateV1 = Readonly<Record<string, unknown>>;

export type ParsedApprovalArtifactBodyV1 =
  | Readonly<{ family: 'built_in'; request: ApprovalRequest }>
  | Readonly<{ family: 'target_action'; request: TargetActionApprovalRequestV1 }>
  | Readonly<{ family: 'execution_run_host_action'; request: ExecutionRunHostActionApprovalRequestV1 }>;

function optionalExactStringMatches(actual: unknown, expected: string | null): boolean {
  return expected === null
    ? actual === undefined || actual === null
    : actual === expected;
}

function sessionBindingMatches(header: ApprovalArtifactHeaderCandidateV1, sessionId: string | null): boolean {
  return optionalExactStringMatches(header.sessionId, sessionId)
    && (sessionId
      ? Array.isArray(header.sessions) && header.sessions.length === 1 && header.sessions[0] === sessionId
      : header.sessions === undefined || header.sessions === null);
}

export function buildApprovalRequestArtifactHeaderV1(
  request: ApprovalRequest,
  options: Readonly<{ legacyServerId?: string | null }> = {},
): ApprovalArtifactHeaderV1 {
  const origin = request.v === 2 ? request.executionOriginV1 : null;
  const sessionId = origin?.sessionId
    ?? (typeof request.createdBy.sessionId === 'string' ? request.createdBy.sessionId.trim() : '');
  const legacyServerId = options.legacyServerId?.trim() || null;
  return {
    v: 1,
    kind: APPROVAL_ARTIFACT_KINDS_V1.builtIn,
    title: request.summary,
    approvalStatus: request.status,
    actionId: request.actionId,
    ...(sessionId ? { sessions: [sessionId], sessionId } : {}),
    ...(origin ? { serverId: origin.serverId } : legacyServerId ? { serverId: legacyServerId } : {}),
    ...(origin?.serverIdentityId ? { serverIdentityId: origin.serverIdentityId } : {}),
    ...(origin?.machineId ? { machineId: origin.machineId } : {}),
    ...(origin?.runId ? { runId: origin.runId } : {}),
    ...(origin?.runOccurrenceId ? { runOccurrenceId: origin.runOccurrenceId } : {}),
  };
}

export function approvalRequestArtifactHeaderMatches(
  header: ApprovalArtifactHeaderCandidateV1,
  request: ApprovalRequest,
): boolean {
  const origin = request.v === 2 ? request.executionOriginV1 : null;
  const sessionId = origin?.sessionId
    ?? (typeof request.createdBy.sessionId === 'string' ? request.createdBy.sessionId.trim() : '');
  return header.v === 1
    && header.kind === APPROVAL_ARTIFACT_KINDS_V1.builtIn
    && header.title === request.summary
    && header.approvalStatus === request.status
    && header.actionId === request.actionId
    && sessionBindingMatches(header, sessionId || null)
    && (request.v === 1 || (
      optionalExactStringMatches(header.serverId, origin?.serverId ?? null)
      && optionalExactStringMatches(header.serverIdentityId, origin?.serverIdentityId ?? null)
      && optionalExactStringMatches(header.machineId, origin?.machineId ?? null)
      && optionalExactStringMatches(header.runId, origin?.runId ?? null)
      && optionalExactStringMatches(header.runOccurrenceId, origin?.runOccurrenceId ?? null)
    ));
}

export function buildTargetActionApprovalArtifactHeaderV1(
  request: TargetActionApprovalRequestV1,
): ApprovalArtifactHeaderV1 {
  const origin = request.executionOriginV1;
  const sessionId = origin?.sessionId
    ?? request.replayPlacement?.defaultSessionId
    ?? request.createdBy.sessionId
    ?? null;
  const serverId = origin?.serverId ?? request.replayPlacement?.serverId ?? null;
  const machineId = origin?.machineId ?? request.replayPlacement?.machineId ?? null;
  return {
    v: 1,
    kind: APPROVAL_ARTIFACT_KINDS_V1.targetAction,
    title: request.summary,
    approvalStatus: request.status,
    qualifiedActionId: request.qualifiedActionId,
    subjectFingerprint: request.subjectFingerprint,
    ...(serverId ? { serverId } : {}),
    ...(origin?.serverIdentityId ? { serverIdentityId: origin.serverIdentityId } : {}),
    ...(machineId ? { machineId } : {}),
    ...(origin?.runId ? { runId: origin.runId } : {}),
    ...(origin?.runOccurrenceId ? { runOccurrenceId: origin.runOccurrenceId } : {}),
    ...(sessionId ? { sessionId, sessions: [sessionId] } : {}),
  };
}

export function targetActionApprovalArtifactHeaderMatches(
  header: ApprovalArtifactHeaderCandidateV1,
  request: TargetActionApprovalRequestV1,
): boolean {
  const origin = request.executionOriginV1;
  const placement = request.replayPlacement;
  const sessionId = origin?.sessionId ?? placement?.defaultSessionId ?? request.createdBy.sessionId ?? null;
  const serverId = origin?.serverId ?? placement?.serverId ?? null;
  const machineId = origin?.machineId ?? placement?.machineId ?? null;
  return header.v === 1
    && header.kind === APPROVAL_ARTIFACT_KINDS_V1.targetAction
    && header.title === request.summary
    && header.approvalStatus === request.status
    && header.qualifiedActionId === request.qualifiedActionId
    && header.subjectFingerprint === request.subjectFingerprint
    && optionalExactStringMatches(header.serverId, serverId)
    && optionalExactStringMatches(header.serverIdentityId, origin?.serverIdentityId ?? null)
    && optionalExactStringMatches(header.machineId, machineId)
    && optionalExactStringMatches(header.runId, origin?.runId ?? null)
    && optionalExactStringMatches(header.runOccurrenceId, origin?.runOccurrenceId ?? null)
    && sessionBindingMatches(header, sessionId);
}

export function buildExecutionRunHostActionApprovalArtifactHeaderV1(
  request: ExecutionRunHostActionApprovalRequestV1,
): ApprovalArtifactHeaderV1 {
  return {
    v: 1,
    kind: APPROVAL_ARTIFACT_KINDS_V1.executionRunHostAction,
    title: request.summary,
    approvalStatus: request.status,
    actionId: request.actionId,
    sessionId: request.sessionId,
    sessions: [request.sessionId],
    runId: request.runId,
    profileId: request.profileId,
    subjectFingerprint: request.subjectFingerprint,
    serverId: request.serverId,
  };
}

export function executionRunHostActionApprovalArtifactHeaderMatches(
  header: ApprovalArtifactHeaderCandidateV1,
  request: ExecutionRunHostActionApprovalRequestV1,
): boolean {
  return header.v === 1
    && header.kind === APPROVAL_ARTIFACT_KINDS_V1.executionRunHostAction
    && header.title === request.summary
    && header.approvalStatus === request.status
    && header.actionId === request.actionId
    && header.runId === request.runId
    && header.profileId === request.profileId
    && header.subjectFingerprint === request.subjectFingerprint
    && optionalExactStringMatches(header.serverId, request.serverId)
    && sessionBindingMatches(header, request.sessionId);
}

/**
 * Canonical body-authoritative approval Artifact reader. The header is only an
 * index: callers must hydrate the body and accept the Artifact only when the
 * strict family schema and every duplicated header field agree.
 */
export function approvalArtifactBodyMatchesHeaderV1(
  header: ApprovalArtifactHeaderCandidateV1,
  body: string | null | undefined,
): ParsedApprovalArtifactBodyV1 | null {
  if (typeof body !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }

  if (header.kind === APPROVAL_ARTIFACT_KINDS_V1.builtIn) {
    const parsed = StoredApprovalRequestSchema.safeParse(value);
    return parsed.success && approvalRequestArtifactHeaderMatches(header, parsed.data)
      ? { family: 'built_in', request: parsed.data }
      : null;
  }
  if (header.kind === APPROVAL_ARTIFACT_KINDS_V1.targetAction) {
    const parsed = StoredTargetActionApprovalRequestV1Schema.safeParse(value);
    return parsed.success && targetActionApprovalArtifactHeaderMatches(header, parsed.data)
      ? { family: 'target_action', request: parsed.data }
      : null;
  }
  if (header.kind === APPROVAL_ARTIFACT_KINDS_V1.executionRunHostAction) {
    const parsed = StoredExecutionRunHostActionApprovalRequestV1Schema.safeParse(value);
    return parsed.success && executionRunHostActionApprovalArtifactHeaderMatches(header, parsed.data)
      ? { family: 'execution_run_host_action', request: parsed.data }
      : null;
  }
  return null;
}

type ApprovalListArtifactV1 = Readonly<{
  artifactId: string;
  header: ApprovalArtifactHeaderCandidateV1;
  body?: unknown;
  updatedAt: number;
}>;

/** One strict private queue projection for keyholding Account Artifact stores. */
export async function listApprovalArtifactsV1(params: Readonly<{
  status?: ApprovalRequest['status'] | null;
  limit?: number | null;
  serverId?: string | null;
  readPage: (options: Readonly<{ limit: number; includeBody: true; cursor?: string }>) => Promise<Readonly<{
    items: readonly ApprovalListArtifactV1[];
    nextCursor?: string;
  }>>;
  read: (artifactId: string) => Promise<Readonly<{ header: ApprovalArtifactHeaderCandidateV1; body?: unknown; updatedAt: number }> | null>;
}>): Promise<ApprovalQueueListResultV1> {
  const items: ApprovalQueueListItemV1[] = [];
  const serverId = params.serverId?.trim() || null;
  // Preserve the approval.request.list input contract and incumbent default.
  const maxItems = typeof params.limit === 'number' && Number.isFinite(params.limit)
    ? Math.max(1, Math.min(100, Math.trunc(params.limit))) : 32;
  let cursor: string | undefined;
  do {
    const page = await params.readPage({ limit: maxItems, includeBody: true, ...(cursor ? { cursor } : {}) });
    for (const artifact of page.items) {
      if (items.length >= maxItems) break;
      if (artifact.header.kind !== APPROVAL_ARTIFACT_KINDS_V1.builtIn
        && artifact.header.kind !== APPROVAL_ARTIFACT_KINDS_V1.targetAction) continue;
      // Complete pages already pair header/body revisions. Only omitted or
      // unreadable bodies need the store's canonical individual read path.
      const hydrated = typeof artifact.body === 'string' ? artifact : await params.read(artifact.artifactId);
      if (typeof hydrated?.body !== 'string') continue;
      const parsed = approvalArtifactBodyMatchesHeaderV1(hydrated.header, hydrated.body);
      if (!parsed || parsed.family === 'execution_run_host_action') continue;
      const request = parsed.request;
      if (params.status && request.status !== params.status) continue;
      const headerServerId = typeof hydrated.header.serverId === 'string' ? hydrated.header.serverId.trim() || null : null;
      // V1 history retains its released profile-scoped behavior. V2 custody is
      // Account-scoped; its strict body validates the creator profile and Home.
      if (parsed.family === 'built_in' && request.v === 1 && serverId && headerServerId !== serverId) continue;
      const actionId = ActionIdSchema.safeParse(parsed.family === 'target_action' ? 'action.invoke' : parsed.request.actionId);
      if (!actionId.success || !request.summary) continue;
      const sessionId = typeof hydrated.header.sessionId === 'string' ? hydrated.header.sessionId.trim() : '';
      items.push({ artifactId: artifact.artifactId, status: request.status, actionId: actionId.data, summary: request.summary,
        ...(sessionId ? { sessionId } : {}), ...(headerServerId ? { serverId: headerServerId } : {}),
        updatedAtMs: Number.isFinite(hydrated.updatedAt) ? hydrated.updatedAt : 0 });
    }
    cursor = items.length < maxItems ? page.nextCursor : undefined;
  } while (cursor);
  return { items, queryPlan: { kind: 'approval_artifact_header_scan', backingStore: 'ArtifactStore',
    boundedBy: items.length >= maxItems ? 'requested matching approval count' : 'ArtifactStore source exhaustion',
    serverLimit: maxItems, hydratedTranscripts: false } };
}
