import {
  readSessionAwarenessWorkStatusV1,
  type SessionAwarenessPresentationFactsV1,
} from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';

export type BotActivity = 'needsYou' | 'working' | 'quiet';

/**
 * What a Bot is doing, as the roster header, the rail badge and the rail pins all say it: one
 * reading of the shared Session presentation, including reachability and content availability.
 */
export function classifyBotActivity(
  awareness: SessionAwarenessPresentationFactsV1 | null | undefined,
): BotActivity {
  if (!awareness) return 'quiet';
  const { bucket } = readSessionAwarenessWorkStatusV1({ awareness });
  if (bucket === 'needs_you') return 'needsYou';
  return bucket === 'working' ? 'working' : 'quiet';
}

/** The same reading from a loaded row (the rail holds rows, not row view models). */
export function readBotActivity(
  session: SessionListRenderableSession,
  nowMs: number,
): BotActivity {
  return classifyBotActivity(
    getSessionStatus(session, nowMs).awareness,
  );
}

const BOT_ACTIVITY_RANK: Readonly<Record<BotActivity, number>> = { needsYou: 0, working: 1, quiet: 2 };

/**
 * The roster's order (lab `b-rail A`): what needs the person first, then what is working, then the
 * rest, each most recently active first, so the header's counts are the first rows it lists. A
 * stable sort keeps the list's own order between Bots that tie.
 */
export function compareBotRosterOrder(
  left: Readonly<{ activity: BotActivity; activityAtMs: number }>,
  right: Readonly<{ activity: BotActivity; activityAtMs: number }>,
): number {
  return (
    BOT_ACTIVITY_RANK[left.activity] - BOT_ACTIVITY_RANK[right.activity] ||
    right.activityAtMs - left.activityAtMs
  );
}
