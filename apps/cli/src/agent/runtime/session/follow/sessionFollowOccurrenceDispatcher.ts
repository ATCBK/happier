import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { evaluateSessionFollowRuleOccurrenceV1, type SessionFollowRuleSourceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { resolveFollowDeliveryV1, isFollowPolicyEqualV1, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { SessionFollowObserveSourceRoutesRequestV1Schema, SessionFollowObserveSourceRoutesResponseV1Schema, SessionFollowRunOccurrenceRoutesResponseV1Schema, type SessionFollowSessionPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SessionFollowSourceOccurrenceRoutesResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { DiscussionMessageRefV1Schema } from '@happier-dev/protocol/discussions/messageRefs';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1, ListSessionFollowSourcesResponseSchema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import type { RunFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { deriveSessionFollowInputLocalIdV1, RunFollowOccurrenceV1Schema, type SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { SessionFollowRunOccurrence } from '@/daemon/sessions/sessionActivityChangedContract';
import { isFollowDeliveryMutedV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionFollowRelationWitnessesV1Schema, type SessionFollowRelationWitnessV1, type SessionFollowSourceOccurrenceWitnessV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readSessionDeliveryMutedScopes } from '@/api/sessionDeliveryMuteTransport';
import { readCliSessionListFilterFactsV1 } from '@/cli/output/session/sessionListFilterFacts';
import type { StoredCredentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import type { PersonalFollowOccurrenceDispatch, PersonalFollowOccurrenceDispatchResult } from '@/notifications/activity/dispatchPersonalFollowOccurrence';
import type { SessionActivityChangedResult } from '@/daemon/sessions/sessionActivityChangedContract';
import { createAccountSessionFollowRuleCache } from './accountSessionFollowRuleCache';
import { logger } from '@/ui/logger';
import { readCommittedSessionFollowSourceOccurrence, type SessionFollowAccountOccurrence } from './sessionFollowRuleSourceEvidence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import type { FollowEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { createSessionFollowSourceKeyPreparationAfterSet } from './createSessionFollowSourceKeyPreparationAfterSet';
import { submitAccountFollowPersonalProgress } from '@/api/sessionFollowPersonalProgressTransport';
import { openSessionStateValue } from '@happier-dev/sync-client';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { decryptSessionPayload, encryptSessionPayload, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchInactiveSessionFollowObservations } from '@/session/transport/http/sessionFollowInactiveObservationsHttp';
import { resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { isSessionFollowFrontierEqualV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { createSessionFollowSourceHydrator } from './sessionFollowSourceHydrator';
import { shouldWakeForSessionFollowWorkerUpdate } from './sessionFollowContextReconciler';
import { readActiveForegroundAgentRequests, readForegroundAgentRequestFollowEvent } from '@/agent/permissions/activeForegroundRequests';
import { captureSemanticSessionFollowRuleSourceEvidence } from './sessionFollowRuleSourceEvidence';
import { ListSessionFollowRulesResponseV1Schema, SESSION_FOLLOW_RULES_ROUTE_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { ListAccountSessionFollowsResponseV1Schema } from '@happier-dev/protocol/sessions/follow/api';
import { matchSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { SessionFollowRuleInvalidation } from './sessionFollowRuleCache';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
export type { SessionFollowAccountOccurrence } from './sessionFollowRuleSourceEvidence';
export type SessionFollowReceiverRangeResult = Readonly<{ coveredEvents: readonly Readonly<{
  sourceSessionId: string; kind: FollowEventV1['kind'];
}>[]; receiverSessionIds?: readonly string[] }>;
export type { SessionFollowRunOccurrence } from '@/daemon/sessions/sessionActivityChangedContract';
export type SessionFollowOccurrenceDispatch = Readonly<
  { occurrence: SessionFollowRuleSourceOccurrenceV1 | SessionFollowRunOccurrence; destinationSessionId?: never; contextSessionId?: string }
  | { occurrence: SessionFollowAccountOccurrence; destinationSessionId: string }
  | { observations: readonly SessionFollowSessionPendingObservationV1[]; destinationSessionId: string; sourceSessionId?: string; occurrence?: never }
  | { sourceSessionIdChanged: string; contextSessionId?: string; occurrence?: never; destinationSessionId?: never }
  | { accountFollowSourcesChanged: Readonly<{ sourceSessionId?: string; workflowRunIds?: readonly string[]; discussionIds?: readonly string[] }>; occurrence?: never; destinationSessionId?: never }
>;

/** One captured Account daemon: original read, current predicate, route union, existing Pending admission. */
export function createSessionFollowOccurrenceDispatcher(input: Readonly<{
  accountId: string; credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string;
  machineId: string; installationId: string; signal: AbortSignal;
  isCurrent: () => Promise<boolean>;
  subscribeInvalidation: (listener: (change?: SessionFollowRuleInvalidation) => void) => () => void;
  /** Borrowed from the already-retained requester Account lifetime, never an installed Account substitute. */
  rulesCache?: ReturnType<typeof createAccountSessionFollowRuleCache>;
  spawnSession?: Parameters<typeof sendSessionMessage>[0]['spawnSession'];
  isSessionAlreadyRunning?: (sessionId: string) => Promise<boolean>;
  resolveServerFeaturesSnapshot?: () => Promise<Parameters<typeof sendSessionMessage>[0]['serverFeaturesSnapshot']>;
  resolveSourceKeyContext: () => Promise<ActionExecutorContext | null>;
  /** Personal effects require their own saved-settings scope, not Session delivery's Account observation. */
  isPersonalCurrent: () => boolean | Promise<boolean>;
  dispatchPersonal: (dispatch: PersonalFollowOccurrenceDispatch, isCurrent: () => Promise<boolean>) => Promise<PersonalFollowOccurrenceDispatchResult | void>;
}>) {
  const rules = input.rulesCache ?? createAccountSessionFollowRuleCache({ ...input,
    isCurrent: input.isCurrent,
  });
  const current = async () => !input.signal.aborted && await input.isCurrent();
  // Only routing identities and fixed decision categories cross this diagnostic boundary.
  const checkpoint = (facts: Readonly<{ entry: 'source' | 'receiver' | 'receiver_range'; sourceSessionId?: string;
    destinationSessionId?: string; sourceMessageSeq?: number; agentStateVersion?: number }>,
    phase: string, status: 'started' | 'completed' | 'held', details: Readonly<{
      reason?: string; httpStatus?: number; candidateCount?: number; afterSeq?: number; throughSeq?: number;
      sourceSessionId?: string; sourceMessageSeq?: number;
    }> = {}) => logger.debug('[Session Follow] Dispatch checkpoint', { ...facts, phase, status, ...details });
  const prepareSourceKey = createSessionFollowSourceKeyPreparationAfterSet({ credentials: input.credentials,
    serverHttpBaseUrl: input.serverHttpBaseUrl, resolveServerFeaturesSnapshot: input.resolveServerFeaturesSnapshot });
  // Turn-only waiting/stall/terminal facts have no required original input.
  // They share source traversal/admission with originals, then retain their
  // existing host context-only acceptance and frontier ACK.
  const dispatchManagerTurn = async (observation: SessionFollowSessionPendingObservationV1,
    coveredKinds: ReadonlySet<FollowEventV1['kind']>) => {
    const sessionId = observation.destinationSessionId;
    const turn = observation.observed.turn;
    if (observation.relation !== 'manager' || !turn
      || isSessionFollowFrontierEqualV1(observation.delivered, observation.observed)
      || !input.spawnSession || !input.isSessionAlreadyRunning) return;
    const turnKind = turn.status === 'completed' ? 'finished'
      : turn.status === 'failed' || turn.status === 'cancelled' ? 'failed_or_stopped'
      : turn.status === 'waiting' ? 'needs_you' : 'stalled';
    if (coveredKinds.has(turnKind)) return;
    if (!await current() || await input.isSessionAlreadyRunning(sessionId)) return;
    const readReceiver = async () => {
      const receiver = await resolveSessionTransportContext({ credentials: input.credentials, idOrPrefix: sessionId, signal: input.signal });
      if (!receiver.ok || receiver.sessionId !== sessionId || !await current()) return null;
      const metadata = tryDecryptSessionOwnerMetadataView({ credentials: input.credentials, rawSession: receiver.rawSession,
        accountEncryptionMode: receiver.accountEncryptionCurrentness.mode });
      return metadata && resolveSessionAutoResumeAdmissionV1({ metadata, archivedAt: receiver.rawSession.archivedAt,
        machineAvailable: true, authorityAvailable: true }) === 'eligible' ? { ...receiver, metadata } : null;
    };
    if (!await readReceiver()) return;
    const hydrate = createSessionFollowSourceHydrator({ credentials: input.credentials, session: {
      sessionId,
      runSessionFollowSourceRequest: ({ credentials, request }) => {
        if (credentials.token !== input.credentials.token) throw new Error('Follow credentials do not belong to the observed Home');
        return runWithServerHttpBaseUrl(input.serverHttpBaseUrl, request);
      },
    } });
    const source = await hydrate({ observation, signal: input.signal });
    if (!source || !shouldWakeForSessionFollowWorkerUpdate(observation, source)
      || source.recheckWorkerUpdateAdmission && !await source.recheckWorkerUpdateAdmission(input.signal)) return;
    const receiver = await readReceiver();
    const origin = await input.resolveSourceKeyContext();
    if (!receiver || !origin || !await current()) return;
    const observed = await fetchInactiveSessionFollowObservations({ token: input.credentials.token,
      destinationSessionId: sessionId, machineId: input.machineId, installationId: input.installationId, signal: input.signal });
    if (!observed?.ok || observed.target.homeId !== origin.serverIdentityId || observed.target.accountId !== input.accountId
      || observed.target.sessionId !== sessionId || observed.target.machineId !== input.machineId
      || observed.target.installationId !== input.installationId || !await current()) return;
    const pending = observed.observations.find(candidate => 'sourceSessionId' in candidate && !('kind' in candidate)
      && candidate.sourceSessionId === observation.sourceSessionId && candidate.relation === observation.relation
      && candidate.attachedAt === observation.attachedAt
      && isFollowPolicyEqualV1(candidate.policy, observation.policy)
      && isSessionFollowFrontierEqualV1(candidate.delivered, observation.delivered)
      && isSessionFollowFrontierEqualV1(candidate.observed, observation.observed));
    if (!pending || !await current() || await input.isSessionAlreadyRunning(sessionId)) return;
    await requestInactiveSessionResume({ credentials: input.credentials, sessionId, rawSession: receiver.rawSession,
      metadata: receiver.metadata, requestId: randomUUID(), executionAuthority: 'account_automation',
      spawnSession: input.spawnSession, signal: input.signal });
    return true;
  };
  const dispatchRun = async (request: SessionFollowRunOccurrence | Readonly<{ source: RunFollowOriginalV1['source'] }>, receiverSessionId?: string, personalOnly = false): Promise<void> => {
    if (!await current()) return;
    const response = await axios.post(`${input.serverHttpBaseUrl}${SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes}`,
      { v: 1, ...('original' in request ? { original: request.original } : { source: request.source }) }, { headers: { Authorization: `Bearer ${input.credentials.token}` },
        signal: input.signal, validateStatus: () => true });
    const parsed = response.status === 200 ? SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse(response.data) : null;
    if (!parsed?.success || !parsed.data.ok || 'original' in request && !sameStrictJsonValue(parsed.data.original, request.original)
      || !await current()) return;
    const occurrence = RunFollowOccurrenceV1Schema.parse({ original: parsed.data.original, event: parsed.data.event });
    if (!receiverSessionId && parsed.data.personal && !parsed.data.personal.alreadyRepresented && await input.isPersonalCurrent() && await current()) {
      const policies = [parsed.data.personal.policy];
      await input.dispatchPersonal({ occurrence, policies, signal: input.signal, acceptDelivery: async () => {
        if (!await current() || !await input.isPersonalCurrent()) return false;
        const accepted = await submitAccountFollowPersonalProgress({ token: input.credentials.token,
          serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal, occurrence: { original: occurrence.original } });
        return accepted?.accepted === true && !accepted.alreadyRepresented;
      } }, async () => {
        if (!await current() || !await input.isPersonalCurrent()) return false;
        const response = await axios.post(`${input.serverHttpBaseUrl}${SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes}`,
          { v: 1, original: occurrence.original }, { headers: { Authorization: `Bearer ${input.credentials.token}` },
            signal: input.signal, validateStatus: () => true });
        const latest = response.status === 200 ? SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse(response.data) : null;
        return Boolean(latest?.success && latest.data.ok && latest.data.personal
          && isFollowPolicyEqualV1(latest.data.personal.policy, policies[0]!)
          && sameStrictJsonValue(latest.data.original, occurrence.original));
      });
    }
    if (personalOnly) return;
    for (const route of parsed.data.routes) {
      if (receiverSessionId !== undefined && route.destinationSessionId !== receiverSessionId) continue;
      const selected = resolveFollowDeliveryV1({ policies: [route.policy], event: occurrence.event });
      if (!selected.selected || !await current()) continue;
      const source = occurrence.original.source;
      const muted = await readSessionDeliveryMutedScopes({ token: input.credentials.token,
        receiver: { kind: 'session', sessionId: route.destinationSessionId }, serverHttpBaseUrl: input.serverHttpBaseUrl,
        signal: input.signal });
      if (!muted || isFollowDeliveryMutedV1(muted, { source,
        ...(source.kind === 'execution_run' ? { senderSessionId: source.sessionId } : {}) })) continue;
      const delivery = { v: 1 as const, original: occurrence.original, event: occurrence.event,
        delivery: selected.session.wake ? 'wake' as const : 'next_turn' as const };
      const relation = { relation: route.relation, attachedAt: route.attachedAt, source,
        ...('expectedRevision' in route ? { expectedRevision: route.expectedRevision }
          : { expectedTerminalEventId: route.expectedTerminalEventId }) };
      const admission = buildTrustedHostSessionInputAdmissionV1('agent');
      const features = await input.resolveServerFeaturesSnapshot?.();
      await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => sendSessionMessage({ credentials: input.credentials,
        idOrPrefix: route.destinationSessionId, wait: false,
        localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: route.destinationSessionId, original: delivery.original }),
        timeoutMs: resolveSessionMessageAdmissionTimeoutMs(), message: `Followed Run ${occurrence.event.kind}: ${JSON.stringify(source)}. Read this Run's current source.`,
        inputAdmission: { provenance: admission.provenance,
          request: SessionInputRequestV1Schema.parse({ ...admission.request, followDeliveryV1: delivery }) },
        followRelations: SessionFollowRelationWitnessesV1Schema.parse([relation]), informationDelivery: 'session_follow', executionAuthority: 'account_automation',
        resumeInactiveSession: selected.session.wake, ...(input.spawnSession ? { spawnSession: input.spawnSession } : {}),
        ...(features ? { serverFeaturesSnapshot: features } : {}), signal: input.signal }));
    }
  };
  const dispatchDiscussion = async (source: Readonly<{ kind: 'discussion'; discussionId: string }>) => {
    const read = async (messageId?: string) => {
      if (!await current() || !await input.isPersonalCurrent()) return null;
      const response = await axios.post(`${input.serverHttpBaseUrl}${SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes}`,
        { v: 1, source, ...(messageId ? { messageId } : {}) }, { headers: { Authorization: `Bearer ${input.credentials.token}` },
          signal: input.signal, validateStatus: () => true });
      const parsed = response.status === 200 ? SessionFollowSourceOccurrenceRoutesResponseV1Schema.safeParse(response.data) : null;
      return parsed?.success && parsed.data.ok && 'discussion' in parsed.data && await current() ? parsed.data.discussion : null;
    };
    for (;;) {
      const occurrence = await read();
      if (!occurrence || occurrence.personal.alreadyRepresented) return;
      const original = DiscussionMessageRefV1Schema.parse({ kind: 'discussion',
        discussion: { serverId: input.serverId, discussionId: source.discussionId }, messageId: occurrence.messageId });
      let settled = false;
      await input.dispatchPersonal({ occurrence: { discussion: { original, seq: occurrence.seq, event: occurrence.event } },
        policies: [occurrence.personal.policy], signal: input.signal, acceptDelivery: async () => {
          if (!await current() || !await input.isPersonalCurrent()) return false;
          const acceptance = await submitAccountFollowPersonalProgress({ token: input.credentials.token,
            serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal, occurrence: { discussion: { original, seq: occurrence.seq } } });
          settled = acceptance?.accepted === true;
          return settled && acceptance?.alreadyRepresented === false;
        } }, async () => {
          const latest = await read(occurrence.messageId);
          return Boolean(latest && latest.seq === occurrence.seq && sameStrictJsonValue(latest.source, source)
            && isFollowPolicyEqualV1(latest.personal.policy, occurrence.personal.policy));
        });
      // Unavailable progress custody holds this exact original. A read
      // never consumes it or spins while the same effect remains unrepresented.
      if (!settled) return;
    }
  };
  const dispatchAccountSourceRange = async (filter: Readonly<{ sourceSessionId?: string; workflowRunIds?: readonly string[]; discussionIds?: readonly string[] }> = {}) => {
    // The retained-source owner proves the personal relation itself. Exact
    // source hints need no Account-wide discovery; reconnects still page it.
    if (filter.sourceSessionId === undefined && (filter.workflowRunIds || filter.discussionIds)) {
      for (const runId of new Set(filter.workflowRunIds)) {
        if (!await current() || !await input.isPersonalCurrent()) return;
        await dispatchRun({ source: { kind: 'workflow_run', runId } }, undefined, true);
      }
      for (const discussionId of new Set(filter.discussionIds)) {
        if (!await current() || !await input.isPersonalCurrent()) return;
        await dispatchDiscussion({ kind: 'discussion', discussionId });
      }
      return;
    }
    let cursor: string | undefined;
    do {
      if (!await current() || !await input.isPersonalCurrent()) return;
      const response = await axios.get(`${input.serverHttpBaseUrl}/v2/account/session-follows`, {
        headers: { Authorization: `Bearer ${input.credentials.token}` }, ...(cursor ? { params: { cursor } } : {}),
        signal: input.signal, validateStatus: () => true,
      });
      const page = response.status === 200 ? ListAccountSessionFollowsResponseV1Schema.safeParse(response.data) : null;
      if (!page?.success || !await current()) return;
      for (const relation of page.data.follows) {
        if (!('source' in relation)) continue;
        const source = relation.source;
        if (source.kind !== 'execution_run' && source.kind !== 'workflow_run' && source.kind !== 'discussion') continue;
        if (filter.sourceSessionId && (source.kind !== 'execution_run' || source.sessionId !== filter.sourceSessionId)) continue;
        if ((filter.workflowRunIds || filter.discussionIds) && !(source.kind === 'workflow_run' && filter.workflowRunIds?.includes(source.runId)
          || source.kind === 'discussion' && filter.discussionIds?.includes(source.discussionId))) continue;
        if (source.kind === 'discussion') await dispatchDiscussion(source);
        else await dispatchRun({ source }, undefined, true);
      }
      cursor = page.data.continuation;
    } while (cursor && await current());
  };
  const readRoutes = async (occurrence: SessionFollowRuleSourceOccurrenceV1 | SessionFollowAccountOccurrence, destinationSessionId?: string) => {
    const request = SessionFollowObserveSourceRoutesRequestV1Schema.parse({ v: 1,
      ...('sourcePublisher' in occurrence ? { sourcePublisher: occurrence.sourcePublisher }
        : destinationSessionId ? { destinationSessionId } : {}),
      ...('sourceMessage' in occurrence ? { sourceMessage: occurrence.sourceMessage } : { sourceRequests: occurrence.sourceRequests }) });
    const path = SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.occurrenceRoutes.replace(':sourceSessionId', encodeURIComponent(occurrence.sourceSessionId));
    const response = await axios.post(`${input.serverHttpBaseUrl}${path}`, request, {
      headers: { Authorization: `Bearer ${input.credentials.token}` }, signal: input.signal, validateStatus: () => true,
    });
    if (response.status !== 200 || !await current()) return null;
    const parsed = SessionFollowObserveSourceRoutesResponseV1Schema.safeParse(response.data);
    return parsed.success && parsed.data.ok && parsed.data.sourceSessionId === occurrence.sourceSessionId ? parsed.data : null;
  };
  const dispatch = async (occurrence: SessionFollowRuleSourceOccurrenceV1 | SessionFollowAccountOccurrence, receiverSessionId?: string,
    fromSourceRange = false): Promise<SessionActivityChangedResult | void> => {
      let personalFollow: SessionActivityChangedResult['personalFollow'];
      const diagnostic = { entry: receiverSessionId ? 'receiver' as const : 'source' as const,
        sourceSessionId: occurrence.sourceSessionId, ...(receiverSessionId ? { destinationSessionId: receiverSessionId } : {}),
        ...('sourceMessage' in occurrence ? { sourceMessageSeq: occurrence.sourceMessage.seq }
          : { agentStateVersion: occurrence.sourceRequests.agentStateVersion }) };
      checkpoint(diagnostic, 'currentness', 'started');
      if (!await current()) { checkpoint(diagnostic, 'currentness', 'held', { reason: 'account_not_current' }); return; }
      if (!receiverSessionId && (!('sourcePublisher' in occurrence) || occurrence.sourcePublisher.machineId !== input.machineId)) {
        checkpoint(diagnostic, 'currentness', 'held', { reason: 'source_publisher_mismatch' }); return;
      }
      checkpoint(diagnostic, 'rules', 'started');
      const opened = await rules.read();
      if (opened.status !== 'available') { checkpoint(diagnostic, 'rules', 'held', { reason: opened.reason }); return; }
      if (!await current()) { checkpoint(diagnostic, 'rules', 'held', { reason: 'account_not_current' }); return; }
      checkpoint(diagnostic, 'source', 'started');
      const [accountEncryption, source] = await Promise.all([
        fetchAccountEncryptionCurrentness({ token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl, signal: input.signal }),
        fetchSessionById({ token: input.credentials.token, sessionId: occurrence.sourceSessionId,
          serverUrl: input.serverHttpBaseUrl, signal: input.signal }),
      ]);
      if (!source || source.archivedAt !== null && source.archivedAt !== undefined || !await current()) {
        checkpoint(diagnostic, 'source', 'held', { reason: !source ? 'source_unavailable'
          : source.archivedAt != null ? 'source_archived' : 'account_not_current' }); return;
      }
      checkpoint(diagnostic, 'facts', 'started');
      const facts = await readCliSessionListFilterFactsV1({ credentials: input.credentials, accountEncryption,
        row: source, serverId: input.serverId, nowMs: Date.now(),
        accountId: input.accountId, serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal, isCurrent: current,
        filters: opened.rules.filter(rule => rule.definition.enabled).map(rule => rule.definition.filter) });
      if (!facts) { checkpoint(diagnostic, 'facts', 'held', { reason: 'source_facts_unavailable' }); return; }
      // A request map is a currentness fence, never one aggregate semantic occurrence.
      const originals: (SessionFollowRuleSourceOccurrenceV1 | SessionFollowAccountOccurrence)[] = 'sourceMessage' in occurrence ? [occurrence]
        : occurrence.sourceRequests.requests.flatMap(request => {
          const evidence = occurrence.requestEvidence.find(item => item.requestId === request.requestId)?.evidence;
          return evidence?.event.kind === 'needs_you' ? [{ ...occurrence,
            sourceRequests: { ...occurrence.sourceRequests, requests: [request] }, requestEvidence: [{ requestId: request.requestId, evidence }] }] : [];
        });
      const personalRequestRules = new Map<string, { ruleId: string; ruleVersion: number; requestIds: Set<string> }>();
      let personalRequestPassComplete = 'sourceRequests' in occurrence && originals.length === occurrence.sourceRequests.requests.length;
      for (const original of originals) {
        const evidence = 'sourceMessage' in original ? original.evidence : original.requestEvidence[0]?.evidence;
        if (!evidence || !receiverSessionId && evidence.ownerAccountId !== input.accountId) {
          personalRequestPassComplete = false;
          continue;
        }
        checkpoint(diagnostic, 'routes', 'started');
        const ordinary = await readRoutes(original, receiverSessionId);
        if (ordinary === null) {
          checkpoint(diagnostic, 'routes', 'held', { reason: 'source_routes_unavailable' });
          if (receiverSessionId) return;
          personalRequestPassComplete = false;
          continue;
        } // Unsupported/denied is pending, not an empty route set.
        const evaluated = evaluateSessionFollowRuleOccurrenceV1({ accountId: input.accountId, evaluator: 'sourcePublisher' in original ? 'source' : 'receiver',
          production: 'sourcePublisher' in original ? 'source' : 'recovery', sourceSessionId: original.sourceSessionId, evidence, currentFacts: facts,
          rules: opened.rules.filter(rule => !rule.inception || ordinary.originalCreatedAt !== undefined
            && ordinary.originalCreatedAt >= rule.inception.createdAt),
          ...(opened.defaultPreferences && ordinary.currentAccountFacts ? { defaults: { preferences: opened.defaultPreferences,
            relationships: ordinary.currentAccountFacts.defaultRelationships,
            hasPersistentFollow: ordinary.currentAccountFacts.hasPersistentFollow } } : {}),
          ...(ordinary.currentAccountFacts ? { personalFollowSuppressed: ordinary.currentAccountFacts.personalFollowSuppressed } : {}),
        });
        if (evaluated.status !== 'evaluated') {
          checkpoint(diagnostic, 'selection', 'held', { reason: evaluated.status });
          if (receiverSessionId) return;
          personalRequestPassComplete = false;
          continue;
        }
        const candidates = new Map<string, { policies: FollowPolicyV1[]; witnesses: SessionFollowSourceOccurrenceWitnessV1[];
          relations: SessionFollowRelationWitnessV1[] }>();
        for (const route of ordinary.routes) {
          if (receiverSessionId && route.destinationSessionId !== receiverSessionId) continue;
          if (!resolveFollowDeliveryV1({ policies: [route.policy], event: evidence.event }).selected) continue;
          const candidate = candidates.get(route.destinationSessionId) ?? { policies: [], witnesses: [], relations: [] };
          candidate.policies.push(route.policy);
          candidate.relations.push(route.relation === 'manager'
            // The route response schema requires this attachment for managers.
            ? { relation: route.relation, attachedAt: route.attachedAt! }
            : { relation: route.relation, ...(route.attachedAt === undefined ? {} : { attachedAt: route.attachedAt }) });
          candidates.set(route.destinationSessionId, candidate);
        }
        for (const route of evaluated.routes) {
          if (receiverSessionId && (route.receiver.kind !== 'session' || route.receiver.sessionId !== receiverSessionId)) continue;
          const muted = route.receiver.kind === 'account'
            ? await readSessionDeliveryMutedScopes({ token: input.credentials.token, receiver: route.receiver,
              serverHttpBaseUrl: input.serverHttpBaseUrl, accountId: input.accountId, signal: input.signal })
            : await readSessionDeliveryMutedScopes({ token: input.credentials.token, receiver: route.receiver,
              serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal });
          if (!muted) {
            if (receiverSessionId) return;
            if (route.receiver.kind === 'account') personalRequestPassComplete = false;
            continue;
          }
          if (isFollowDeliveryMutedV1(muted, { senderSessionId: original.sourceSessionId,
            source: { kind: 'session', sessionId: original.sourceSessionId } })) continue;
          const contributions = route.rules.flatMap((rule, index) => isFollowDeliveryMutedV1(muted, { source: { kind: 'rule', ruleId: rule.ruleId } })
            ? [] : [{ rule, policy: route.policies[index]! }]);
          if (route.receiver.kind === 'account') {
            const policies = [...contributions.map(item => item.policy), ...route.defaultPolicies ?? []];
            if (!await input.isPersonalCurrent()) {
              personalRequestPassComplete = false;
              continue;
            }
            if (policies.length && await current()) {
              if (!('sourcePublisher' in occurrence)) continue;
              if ('sourceRequests' in original) for (const { rule } of contributions) {
                const witness = personalRequestRules.get(rule.ruleId) ?? { ruleId: rule.ruleId,
                  ruleVersion: rule.version, requestIds: new Set<string>() };
                for (const request of original.sourceRequests.requests) witness.requestIds.add(request.requestId);
                personalRequestRules.set(rule.ruleId, witness);
              }
              const acceptance = 'sourceMessage' in original ? await submitAccountFollowPersonalProgress({ token: input.credentials.token,
                serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal,
                occurrence: { sourceSessionId: original.sourceSessionId,
                  expectedSourcePublisherGeneration: occurrence.sourcePublisher.publisherGeneration,
                  machineId: input.machineId, installationId: input.installationId,
                  rules: contributions.map(({ rule }) => ({ ruleId: rule.ruleId, ruleVersion: rule.version })),
                  sourceMessage: original.sourceMessage,
                } }) : null;
              const nativeOwner = 'sourceRequests' in original || evidence.event.kind === 'finished';
              if (!nativeOwner && acceptance?.accepted !== true) continue;
              const result = !nativeOwner && acceptance?.alreadyRepresented ? undefined
                : await input.dispatchPersonal({ sourceSessionId: original.sourceSessionId,
                  occurrence: original, policies, signal: input.signal }, async () => {
                  if (!await current()) return false;
                  const latestRoutes = await readRoutes(original, receiverSessionId);
                  if (latestRoutes === null || latestRoutes.currentAccountFacts?.personalFollowSuppressed === true) return false;
                  const latest = await rules.read();
                  return latest.status === 'available' && contributions.every(({ rule }) => latest.rules.some(candidate =>
                    candidate.ruleId === rule.ruleId && candidate.version === rule.version && candidate.definition.enabled));
                });
              const contribution = result?.personalFollow ?? (acceptance?.accepted && 'sourceMessage' in original
                ? { sourceSessionId: original.sourceSessionId,
                    sourceMessage: { ...original.sourceMessage, policies } } : undefined);
              if (contribution) {
                if (contribution.sourceSessionId !== original.sourceSessionId) throw new Error('personal_follow_source_mismatch');
                personalFollow = { sourceSessionId: original.sourceSessionId,
                  ...(acceptance?.accepted ? { accepted: true } : {}),
                  ...(contribution.sourceMessage ? { sourceMessage: contribution.sourceMessage } : {}),
                  ...((personalFollow?.requests || contribution.requests) ? {
                    requests: [...personalFollow?.requests ?? [], ...contribution.requests ?? []],
                  } : {}) };
              }
            }
            continue;
          }
          const candidate = candidates.get(route.receiver.sessionId) ?? { policies: [], witnesses: [], relations: [] };
          for (const { rule, policy } of contributions) {
            const proof = 'sourcePublisher' in original ? {
                expectedSourcePublisherGeneration: original.sourcePublisher.publisherGeneration,
                machineId: input.machineId, installationId: input.installationId }
              : receiverSessionId ? { evaluation: 'receiver' as const } : null;
            if (!proof) continue;
            candidate.policies.push(policy);
            candidate.witnesses.push({ sourceSessionId: original.sourceSessionId, destinationSessionId: route.receiver.sessionId,
              ...proof,
              rule: { ruleId: rule.ruleId, ruleVersion: rule.version },
              ...('sourceMessage' in original ? { sourceMessage: original.sourceMessage } : { sourceRequests: original.sourceRequests }) });
          }
          candidates.set(route.receiver.sessionId, candidate);
        }
        checkpoint(diagnostic, 'selection', 'completed', { candidateCount: candidates.size });
        for (const [destinationSessionId, candidate] of candidates) {
          const selected = resolveFollowDeliveryV1({ policies: candidate.policies, event: evidence.event });
          if (!selected.selected || !await current()) continue;
          if ('sourceMessage' in original && !fromSourceRange) {
            // A source notification can arrive after an earlier admission failed.
            // Reuse catch-up's ordered traversal before admitting this receiver's
            // next original; its own seq - 1 baseline cannot prove that prefix.
            await dispatchReceiverRange({ destinationSessionId, sourceSessionId: original.sourceSessionId,
              observations: ordinary.routes.filter(route => route.destinationSessionId === destinationSessionId) },
              'sourcePublisher' in original ? original.sourcePublisher : undefined);
            continue;
          }
          const common = { v: 1 as const, delivery: selected.session.wake ? 'wake' as const : 'next_turn' as const };
          const delivery: SessionFollowInputV1 = 'sourceMessage' in original
            ? { ...common, original: { sourceSessionId: original.sourceSessionId, sourceMessage: original.sourceMessage }, event: evidence.event }
            : { ...common, original: { sourceSessionId: original.sourceSessionId, sourceRequests: original.sourceRequests },
              requestEvents: original.requestEvidence.flatMap(item => item.evidence?.event.kind === 'needs_you'
                ? [{ requestId: item.requestId, event: item.evidence.event }] : []) };
          const admission = buildTrustedHostSessionInputAdmissionV1('agent');
          const features = await input.resolveServerFeaturesSnapshot?.();
          checkpoint({ ...diagnostic, destinationSessionId }, 'admission', 'started');
          const result = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => await sendSessionMessage({
            credentials: input.credentials, idOrPrefix: destinationSessionId, wait: false,
            localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId, original: delivery.original }),
            timeoutMs: resolveSessionMessageAdmissionTimeoutMs(), message: 'Followed source changed. Read the original source context.',
            inputAdmission: { provenance: admission.provenance, request: SessionInputRequestV1Schema.parse({ ...admission.request, followDeliveryV1: delivery }) },
            ...(candidate.witnesses.length ? { followSources: candidate.witnesses } : {}),
            ...(candidate.relations.length ? { followRelations: candidate.relations } : {}),
            informationDelivery: 'session_follow', executionAuthority: 'account_automation',
            resumeInactiveSession: selected.session.wake,
            ...(input.spawnSession ? { spawnSession: input.spawnSession } : {}),
            ...(features ? { serverFeaturesSnapshot: features } : {}), signal: input.signal,
          }));
          logger.debug('[Session Follow] Original admission completed', {
            sourceSessionId: original.sourceSessionId, destinationSessionId,
            ...('sourceMessage' in original ? { sourceMessageSeq: original.sourceMessage.seq }
              : { agentStateVersion: original.sourceRequests.agentStateVersion }),
            ok: result.ok,
            ...(result.ok ? { localInputId: result.localId, suppressed: result.suppressed === true } : { code: result.code }),
          });
          if (!result.ok) {
            logger.debug('[Session Follow] Original admission held', { code: result.code });
            if (receiverSessionId) return;
          }
          else if (!result.suppressed && await current()) {
            const context = await input.resolveSourceKeyContext();
            if (context && await current()) await prepareSourceKey({ sourceSessionId: original.sourceSessionId,
              destinationSessionId, localInputId: result.localId, context, signal: input.signal });
          }
        }
      }
      // A request-state version covers the complete source pass. Settle only
      // after every current original has contributed its eligible rule witness;
      // settling the first singleton would consume a same-version sibling.
      if (personalFollow?.requests?.length && personalRequestPassComplete && 'sourceRequests' in occurrence
        && 'sourcePublisher' in occurrence && await current()) {
        const acceptance = await submitAccountFollowPersonalProgress({ token: input.credentials.token,
          serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal,
          occurrence: { sourceSessionId: occurrence.sourceSessionId,
            expectedSourcePublisherGeneration: occurrence.sourcePublisher.publisherGeneration,
            machineId: input.machineId, installationId: input.installationId,
            sourceRequests: occurrence.sourceRequests,
            rules: [...personalRequestRules.values()].map(rule => ({ ...rule, requestIds: [...rule.requestIds] })),
          } });
        if (acceptance?.accepted) personalFollow = { ...personalFollow, accepted: true };
      }
      return personalFollow ? { personalFollow } : {};
  };
  const dispatchReceiverRange = async (request: Readonly<{ destinationSessionId: string;
    observations: readonly SessionFollowSessionPendingObservationV1[]; sourceSessionId?: string }>,
    sourcePublisher?: SessionFollowRuleSourceOccurrenceV1['sourcePublisher']): Promise<SessionFollowReceiverRangeResult> => {
    const coveredEvents: { sourceSessionId: string; kind: FollowEventV1['kind'] }[] = [];
    const managerTurns: { observation: SessionFollowSessionPendingObservationV1; coveredKinds: ReadonlySet<FollowEventV1['kind']> }[] = [];
    const diagnostic = { entry: 'receiver_range' as const, destinationSessionId: request.destinationSessionId,
      ...(request.sourceSessionId ? { sourceSessionId: request.sourceSessionId } : {}) };
    checkpoint(diagnostic, 'currentness', 'started');
    if (!await current()) { checkpoint(diagnostic, 'currentness', 'held', { reason: 'account_not_current' }); return { coveredEvents }; }
    // Receiver recovery re-reads configured Run sources. A source publisher's
    // notification repairs its own Session prefix without scanning other work.
    // A Run's retained original is never inferred from a parent turn.
    if (!sourcePublisher && !request.sourceSessionId) {
      let cursor: string | undefined;
      do {
        const path = SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.list.replace(':destinationSessionId', encodeURIComponent(request.destinationSessionId));
        checkpoint(diagnostic, 'range_sources', 'started');
        const response = await axios.get(`${input.serverHttpBaseUrl}${path}`, { headers: { Authorization: `Bearer ${input.credentials.token}` },
          ...(cursor ? { params: { cursor } } : {}), signal: input.signal, validateStatus: () => true });
        const page = response.status === 200 ? ListSessionFollowSourcesResponseSchema.safeParse(response.data) : null;
        if (!page?.success || !await current()) {
          checkpoint(diagnostic, 'range_sources', 'held', { reason: !page?.success ? 'source_list_unavailable' : 'account_not_current',
            httpStatus: response.status }); break;
        }
        for (const relation of page.data.sources) if ('source' in relation
          && (relation.source.kind === 'execution_run' || relation.source.kind === 'workflow_run')
          && relation.deliveryState === 'eligible') await dispatchRun({ source: relation.source }, request.destinationSessionId);
        cursor = page.data.continuation;
      } while (cursor && await current());
    }
    // Run discovery above has its own source authority. An empty Session
    // observation needs no forced Account progress refresh without an enabled
    // receiver rule; configuration changes invalidate this same cache.
    if (request.observations.length === 0 && !await rules.hasEnabledSessionReceiver(request.destinationSessionId)) return { coveredEvents };
    // Progress changes independently of rule configuration. Refresh once at
    // this existing catch-up boundary, never for each original in the range.
    checkpoint(diagnostic, 'rules', 'started');
    const opened = await rules.read({ refresh: true });
    if (opened.status !== 'available') { checkpoint(diagnostic, 'rules', 'held', { reason: opened.reason }); return { coveredEvents }; }
    if (!await current()) { checkpoint(diagnostic, 'rules', 'held', { reason: 'account_not_current' }); return { coveredEvents }; }
    checkpoint(diagnostic, 'rules', 'completed');
    const ranges = new Map<string, { afterSeq: number; throughSeq: number | null; afterStateVersion: number }>();
    for (const observation of request.observations) {
      if (request.sourceSessionId && request.sourceSessionId !== observation.sourceSessionId) continue;
      const range = ranges.get(observation.sourceSessionId);
      ranges.set(observation.sourceSessionId, { afterSeq: Math.min(range?.afterSeq ?? observation.delivered.transcriptSeq,
        observation.delivered.transcriptSeq), throughSeq: Math.max(range?.throughSeq ?? 0, observation.observed.transcriptSeq),
        afterStateVersion: Math.min(range?.afterStateVersion ?? observation.delivered.agentStateVersion, observation.delivered.agentStateVersion) });
    }
    for (const rule of opened.rules) {
      if (!rule.definition.enabled || rule.receiver.kind !== 'session' || rule.receiver.sessionId !== request.destinationSessionId) continue;
      // Encountered progress remains canonical even if discovery is temporarily
      // unavailable. A first source range comes from the same Follow owner below.
      for (const source of rule.sources ?? []) {
        if (request.sourceSessionId && request.sourceSessionId !== source.sourceSessionId) continue;
        const range = ranges.get(source.sourceSessionId);
        ranges.set(source.sourceSessionId, { afterSeq: Math.min(range?.afterSeq ?? source.delivered.transcriptSeq,
          source.delivered.transcriptSeq), throughSeq: null,
          afterStateVersion: Math.min(range?.afterStateVersion ?? source.delivered.agentStateVersion, source.delivered.agentStateVersion) });
      }
    }
    if (opened.rules.some(rule => rule.definition.enabled && rule.receiver.kind === 'session'
      && rule.receiver.sessionId === request.destinationSessionId)) {
      checkpoint(diagnostic, 'source_ranges', 'started');
      const response = await axios.get<unknown>(`${input.serverHttpBaseUrl}${SESSION_FOLLOW_RULES_ROUTE_V1}`, {
        headers: { Authorization: `Bearer ${input.credentials.token}` }, signal: input.signal,
        params: { destinationSessionId: request.destinationSessionId,
          ...(request.sourceSessionId ? { sourceSessionId: request.sourceSessionId } : {}) }, validateStatus: () => true,
      });
      if (!await current()) {
        checkpoint(diagnostic, 'source_ranges', 'held', { reason: 'account_not_current' }); return { coveredEvents };
      }
      const parsed = response.status === 200 ? ListSessionFollowRulesResponseV1Schema.safeParse(response.data) : null;
      if (!parsed?.success) checkpoint(diagnostic, 'source_ranges', 'held', {
        reason: 'source_ranges_unavailable', httpStatus: response.status,
      });
      else checkpoint(diagnostic, 'source_ranges', 'completed');
      if (parsed?.success) for (const source of parsed.data.sourceRanges?.sources ?? []) {
        if (request.sourceSessionId && request.sourceSessionId !== source.sourceSessionId) continue;
        const range = ranges.get(source.sourceSessionId);
        ranges.set(source.sourceSessionId, { afterSeq: Math.min(range?.afterSeq ?? source.delivered.transcriptSeq,
          source.delivered.transcriptSeq), throughSeq: range?.throughSeq === null ? null
            : Math.max(range?.throughSeq ?? 0, source.throughSeq),
          afterStateVersion: Math.min(range?.afterStateVersion ?? source.delivered.agentStateVersion,
            source.delivered.agentStateVersion) });
      }
    }
    for (const [sourceSessionId, range] of ranges) {
      if (!await current()) continue;
      checkpoint(diagnostic, 'range_transport', 'started', { sourceSessionId, afterSeq: range.afterSeq });
      const transport = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => resolveSessionTransportContext({
        credentials: input.credentials, idOrPrefix: sourceSessionId, signal: input.signal }));
      if (!transport.ok || !await current()) {
        checkpoint(diagnostic, 'range_transport', 'held', { sourceSessionId,
          reason: !transport.ok ? transport.code : 'account_not_current' }); continue;
      }
      const ownerAccountId = transport.rawSession.ownerAccountId;
      if (typeof ownerAccountId !== 'string') continue;
      const source = transport.rawSession;
      const throughSeq = range.throughSeq ?? source.seq;
      if (typeof source.agentStateVersion === 'number' && source.agentStateVersion > range.afterStateVersion && source.agentStateVersion > 0 && typeof source.agentState === 'string') {
        const ctx = transport.ctx;
        const openedState = await openSessionStateValue(transport.mode === 'plain' ? { mode: 'plain' } : {
          mode: 'e2ee', encryption: ctx ? {
            encryptRaw: async payload => encryptSessionPayload({ ctx, payload }),
            decryptRaw: async ciphertextBase64 => decryptSessionPayload({ ctx, ciphertextBase64 }),
          } : null,
        }, source.agentState);
        const state = openedState.status === 'ready' ? AgentStateSchema.safeParse(openedState.value) : null;
        if (state?.success) for (const [requestId, foregroundRequest] of readActiveForegroundAgentRequests(state.data)) {
          if (typeof foregroundRequest.createdAt !== 'number' || !Number.isFinite(foregroundRequest.createdAt)) continue;
          const event = readForegroundAgentRequestFollowEvent(foregroundRequest);
          const evidence = event ? captureSemanticSessionFollowRuleSourceEvidence({ serverId: input.serverId,
            ownerAccountId, origin: source.origin ?? null, event }) : null;
          if (!evidence || !await current()) continue;
          await dispatch({ sourceSessionId, sourceRequests: { agentStateVersion: source.agentStateVersion,
            requests: [{ requestId, createdAt: foregroundRequest.createdAt, ...(foregroundRequest.turnId ? { turnId: foregroundRequest.turnId } : {}) }] },
            requestEvidence: [{ requestId, evidence }], ...(sourcePublisher ? { sourcePublisher } : {}) }, request.destinationSessionId, true);
          coveredEvents.push({ sourceSessionId, kind: evidence.event.kind });
        }
      }
      let afterSeq = range.afterSeq;
      let sourceRangeAvailable = true;
      while (afterSeq < throughSeq && await current()) {
        const pageStart = afterSeq;
        checkpoint(diagnostic, 'range_transcript', 'started', { sourceSessionId, afterSeq, throughSeq });
        // Frontiers count sidechain rows too; the occurrence reader excludes their events.
        const page = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => fetchEncryptedTranscriptMessagesPage({
          token: input.credentials.token, sessionId: sourceSessionId, afterSeq, scope: 'all',
          limit: SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1, signal: input.signal }));
        if (!await current()) break;
        let unavailable = false;
        for (const row of page.messages) {
          if (typeof row.seq === 'number' && row.seq > throughSeq) break;
          const read = readCommittedSessionFollowSourceOccurrence({ sourceSessionId, serverId: input.serverId,
            ownerAccountId, origin: transport.rawSession.origin ?? null,
            row, mode: transport.mode, ctx: transport.ctx });
          if (read.status === 'unavailable') {
            checkpoint(diagnostic, 'range_transcript', 'held', { sourceSessionId, reason: 'source_row_unavailable',
              ...(typeof row.seq === 'number' ? { sourceMessageSeq: row.seq } : {}) });
            unavailable = true; break;
          }
          if (read.status === 'occurrence' && 'sourceMessage' in read.occurrence) {
            const dispatched = await dispatch({ ...read.occurrence, ...(sourcePublisher ? { sourcePublisher } : {}) }, request.destinationSessionId, true);
            coveredEvents.push({ sourceSessionId, kind: read.occurrence.evidence.event.kind });
            // A later original's accepted ACK advances this same source cursor.
            // Leave the suffix for the next existing catch-up boundary when
            // this original's admission is unavailable or unconfirmed.
            if (!dispatched) { unavailable = true; break; }
          }
          if (typeof row.seq === 'number') afterSeq = row.seq;
        }
        if (unavailable) sourceRangeAvailable = false;
        if (unavailable || !page.hasMore || page.nextAfterSeq === null || page.nextAfterSeq <= pageStart) break;
        afterSeq = page.nextAfterSeq;
      }
      // A failed source read or unadmitted original cannot fall through to a
      // second wake. Only a completely traversed source can offer a disjoint
      // no-original manager Turn through the same dispatcher.
      if (sourceRangeAvailable && afterSeq >= throughSeq && await current()) {
        const coveredKinds = new Set(coveredEvents.filter(event => event.sourceSessionId === sourceSessionId).map(event => event.kind));
        for (const observation of request.observations) if (observation.sourceSessionId === sourceSessionId && observation.relation === 'manager') {
          managerTurns.push({ observation, coveredKinds });
        }
      }
    }
    // Offer every source original before attempting the receiver's one
    // context-only resume, as the former bootstrap caller did.
    for (const { observation, coveredKinds } of managerTurns) {
      if (await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => dispatchManagerTurn(observation, coveredKinds))) break;
    }
    checkpoint(diagnostic, 'range', 'completed');
    return { coveredEvents };
  };
  return {
    dispose: () => { if (!input.rulesCache) rules.dispose(); },
    dispatch: (occurrence: SessionFollowRuleSourceOccurrenceV1 | SessionFollowRunOccurrence) =>
      'original' in occurrence ? dispatchRun(occurrence) : dispatch(occurrence),
    dispatchReceiver: (request: Readonly<{ occurrence: SessionFollowAccountOccurrence; destinationSessionId: string }>) =>
      dispatch(request.occurrence, request.destinationSessionId),
    dispatchReceiverRange,
    dispatchAccountSourceRange,
    async readReceiverSessionIds(sourceSessionId?: string): Promise<readonly string[]> {
      if (!await current()) return [];
      const opened = await rules.read();
      if (opened.status !== 'available' || !await current()) return [];
      let candidates = opened.rules.filter(rule => rule.definition.enabled && rule.receiver.kind === 'session');
      if (sourceSessionId && candidates.length) {
        const homeId = await resolveServerProfileHomeIdentityId(input.serverId);
        const serverId = homeId ?? input.serverId;
        if (!await current()) return [];
        // Discovery already knows the source Home and kind. The canonical
        // matcher can decide some rules without reading a mutable Session row;
        // only unavailable predicates need fresh source/supplemental facts.
        const known = candidates.map(rule => ({ rule,
          // An identical local profile is the existing in-process target
          // contract. Otherwise an unresolved portable Home is not a miss.
          match: homeId !== null || rule.definition.filter.homeServerIds.includes(input.serverId)
            ? matchSessionListFilterV1(rule.definition.filter, {
              serverId, kind: 'session', workspaceContext: { normalizeServerId: id => id === input.serverId ? serverId : id },
            }) : 'unavailable' as const,
        }));
        candidates = known.filter(candidate => candidate.match !== 'miss').map(candidate => candidate.rule);
        const unresolved = known.filter(candidate => candidate.match === 'unavailable').map(candidate => candidate.rule);
        if (unresolved.length) {
          const [encryption, source] = await Promise.allSettled([
            fetchAccountEncryptionCurrentness({ token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl, signal: input.signal }),
            fetchSessionById({ token: input.credentials.token, sessionId: sourceSessionId,
              serverUrl: input.serverHttpBaseUrl, signal: input.signal }),
          ]);
          if (!await current()) return [];
          if (encryption.status === 'fulfilled' && source.status === 'fulfilled' && source.value) {
            const facts = await readCliSessionListFilterFactsV1({ credentials: input.credentials, accountEncryption: encryption.value,
              row: source.value, serverId: input.serverId, nowMs: Date.now(), accountId: input.accountId,
              serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal, isCurrent: current,
              filters: unresolved.map(rule => rule.definition.filter) });
            // A known miss suppresses discovery only. Unknown facts retain the
            // receiver, and actual dispatch still proves rules and source fresh.
            if (facts) candidates = candidates.filter(rule => matchSessionListFilterV1(rule.definition.filter, facts) !== 'miss');
          }
        }
      }
      return await current() ? [...new Set(candidates.flatMap(rule => rule.receiver.kind === 'session' ? [rule.receiver.sessionId] : []))] : [];
    },
  };
}
