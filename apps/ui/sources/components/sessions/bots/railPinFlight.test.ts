import { describe, expect, it } from 'vitest';

import {
  forgetRailPinOrigin,
  noteRailPinOrigin,
  peekRailPinOrigin,
  resolveRailPinFlightStart,
} from './railPinFlight';

describe('rail pin flight origin', () => {
  it('keeps the picture position per Home-qualified Session until the slot or a refusal forgets it', () => {
    const pinned = { serverId: 'home-a', sessionId: 'bot-1' };
    noteRailPinOrigin(pinned, { x: 400, y: 120, w: 30, h: 30 });
    // Same Session id on another Home is a different Bot.
    expect(
      peekRailPinOrigin({ serverId: 'home-b', sessionId: 'bot-1' }),
    ).toBeNull();
    // Reading does not consume it (render may run twice); forgetting does.
    expect(peekRailPinOrigin(pinned)).toEqual({ x: 400, y: 120, w: 30, h: 30 });
    expect(peekRailPinOrigin(pinned)).not.toBeNull();
    forgetRailPinOrigin(pinned);
    expect(peekRailPinOrigin(pinned)).toBeNull();
    // An unmeasurable row records nothing, so a later pin never flies from a stale place.
    noteRailPinOrigin(pinned, { x: 1, y: 1, w: 30, h: 30 });
    noteRailPinOrigin(pinned, null);
    expect(peekRailPinOrigin(pinned)).toBeNull();
  });

  it('starts the slot centred on the picture it left, at that picture size', () => {
    expect(
      resolveRailPinFlightStart(
        { x: 400, y: 120, w: 30, h: 30 },
        { x: 16, y: 200, w: 24, h: 24 },
      ),
    ).toEqual({
      translateX: 415 - 28,
      translateY: 135 - 212,
      scale: 30 / 24,
    });
    expect(
      resolveRailPinFlightStart(null, { x: 0, y: 0, w: 24, h: 24 }),
    ).toBeNull();
    expect(
      resolveRailPinFlightStart(
        { x: 0, y: 0, w: 30, h: 30 },
        { x: 0, y: 0, w: 0, h: 0 },
      ),
    ).toBeNull();
  });
});
