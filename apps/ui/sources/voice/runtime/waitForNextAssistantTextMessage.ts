import { storage } from '@/sync/domains/state/storage';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import {
  deriveSessionRuntimePresentationState,
  isTerminalPrimaryTurnStatus,
} from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import type { Session } from '@/sync/domains/state/storageTypes';
import { settleReceivedSessionMessages } from '@/sync/engine/sessions/sessionMessageMaterializationBarrier';

/**
 * Turn-projection fields of the session at baseline time. Only a terminal status on a turn that is
 * different from the baseline one ends the wait, so a turn already running at baseline (or a
 * keep-alive refresh of `thinkingAt`) is never mistaken for the turn our message started.
 */
type SessionTurnMarker = Readonly<{
  latestTurnId: string | null;
  latestTurnStatus: string | null;
  latestTurnStatusObservedAt: number | null;
}>;

export type AssistantTextMessageBaseline = Readonly<{
  baselineIds: Set<string>;
  baselineCount: number;
}>;

export type SessionTurnBaseline = AssistantTextMessageBaseline & Readonly<{
  turnMarker: SessionTurnMarker | null;
}>;

function getSessionMessages(sessionId: string): any[] {
  return readStoredSessionMessages(storage.getState(), sessionId) as any[];
}

function getSession(sessionId: string): Session | null {
  const sessions = (storage.getState() as any)?.sessions;
  return (sessions?.[sessionId] ?? null) as Session | null;
}

function readSessionTurnMarker(session: Session | null): SessionTurnMarker | null {
  if (!session) return null;
  return {
    latestTurnId: session.latestTurnId ?? null,
    latestTurnStatus: session.latestTurnStatus ?? null,
    latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
  };
}

function isSessionTurnWorking(session: Session): boolean {
  return deriveSessionRuntimePresentationState({
    active: session.active,
    activeAt: session.activeAt,
    archivedAt: session.archivedAt,
    presence: session.presence,
    thinking: session.thinking,
    thinkingAt: session.thinkingAt,
    latestTurnStatus: session.latestTurnStatus,
    latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
  }, Date.now()).working;
}

export function captureAssistantTextMessageBaseline(sessionId: string): AssistantTextMessageBaseline {
  const messages = getSessionMessages(sessionId);
  return {
    baselineCount: messages.length,
    baselineIds: new Set<string>(
      messages
        .map((message: any) => message?.id)
        .filter((messageId: any): messageId is string => typeof messageId === 'string'),
    ),
  };
}

/** Baseline for waiting on the session turn started after this point (messages + turn lifecycle). */
export function captureSessionTurnBaseline(sessionId: string): SessionTurnBaseline {
  return {
    ...captureAssistantTextMessageBaseline(sessionId),
    turnMarker: readSessionTurnMarker(getSession(sessionId)),
  };
}

/** Assistant reply texts after the baseline; thinking output is stored as agent-text but is never a reply. */
export function collectAssistantTextMessagesSinceBaseline(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
): string[] {
  const messages = getSessionMessages(sessionId);
  const startIndex = messages.length >= baselineCount ? baselineCount : 0;
  const out: string[] = [];
  for (let idx = startIndex; idx < messages.length; idx += 1) {
    const message = messages[idx];
    if (message?.kind !== 'agent-text') continue;
    if (message?.isThinking === true) continue;
    if (typeof message?.text !== 'string') continue;
    if (typeof message?.id === 'string' && baselineIds.has(message.id)) continue;
    const text = message.text.trim();
    if (!text) continue;
    out.push(text);
  }
  return out;
}

type StorageConditionResult = Readonly<{ done: false }> | Readonly<{ done: true; value: string | null }>;

function waitForStorageCondition(
  evaluate: () => StorageConditionResult,
  opts: Readonly<{ timeoutMs?: number; signal?: AbortSignal }>,
): Promise<string | null> {
  const { signal } = opts;
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: null | (() => void) = null;
    const abortListener = () => done(null);

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      try {
        unsubscribe?.();
      } catch {
        // Best-effort cleanup; ignore unsubscribe errors.
      }
      unsubscribe = null;
      signal?.removeEventListener('abort', abortListener);
    };

    function done(value: string | null) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    const check = () => {
      try {
        const result = evaluate();
        if (result.done) done(result.value);
      } catch {
        done(null);
      }
    };

    if (typeof opts.timeoutMs === 'number') {
      timeout = setTimeout(() => done(null), opts.timeoutMs);
    }
    signal?.addEventListener('abort', abortListener, { once: true });
    try {
      unsubscribe = storage.subscribe(check);
    } catch {
      done(null);
      return;
    }
    check();
  });
}

export async function waitForNextAssistantTextMessage(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string | null> {
  return await waitForStorageCondition(() => {
    const matches = collectAssistantTextMessagesSinceBaseline(sessionId, baselineIds, baselineCount);
    return matches.length > 0 ? { done: true, value: matches[0] ?? null } : { done: false };
  }, { timeoutMs, signal });
}

/**
 * The reply to speak for a turn: every non-thinking assistant text after the last tool call or user
 * message, in order. Earlier texts are progress narration before tool work, or replies to an earlier
 * user message (the turn our message started begins after it), not the answer.
 */
export function collectFinalAssistantReplySinceBaseline(sessionId: string, baseline: AssistantTextMessageBaseline): string | null {
  const messages = getSessionMessages(sessionId);
  const startIndex = messages.length >= baseline.baselineCount ? baseline.baselineCount : 0;
  let trailing: string[] = [];
  for (let idx = startIndex; idx < messages.length; idx += 1) {
    const message = messages[idx];
    if (typeof message?.id === 'string' && baseline.baselineIds.has(message.id)) continue;
    if (message?.kind === 'tool-call' || message?.kind === 'user-text') {
      trailing = [];
      continue;
    }
    if (message?.kind !== 'agent-text' || message?.isThinking === true || typeof message?.text !== 'string') continue;
    const text = message.text.trim();
    if (text) trailing.push(text);
  }
  return trailing.length > 0 ? trailing.join('\n\n') : null;
}

function hasTurnProjection(marker: SessionTurnMarker | null): boolean {
  return marker !== null && (marker.latestTurnId !== null || marker.latestTurnStatus !== null);
}

/**
 * Resolves with the final assistant reply of the turn started after `baseline`.
 *
 * With the session turn projection, the turn has ended when a terminal `latestTurnStatus` is
 * reported for a turn other than the one current at baseline. Sessions from producers without the
 * projection fall back to the canonical runtime `working` signal (observed working, then idle).
 * Before reading the reply, messages this client already received are settled through the
 * materialization barrier, because the socket apply coalescer may still hold the final text when
 * the turn status (applied immediately) lands. The wait is bounded only by the turn lifecycle and
 * the caller's abort signal. Without a session record the latest reply is used as-is.
 */
export async function waitForTurnFinalAssistantText(params: Readonly<{
  sessionId: string;
  baseline: SessionTurnBaseline;
  signal?: AbortSignal;
}>): Promise<string | null> {
  const { sessionId, baseline, signal } = params;
  let sawWorking = false;
  const ended = await waitForStorageCondition(() => {
    const session = getSession(sessionId);
    if (!session) {
      return collectFinalAssistantReplySinceBaseline(sessionId, baseline) ? { done: true, value: 'ended' } : { done: false };
    }
    const current = readSessionTurnMarker(session);
    if (hasTurnProjection(current) || hasTurnProjection(baseline.turnMarker)) {
      const isNewTurn = current?.latestTurnId !== null || baseline.turnMarker?.latestTurnId != null
        ? current?.latestTurnId !== (baseline.turnMarker?.latestTurnId ?? null)
        : current?.latestTurnStatusObservedAt !== (baseline.turnMarker?.latestTurnStatusObservedAt ?? null);
      const isTerminal = isTerminalPrimaryTurnStatus(session.latestTurnStatus ?? null);
      return isNewTurn && isTerminal ? { done: true, value: 'ended' } : { done: false };
    }
    if (isSessionTurnWorking(session)) {
      sawWorking = true;
      return { done: false };
    }
    return sawWorking ? { done: true, value: 'ended' } : { done: false };
  }, { signal });
  if (ended === null || signal?.aborted) return null;

  await settleReceivedSessionMessages(sessionId);
  if (signal?.aborted) return null;
  return collectFinalAssistantReplySinceBaseline(sessionId, baseline);
}
