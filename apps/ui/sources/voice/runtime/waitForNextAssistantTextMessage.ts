import { storage } from '@/sync/domains/state/storage';
import { readStoredSessionMessages, type Message } from "@happier-dev/session-core/messages";
import { readStreamSegmentMetaV1 } from '@happier-dev/session-core/reducer';
import { registerSessionRealtimeTranscriptConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';

export type AssistantTextMessageBaseline = Readonly<{
  baselineIds: Set<string>;
  baselineCount: number;
}>;

export type AssistantTextMessageEntry = Readonly<{
  entryId: string;
  text: string;
}>;

function getSessionMessages(sessionId: string): readonly Message[] {
  return readStoredSessionMessages(storage.getState(), sessionId);
}

export function captureAssistantTextMessageBaseline(sessionId: string): AssistantTextMessageBaseline {
  const messages = getSessionMessages(sessionId);
  return {
    baselineCount: messages.length,
    baselineIds: new Set<string>(
      messages
        .map((message) => message.id),
    ),
  };
}

export function collectAssistantTextMessagesSinceBaseline(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
): string[] {
  return collectAssistantTextMessageEntriesSinceBaseline(
    sessionId,
    baselineIds,
    baselineCount,
  ).map((entry) => entry.text);
}

export function collectAssistantTextMessageEntriesSinceBaseline(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
): AssistantTextMessageEntry[] {
  const messages = getSessionMessages(sessionId);
  const startIndex = messages.length >= baselineCount ? baselineCount : 0;
  const out: AssistantTextMessageEntry[] = [];
  for (let idx = startIndex; idx < messages.length; idx += 1) {
    const message = messages[idx];
    if (message?.kind !== 'agent-text') continue;
    if (message.isThinking === true) continue;
    const segment = readStreamSegmentMetaV1(message.meta);
    if (segment?.segmentKind === 'thinking'
      || segment?.segmentState === 'streaming'
      || segment?.segmentState === 'interrupted') continue;
    if (typeof message?.text !== 'string') continue;
    if (typeof message?.id === 'string' && baselineIds.has(message.id)) continue;
    const text = message.text.trim();
    const entryId = (
      typeof message?.realID === 'string' && message.realID.trim()
        ? message.realID
        : typeof message?.localId === 'string' && message.localId.trim()
          ? message.localId
          : typeof message?.id === 'string' && message.id.trim()
            ? message.id
            : ''
    ).trim();
    if (!text || !entryId) continue;
    out.push({ entryId, text });
  }
  return out;
}

export async function waitForNextAssistantTextMessageEntry(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
  signal?: AbortSignal,
  submittedUserLocalId?: string,
): Promise<AssistantTextMessageEntry | null> {
  if (signal?.aborted) return null;
  return await new Promise((resolve) => {
    let settled = false;
    let unsubscribe: null | (() => void) = null;
    const releaseTranscriptConsumer = registerSessionRealtimeTranscriptConsumer(sessionId);
    const abortListener = signal
      ? () => {
          done(null);
        }
      : null;

    const cleanup = () => {
      try {
        unsubscribe?.();
      } catch {
        // Best-effort cleanup; ignore unsubscribe errors.
      }
      unsubscribe = null;
      releaseTranscriptConsumer();
      if (signal && abortListener) {
        try {
          signal.removeEventListener('abort', abortListener);
        } catch {
          // ignore
        }
      }
    };

    const done = (entry: AssistantTextMessageEntry | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(entry);
    };

    const check = () => {
      try {
        const submittedMessages = submittedUserLocalId ? getSessionMessages(sessionId) : null;
        const submittedUserIndex = submittedMessages?.findIndex((message) =>
          message.kind === 'user-text' && message.localId === submittedUserLocalId) ?? -1;
        // Demand may hydrate older replies after the baseline was captured.
        // An admitted input supplies the canonical transcript boundary even
        // before its turn projection or server sequence has arrived.
        if (submittedUserLocalId && submittedUserIndex < 0) return;
        const matches = collectAssistantTextMessageEntriesSinceBaseline(
          sessionId,
          baselineIds,
          submittedUserLocalId ? submittedUserIndex + 1 : baselineCount,
        );
        if (matches.length > 0) {
          done(matches[0] ?? null);
          return;
        }
        // Admission returns the submitted row's localId. Only its committed
        // sequence can bind this wait to a turn; latest-turn status can belong
        // to an older or concurrent input from another client.
        if (!submittedUserLocalId) return;
        const userSeq = submittedMessages?.[submittedUserIndex]?.seq;
        if (typeof userSeq !== 'number') return;
        const turn = storage.getState().sessions[sessionId]?.sessionTurns?.turns.find((candidate) =>
          candidate.transcriptAnchors?.startUserMessageSeq === userSeq
          || candidate.transcriptAnchors?.userMessageSeqs?.includes(userSeq));
        const finalAssistantMessageSeq = turn?.transcriptAnchors?.finalAssistantMessageSeq;
        // Cancellation can finish without a final anchor. For other terminal
        // outcomes, only explicit null proves no reply; omission may precede
        // the final diagnostic/text projection.
        if (turn && turn.status !== 'in_progress'
          && (finalAssistantMessageSeq === null
            || (turn.status === 'cancelled' && finalAssistantMessageSeq === undefined))) {
          done(null);
        }
      } catch {
        done(null);
      }
    };

    // Reply latency belongs to the active Voice turn. Its cancellation signal
    // releases this demand on End, interrupt, retarget or disconnect. The exact
    // submitted turn's terminal projection also releases a no-reply wait.
    if (signal && abortListener) {
      try {
        signal.addEventListener('abort', abortListener, { once: true });
      } catch {
        // ignore
      }
    }
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
  signal?: AbortSignal,
  submittedUserLocalId?: string,
): Promise<string | null> {
  const entry = await waitForNextAssistantTextMessageEntry(
    sessionId,
    baselineIds,
    baselineCount,
    signal,
    submittedUserLocalId,
  );
  return entry?.text ?? null;
}
