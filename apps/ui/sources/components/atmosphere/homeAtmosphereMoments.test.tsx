import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import {
  DEFAULT_HOME_ATMOSPHERE,
  type HomeAtmosphere,
  type ProjectAtmosphere,
} from '@happier-dev/protocol/account/settings/accountSettings';

import { renderScreen } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { atmosphereResettleFact } from './atmosphereStage';
import { builtinPictureLocalId } from './ensureBuiltinPicture';
import { withShuffledPicture } from './look/atmosphereEdits';
import {
  useIdleResettle,
  buildSessionTurnStates,
  useSessionFinishedRipple,
  type SessionTurnState,
} from './homeAtmosphereMoments';
import { sessionRippleFrame } from './sessionRipple';

// React Native is the platform boundary; the moment policies and Look edits stay real.
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const HOUR_MS = 3_600_000;
const working: SessionTurnState = {
  lastTurnCompletedAt: null,
  pendingApproval: false,
};
const finished: SessionTurnState = {
  lastTurnCompletedAt: 1,
  pendingApproval: false,
};
const approval: SessionTurnState = {
  lastTurnCompletedAt: 1,
  pendingApproval: true,
};
const states = (entries: Readonly<Record<string, SessionTurnState>>) =>
  new Map(Object.entries(entries));

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('session-finished ripple (Home owner, fake clock)', () => {
  type Input = Parameters<typeof useSessionFinishedRipple>[0];
  async function mountRipple(initial: Input) {
    let ripples = 0;
    function Probe(props: Input) {
      ripples = useSessionFinishedRipple(props);
      return null;
    }
    const screen = await renderScreen(<Probe {...initial} />);
    return {
      ripples: () => ripples,
      async next(input: Input, advanceMs = 0) {
        await act(async () => {
          vi.advanceTimersByTime(advanceMs);
        });
        await screen.update(<Probe {...input} />);
      },
    };
  }

  it('answers new canonical completion facts, never queued, interrupted or cleared approvals', async () => {
    const session = createSessionFixture({ id: 'a', serverId: 'server-a', active: true, activeAt: Date.now(), lastTurnCompletedAt: 10 });
    const fromActivity = (changes: Partial<typeof session>) => {
      const next = { ...session, ...changes };
      const source: ActivityAttentionSource = {
        isDataReady: true,
        sessionsById: { a: next },
        sessionListRowsByServerId: { 'server-a': { a: buildSessionListRenderableFromSession(next) } },
        ordinarySessionListMembershipByServerId: { 'server-a': ['a'] },
        sessionListIndexByServerId: { 'server-a': [{ type: 'session', sessionId: 'a', serverId: 'server-a' }] },
        concurrentSessionListCacheByServerId: {},
        activeServerId: 'server-a',
      };
      return buildSessionTurnStates({ source, nowMs: Date.now() });
    };
    const home = await mountRipple({ enabled: true, visible: true, states: fromActivity({ latestTurnStatus: 'in_progress' }) });
    for (const changes of [
      { latestTurnStatus: null, thinking: false, pendingCount: 1 },
      { thinking: false, pendingCount: 0 },
      { agentState: { controlledByUser: null, requests: { request_1: { tool: 'Bash', kind: 'permission', arguments: {}, createdAt: Date.now() } } } },
      { agentState: null, pendingCount: 1 },
    ] satisfies Partial<typeof session>[]) {
      await home.next({ enabled: true, visible: true, states: fromActivity(changes) }, 10_000);
      expect(home.ripples()).toBe(0);
    }
    await home.next({ enabled: true, visible: true, states: fromActivity({ lastTurnCompletedAt: 20 }) }, 10_000);
    expect(home.ripples()).toBe(1);
    await home.next({ enabled: true, visible: true, states: fromActivity({ lastTurnCompletedAt: 30 }) }, 10_000);
    expect(home.ripples()).toBe(2);
  });

  it('answers a session that finishes while Home is visible', async () => {
    const home = await mountRipple({
      enabled: true,
      visible: true,
      states: states({ a: working }),
    });
    await home.next(
      { enabled: true, visible: true, states: states({ a: finished }) },
      1_000,
    );
    expect(home.ripples()).toBe(1);
  });

  it('consumes a finish that happened while Home was hidden and never replays it', async () => {
    const home = await mountRipple({
      enabled: true,
      visible: true,
      states: states({ a: working }),
    });
    await home.next(
      { enabled: true, visible: false, states: states({ a: finished }) },
      1_000,
    );
    await home.next(
      { enabled: true, visible: true, states: states({ a: finished }) },
      1_000,
    );
    expect(home.ripples()).toBe(0);
  });

  it('does not answer a turn that ends on a pending approval', async () => {
    const home = await mountRipple({
      enabled: true,
      visible: true,
      states: states({ a: working }),
    });
    await home.next(
      { enabled: true, visible: true, states: states({ a: approval }) },
      1_000,
    );
    expect(home.ripples()).toBe(0);
  });

  it('merges finishes inside 8 s into one answer and answers again after it', async () => {
    const home = await mountRipple({
      enabled: true,
      visible: true,
      states: states({ a: working, b: working, c: working }),
    });
    await home.next(
      {
        enabled: true,
        visible: true,
        states: states({ a: finished, b: working, c: working }),
      },
      1_000,
    );
    await home.next(
      {
        enabled: true,
        visible: true,
        states: states({ a: finished, b: finished, c: working }),
      },
      3_000,
    );
    expect(home.ripples()).toBe(1);
    await home.next(
      {
        enabled: true,
        visible: true,
        states: states({ a: finished, b: finished, c: finished }),
      },
      8_000,
    );
    expect(home.ripples()).toBe(2);
  });

  it('learns a session it first sees finished without answering it', async () => {
    const home = await mountRipple({
      enabled: true,
      visible: true,
      states: states({}),
    });
    await home.next(
      { enabled: true, visible: true, states: states({ a: finished }) },
      1_000,
    );
    expect(home.ripples()).toBe(0);
  });

  it('stays still while switched off, and switching it on does not replay what finished meanwhile', async () => {
    const home = await mountRipple({
      enabled: false,
      visible: true,
      states: states({ a: working }),
    });
    await home.next(
      { enabled: false, visible: true, states: states({ a: finished }) },
      1_000,
    );
    await home.next(
      { enabled: true, visible: true, states: states({ a: finished }) },
      1_000,
    );
    expect(home.ripples()).toBe(0);
  });
});

describe('session-finished ripple playback', () => {
  const geometry = {
    width: 1060,
    theme: 'light' as const,
    cx: 983.5,
    cy: 153,
    R: 306,
  };

  it('sends the ring from the planet and brightens it for the brand window', () => {
    const start = sessionRippleFrame(0, { ...geometry, reducedMotion: false });
    const mid = sessionRippleFrame(500, { ...geometry, reducedMotion: false });
    const end = sessionRippleFrame(1_600, {
      ...geometry,
      reducedMotion: false,
    });
    expect(mid.ring).toEqual({
      progress: expect.any(Number),
      x: geometry.cx,
      y: geometry.cy,
    });
    expect(mid.gain).toBeGreaterThan(1);
    expect(start.done || mid.done).toBe(false);
    expect(end).toEqual({ gain: 1, ring: null, done: true });
  });

  it('under reduced motion only brightens and settles in the shared 140 ms fade, with no ring', () => {
    const first = sessionRippleFrame(0, { ...geometry, reducedMotion: true });
    const half = sessionRippleFrame(70, { ...geometry, reducedMotion: true });
    expect(first.ring).toBeNull();
    expect(first.gain).toBeGreaterThan(half.gain);
    expect(half.gain).toBeGreaterThan(1);
    expect(
      sessionRippleFrame(140, { ...geometry, reducedMotion: true }),
    ).toEqual({ gain: 1, ring: null, done: true });
  });
});

describe('idle resettle (Home owner, fake clock)', () => {
  const pictures = ATMOSPHERE_PICTURES;
  const pictureHome: HomeAtmosphere = {
    ...DEFAULT_HOME_ATMOSPHERE,
    source: 'picture',
  };
  type Input = Parameters<typeof useIdleResettle>[0];

  function editorOf(value: ProjectAtmosphere) {
    const editor = {
      value,
      writes: 0,
      update(edit: (current: ProjectAtmosphere) => ProjectAtmosphere) {
        editor.writes += 1;
        editor.value = edit(editor.value);
      },
    };
    return editor;
  }

  async function mountResettle(overrides: Partial<Input> = {}) {
    const editor = editorOf(pictureHome);
    const ensured: string[] = [];
    const base: Input = {
      enabled: true,
      picture: 'white-rocks-open-sea',
      idle: true,
      visible: true,
      reducedMotion: false,
      editor,
      pictures,
      ensure: async (picture) => {
        ensured.push(picture.id);
      },
      ...overrides,
    };
    function Probe(props: Input) {
      useIdleResettle(props);
      return null;
    }
    const screen = await renderScreen(<Probe {...base} />);
    return {
      editor,
      ensured,
      async set(patch: Partial<Input>) {
        await screen.update(<Probe {...base} {...patch} />);
      },
      async advance(ms: number) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      },
    };
  }

  it('waits an hour from Home opening, then writes another built-in picture through the Look edits', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.42);
    const home = await mountResettle();
    await home.advance(HOUR_MS - 1);
    expect(home.editor.writes).toBe(0);
    await home.advance(1);
    const expected = withShuffledPicture(pictureHome, pictures, () => 0.42);
    expect(home.editor.value).toEqual(expected);
    expect(expected.picture.ref).not.toEqual(pictureHome.picture.ref);
    const id =
      expected.picture.ref.kind === 'builtin' ? expected.picture.ref.id : '';
    expect(home.ensured).toEqual([id]);
    expect(atmosphereResettleFact.get()).toMatchObject({
      localId: builtinPictureLocalId(id),
      reducedMotion: false,
    });
    vi.mocked(Math.random).mockRestore();
  });

  it('waits while Home is not idle and settles once it is idle again', async () => {
    const home = await mountResettle({ idle: false });
    await home.advance(2 * HOUR_MS);
    expect(home.editor.writes).toBe(0);
    await home.set({ idle: true });
    await home.advance(0);
    expect(home.editor.writes).toBe(1);
  });

  it('waits while Home is hidden', async () => {
    const home = await mountResettle({ visible: false });
    await home.advance(2 * HOUR_MS);
    expect(home.editor.writes).toBe(0);
  });

  it('only resettles a built-in picture', async () => {
    const home = await mountResettle({ picture: null });
    await home.advance(2 * HOUR_MS);
    expect(home.editor.writes).toBe(0);
  });

  it('stays still while switched off', async () => {
    const home = await mountResettle({ enabled: false });
    await home.advance(2 * HOUR_MS);
    expect(home.editor.writes).toBe(0);
  });

  it('keeps the picture when Home stops being idle while the next one downloads', async () => {
    let finishDownload = () => {};
    const home = await mountResettle({
      ensure: () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        }),
    });
    await home.advance(HOUR_MS);
    await home.set({ idle: false });
    await act(async () => {
      finishDownload();
    });
    expect(home.editor.writes).toBe(0);
  });

  it('resettles on successive hourly windows', async () => {
    const home = await mountResettle();
    await home.advance(HOUR_MS);
    expect(home.editor.writes).toBe(1);
    await home.set({ picture: home.editor.value.picture.ref.kind === 'builtin' ? home.editor.value.picture.ref.id : null });
    await home.advance(HOUR_MS);
    expect(home.editor.writes).toBe(2);
    expect(home.ensured).toHaveLength(2);
  });

  it('waits the next hour after a failed download, then tries again', async () => {
    let attempts = 0;
    const home = await mountResettle({ ensure: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
    } });
    await home.advance(HOUR_MS);
    expect(home.editor.writes).toBe(0);
    await home.advance(HOUR_MS - 1);
    expect(attempts).toBe(1);
    await home.advance(1);
    expect(attempts).toBe(2);
    expect(home.editor.writes).toBe(1);
  });

  it('waits the next hour when no alternative picture is available', async () => {
    const home = await mountResettle({ pictures: pictures.filter(picture => picture.id === 'white-rocks-open-sea') });
    await home.advance(HOUR_MS);
    expect(home.editor.writes).toBe(0);
    expect(home.ensured).toEqual([]);
    await home.set({ pictures });
    await home.advance(HOUR_MS);
    expect(home.editor.writes).toBe(1);
  });

  it('uses the current motion preference when an acquired picture lands', async () => {
    let finishDownload = () => {};
    const home = await mountResettle({ ensure: () => new Promise<void>(resolve => { finishDownload = resolve; }) });
    await home.advance(HOUR_MS);
    await home.set({ reducedMotion: true });
    await act(async () => { finishDownload(); });
    expect(atmosphereResettleFact.get()?.reducedMotion).toBe(true);
  });

  it('discards an acquired choice after a manual picture selection', async () => {
    let finishDownload = () => {};
    const home = await mountResettle({ ensure: () => new Promise<void>(resolve => { finishDownload = resolve; }) });
    await home.advance(HOUR_MS);
    const manual = pictures.at(-1)!;
    home.editor.value = { ...home.editor.value, picture: { ...home.editor.value.picture, ref: { kind: 'builtin', id: manual.id } } };
    await home.set({ picture: manual.id });
    await act(async () => { finishDownload(); });
    expect(home.editor.writes).toBe(0);
    expect(home.editor.value.picture.ref).toEqual({ kind: 'builtin', id: manual.id });
    expect(atmosphereResettleFact.get()).toBeNull();
  });
});
