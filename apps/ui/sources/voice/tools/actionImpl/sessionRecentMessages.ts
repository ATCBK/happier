import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { listSessionAddressesForSessionIdFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { readSessionIncludedInVoiceFromState } from '@/voice/runtime/voiceUpdatePolicy';
import type { SessionTranscriptGetItem, SessionTranscriptGetResult } from '@happier-dev/protocol/actions';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readSessionTranscriptForAction } from '@/sync/api/session/sessionTranscriptActions';
import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';

import {
  clampInt,
  compareSessionKeyDesc,
  formatCursorKey,
  normalizeNonEmptyString,
  parseCursorKey,
  resolveVoiceUpdatesPrefs,
  shouldIncludeAfterCursor,
  toRoleAndText,
  type VoiceUpdatesPrefs,
} from './shared';

type VoiceRecentMessagesParams = Readonly<{
  sessionId: string;
  /**
   * Home bound by the invoking Action host, which is never the currently focused UI
   * Home. It is absent whenever the host could not bind one, so the projection falls
   * back to unambiguous local knowledge rather than to focus.
   */
  serverId?: string | null;
  limit?: number;
  cursor?: string | null;
  includeUser?: boolean;
  includeAssistant?: boolean;
  maxCharsPerMessage?: number | null;
}>;

type VoiceRecentMessage = Readonly<{
  id: unknown;
  role: 'assistant' | 'user' | 'tool';
  text: string;
  createdAt: unknown;
}>;

type VoiceRecentMessagesProjection =
  | Readonly<{
      ok: true;
      sessionId: string;
      messages: readonly VoiceRecentMessage[];
      nextCursor: string | null;
      rawRowsScanned: number;
    }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string }>;

function resolveVoiceTranscriptAdmission(params: Pick<VoiceRecentMessagesParams, 'sessionId' | 'serverId'>) {
  const state = storage.getState();
  const prefs = resolveVoiceUpdatesPrefs(state.settings);
  const refuse = (errorCode: string) => ({ ok: false as const, errorCode, errorMessage: errorCode });
  if (!prefs.shareRecentMessages) return refuse('recent_messages_disabled');

  const requestedSessionId = String(params.sessionId ?? '').trim();
  if (!requestedSessionId) return refuse('invalid_parameters');

  // The host binds the Home; an unqualified caller may only be resolved from
  // unambiguous local knowledge, never from whichever Home the UI happens to show.
  const boundServerId = normalizeNonEmptyString(params.serverId);
  const knownAddresses = listSessionAddressesForSessionIdFromLocalState(state, requestedSessionId);
  if (!boundServerId && knownAddresses.length > 1) return refuse('session_ambiguous');
  const resolvedServerId = boundServerId ?? knownAddresses[0]?.serverId ?? null;
  if (!resolvedServerId) return refuse('session_not_found');
  const requestedAddress = normalizeSessionAddress(resolvedServerId, requestedSessionId);
  if (!requestedAddress) return refuse('invalid_parameters');

  // Durable Account Follow is the disclosure authority. Attempt-local Voice context and
  // action-target state exist only for presentation/readback and cannot grant transcript access.
  const isActive = readSessionIncludedInVoiceFromState(state, requestedAddress);

  if (!isActive && prefs.otherSessionsSnippetsMode === 'never') {
    return refuse('other_sessions_snippets_disabled');
  }

  return { ok: true as const, state, prefs, address: requestedAddress };
}

async function readSessionRecentMessagesForVoiceProjection(
  params: VoiceRecentMessagesParams,
): Promise<VoiceRecentMessagesProjection> {
  const admission = resolveVoiceTranscriptAdmission(params);
  if (!admission.ok) return admission;
  const { state, prefs, address: requestedAddress } = admission;

  const defaultOnDemandLimit = clampInt(params.limit, { min: 1, max: 50, fallback: 20 });
  const limit = defaultOnDemandLimit;
  const cursor = params.cursor ?? null;
  const maxCharsPerMessage = params.maxCharsPerMessage ?? null;

  const includeAssistant = params.includeAssistant ?? true;
  const includeUser = params.includeUser ?? true;

  const messages = readStoredSessionMessagesForAddress(state, requestedAddress);
  const beforeCursor = parseCursorKey(cursor);

  const filtered = messages
    .filter((m) => m && typeof m === 'object')
    .map((message) => ({
      message,
      key: {
        updatedAt: Number((message as any).createdAt ?? 0),
        id: String((message as any).id ?? ''),
      },
    }))
    .filter(({ key }) => Number.isFinite(key.updatedAt) && key.id.length > 0)
    .filter(({ message }) => {
      if (message.kind === 'agent-text') return includeAssistant;
      if (message.kind === 'user-text') return includeUser;
      if (message.kind === 'tool-call') return includeAssistant;
      return false;
    })
    .filter(({ key }) => (beforeCursor == null ? true : shouldIncludeAfterCursor(key, beforeCursor)))
    .slice(0)
    .sort((left, right) => compareSessionKeyDesc(left.key, right.key));

  const page = filtered.slice(0, limit).slice(0).reverse();
  const outMessages = page.flatMap(({ message }) => {
    const row = toRoleAndText(message, { shareToolNames: prefs.shareToolNames, shareToolArgs: prefs.shareToolArgs, shareFilePaths: prefs.shareFilePaths });
    if (!row.text || !row.role) return [];
    const text = maxCharsPerMessage === null ? row.text : row.text.slice(0, Math.max(0, maxCharsPerMessage));
    return [{
      id: (message as any).id,
      role: row.role,
      text,
      createdAt: (message as any).createdAt,
    }];
  });

  const nextCursor = outMessages.length > 0
    ? formatCursorKey({
        updatedAt: Number(outMessages[0]?.createdAt ?? 0),
        id: String(outMessages[0]?.id ?? ''),
      })
    : null;
  return {
    ok: true,
    sessionId: requestedAddress.sessionId,
    messages: outMessages,
    nextCursor,
    rawRowsScanned: messages.length,
  };
}

export async function getSessionRecentMessagesForVoiceTool(
  params: VoiceRecentMessagesParams,
): Promise<
  | Readonly<{ ok: true; sessionId: string; messages: readonly any[]; nextCursor: string | null }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string }>
> {
  const result = await readSessionRecentMessagesForVoiceProjection(params);
  if (!result.ok) return result;
  return {
    ok: true,
    sessionId: result.sessionId,
    messages: result.messages,
    nextCursor: result.nextCursor,
  };
}

type VoiceTranscriptParams = Omit<Parameters<NonNullable<ActionExecutorDeps['sessionTranscriptGet']>>[0], 'context'>
  & Partial<Pick<Parameters<NonNullable<ActionExecutorDeps['sessionTranscriptGet']>>[0], 'context'>>;

/** Voice publishes its privacy projection only; raw source payloads never cross this boundary. */
function projectVoiceTranscriptItem(item: SessionTranscriptGetItem, prefs: VoiceUpdatesPrefs,
  maxChars: number | null | undefined): SessionTranscriptGetItem | null {
  if (item.semanticRole !== 'assistant' && item.semanticRole !== 'user' && item.semanticRole !== 'tool') return null;
  if (item.semanticRole === 'tool' && !prefs.shareToolNames) return null;
  const originalText = item.semanticRole === 'tool'
    ? prefs.shareToolArgs ? item.summary ?? item.text ?? `Tool: ${item.toolName ?? 'Unknown'}` : `Tool: ${item.toolName ?? 'Unknown'}`
    : item.text;
  if (!originalText) return null;
  const redacted = prefs.shareFilePaths ? originalText : redactVoicePathLikeString(originalText);
  const text = maxChars == null ? redacted : redacted.slice(0, Math.max(0, maxChars));
  return {
    id: item.id, ...(item.seq !== undefined ? { seq: item.seq } : {}), createdAt: item.createdAt,
    semanticRole: item.semanticRole, role: item.role, kind: item.kind, text,
    ...(item.semanticRole === 'tool' && item.toolName ? { toolName: item.toolName } : {}),
    // Redacted text remains readable by Voice but cannot claim to be an exact source quote.
    ...(item.truncated || text !== originalText ? { truncated: true } : {}),
  };
}

export async function getSessionTranscriptForVoiceTool(params: VoiceTranscriptParams,
  scope?: ServerAccountScope): Promise<SessionTranscriptGetResult> {
  if (params.projection === 'externalShareableV1') {
    return {
      ok: false,
      errorCode: 'external_shareable_projection_unavailable',
      errorMessage: 'external_shareable_projection_unavailable',
    };
  }

  const admission = resolveVoiceTranscriptAdmission(params);
  if (!admission.ok) return admission;
  if (!scope) return { ok: false, errorCode: 'admission_unavailable', errorMessage: 'admission_unavailable' };
  if (!areServerProfileIdentifiersEquivalent(scope.serverId, admission.address.serverId)) {
    return { ok: false, errorCode: 'session_not_found', errorMessage: 'session_not_found' };
  }
  const result = await readSessionTranscriptForAction({ ...params,
    context: params.context ?? { surface: 'voice' }, serverId: scope.serverId, sessionId: admission.address.sessionId,
    includeTools: params.includeTools === true && admission.prefs.shareToolNames,
    includeReasoning: false, includeEvents: false, includeRaw: false, includeStructuredPayload: false,
    maxCharsPerMessage: null,
  }, scope);
  if (!result.ok || !('items' in result)) return result;
  if ('projection' in result) return {
    ok: false, errorCode: 'external_shareable_projection_unavailable', errorMessage: 'external_shareable_projection_unavailable',
  };
  // A privacy change while the request was in flight must govern publication too.
  const current = resolveVoiceTranscriptAdmission(params);
  if (!current.ok) return current;
  return { ...result, items: result.items.flatMap(item => {
    const projected = projectVoiceTranscriptItem(item, current.prefs, params.maxCharsPerMessage);
    return projected ? [projected] : [];
  }) };
}
