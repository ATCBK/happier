import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

/**
 * `SessionView` is the one Session renderer (its own tests own the transcript and composer); the
 * probe records the composer's replies banner so this test observes only what the peek adds.
 */
const rendered = vi.hoisted(() => ({ banner: null as React.ReactNode }));
vi.mock('@/components/sessions/shell/SessionView', () => ({
  SessionView: (props: {
    presentation?: { repliesBanner?: React.ReactNode };
  }) => {
    rendered.banner = props.presentation?.repliesBanner ?? null;
    return React.createElement(
      'SessionView',
      null,
      props.presentation?.repliesBanner ?? null,
    );
  },
}));
// Session following is a Home feature bit (a server boundary): this Home offers it.
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
}));

describe('SessionPeekDetailsView', () => {
  let previousState = storage.getState();
  beforeEach(() => {
    previousState = storage.getState();
    storage.setState({
      sessions: {
        ...previousState.sessions,
        'worker-1': createSessionFixture({
          id: 'worker-1',
          serverId: 'home-one',
        } as never),
      },
    });
  });
  afterEach(() => {
    standardCleanup();
    storage.setState(previousState, true);
    rendered.banner = null;
  });

  it('offers this session’s notifications from the header bell, not as switches under its composer', async () => {
    const { SessionPeekDetailsView } = await import('./SessionPeekDetailsView');
    const screen = await renderScreen(
      <SessionPeekDetailsView
        sessionId="worker-1"
        serverId="home-one"
        active
      />,
    );

    const header = screen.findByTestId('session-peek-header');
    expect(header).not.toBeNull();
    // The bell opens the Session's one Follow editor (it holds "Notify me when…"), beside Open session.
    expect(screen.findByTestId('session-header-follow-chip')).not.toBeNull();
    expect(screen.findByTestId('session-peek-open')).not.toBeNull();
    // The composer keeps only its hint; no notification switch hangs beneath it.
    const banner = await renderScreen(<>{rendered.banner}</>);
    expect(banner.findByTestId('session-peek-replies-banner')).not.toBeNull();
    expect(banner.getTextContent()).not.toMatch(/notify/i);
    expect(screen.findByTestId('notify-turn:worker-1')).toBeNull();
    expect(screen.findByTestId('notify-attention:worker-1')).toBeNull();
  });
});
