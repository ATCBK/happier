import { describe, expect, it } from 'vitest';

import { createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';

import { readBotActivity } from './botActivity';

describe('Bot activity from real Session awareness', () => {
  const now = 1_800_000_000_000;

  it.each([
    { name: 'offline blocked input', facts: { presence: 0, pendingBlockedCount: 1 }, primary: 'action_required', state: 'action_required', activity: 'needsYou' },
    { name: 'offline failure', facts: { presence: 0, latestTurnStatus: 'failed' }, primary: 'failed', state: 'disconnected', activity: 'quiet' },
    { name: 'online blocked input', facts: { presence: 'online', pendingBlockedCount: 1 }, primary: 'action_required', state: 'action_required', activity: 'needsYou' },
    { name: 'online working turn', facts: { presence: 'online', latestTurnStatus: 'in_progress', thinking: true, thinkingAt: now }, primary: 'working', state: 'thinking', activity: 'working' },
    { name: 'offline working turn', facts: { presence: 0, active: false, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now }, primary: 'working', state: 'disconnected', activity: 'quiet' },
    { name: 'unknown presence with a working turn', facts: { presence: undefined, latestTurnStatus: 'in_progress', thinking: true, thinkingAt: now }, primary: 'working', state: 'thinking', activity: 'working' },
    { name: 'online failure', facts: { presence: 'online', latestTurnStatus: 'failed' }, primary: 'failed', state: 'unknown', activity: 'quiet' },
    { name: 'unreadable working turn', facts: { presence: 'online', latestTurnStatus: 'in_progress', encryptedContentAvailability: 'encrypted_content_unavailable' }, primary: 'working', state: 'content_unavailable', activity: 'quiet' },
  ] as const)('agrees with the shared Session presentation for $name', ({ facts, primary, state, activity }) => {
    const session = createSessionListRenderableSessionFixture({
      active: true, activeAt: now, updatedAt: now, ...facts,
    });
    const status = getSessionStatus(session, now);
    // Keep the operational evidence: losing it in a fixture would hide this regression.
    expect(status.awareness.operational.primary).toBe(primary);
    expect(status.state).toBe(state);
    expect(readBotActivity(session, now)).toBe(activity);
  });
});
