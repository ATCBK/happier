import { describe, expect, it } from 'vitest';

import { shouldPlayBotMarkerFeedback } from './botMarkerFeedback';

describe('accepted Bot marker feedback', () => {
  const promoted = { serverId: 'home-a', sessionId: 's-1', bot: true };
  const demoted = { serverId: 'home-a', sessionId: 's-1', bot: false };

  it('acknowledges both directions on the header mark of exactly that Home-qualified Session', () => {
    expect(
      shouldPlayBotMarkerFeedback(
        'mark',
        { serverId: 'home-a', sessionId: 's-1' },
        promoted,
      ),
    ).toBe(true);
    expect(
      shouldPlayBotMarkerFeedback(
        'mark',
        { serverId: 'home-a', sessionId: 's-1' },
        demoted,
      ),
    ).toBe(true);
    expect(
      shouldPlayBotMarkerFeedback(
        'mark',
        { serverId: 'home-b', sessionId: 's-1' },
        promoted,
      ),
    ).toBe(false);
    expect(
      shouldPlayBotMarkerFeedback(
        'mark',
        { serverId: 'home-a', sessionId: 's-2' },
        promoted,
      ),
    ).toBe(false);
    expect(shouldPlayBotMarkerFeedback('mark', undefined, promoted)).toBe(
      false,
    );
  });

  it('nudges the rail Bots entry only when a Session became a Bot', () => {
    expect(shouldPlayBotMarkerFeedback('nudge', undefined, promoted)).toBe(
      true,
    );
    expect(shouldPlayBotMarkerFeedback('nudge', undefined, demoted)).toBe(
      false,
    );
  });
});
