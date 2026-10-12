import * as React from 'react';
import type { AtmospherePicture } from '@happier-dev/brand/atmosphere';
import {
  MOMENT_TRIGGER_WINDOWS_MS,
  idleResettleTrigger,
  sessionFinishedRippleTrigger,
} from '@happier-dev/brand/planet-moments';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import {
  isActivityCandidateAwaitingPerson,
  forEachActivitySummaryCandidate,
} from '@/activity/source/buildActivityOverviewFromSource';
import { useActivityAttentionSummarySource } from '@/activity/source/useActivityAttentionSource';
import { atmosphereResettleFact } from './atmosphereStage';
import { builtinPictureLocalId } from './ensureBuiltinPicture';
import type { AtmosphereEditor } from './look/atmosphereEditor';
import { withShuffledPicture } from './look/atmosphereEdits';

/**
 * Home's two answering moments (plan UD-4): the session-finished ripple and the idle resettle. The brand
 * owns their frame maths and admission policies; Home keeps the policies' memory while it is mounted,
 * so nothing here persists, polls or runs at rest.
 */
const clock = () => performance.now();

export type SessionTurnState = Readonly<{
  lastTurnCompletedAt: number | null;
  pendingApproval: boolean;
}>;

/**
 * Each personal session's canonical completion watermark and the same "needs you" classification
 * Home's status line counts. A quiet, queued or interrupted runtime is not a completed turn.
 */
export function buildSessionTurnStates(
  params: Readonly<{ source: ActivityAttentionSource; nowMs: number }>,
): ReadonlyMap<string, SessionTurnState> {
  const states = new Map<string, SessionTurnState>();
  forEachActivitySummaryCandidate(
    { ...params, includeWarmSourceWhenNotReady: true },
    ({ entry, candidate }) => {
      states.set(`${entry.address.serverId}\u0000${entry.address.sessionId}`, {
        lastTurnCompletedAt: candidate.lastTurnCompletedAt,
        pendingApproval: isActivityCandidateAwaitingPerson(candidate),
      });
    },
  );
  return states;
}

/** The turn states for an open leaf only: closed, it subscribes to nothing it would not use. */
export function useSessionTurnStates(): ReadonlyMap<string, SessionTurnState> {
  const source = useActivityAttentionSummarySource();
  return React.useMemo(
    () => buildSessionTurnStates({ source, nowMs: Date.now() }),
    [source],
  );
}

/**
 * Counts the ripples Home answers. Every observed session is compared with how it was last seen; a
 * session seen for the first time is learned, never answered, so nothing that finished while Home was
 * hidden, switched off or closed is replayed. Finishes inside the brand's window merge into one answer.
 */
export function useSessionFinishedRipple(
  input: Readonly<{
    enabled: boolean;
    visible: boolean;
    states: ReadonlyMap<string, SessionTurnState>;
  }>,
): number {
  const seen = React.useRef<ReadonlyMap<string, SessionTurnState> | null>(null);
  const last = React.useRef<number | null>(null);
  const [ripples, setRipples] = React.useState(0);
  const { enabled, visible, states } = input;
  React.useEffect(() => {
    if (!enabled) {
      seen.current = null;
      return;
    }
    const previous = seen.current;
    seen.current = states;
    if (!previous) return;
    const nowMs = clock();
    let answer = false;
    for (const [key, state] of states) {
      const before = previous.get(key);
      if (!before) continue;
      const completed = state.lastTurnCompletedAt !== null
        && (before.lastTurnCompletedAt === null || state.lastTurnCompletedAt > before.lastTurnCompletedAt);
      const decision = sessionFinishedRippleTrigger({
        nowMs,
        lastTriggeredAtMs: last.current,
        wasFinished: false,
        turnComplete: completed,
        pendingApproval: state.pendingApproval,
        homeVisible: visible,
      });
      last.current = decision.lastTriggeredAtMs;
      answer ||= decision.trigger;
    }
    if (answer) setRipples((count) => count + 1);
  }, [enabled, states, visible]);
  return ripples;
}

/**
 * The idle resettle's admission at Home. While Home is idle (composer empty and unfocused, not
 * sending), visible and showing a built-in picture, one timer waits out the rest of the brand's
 * window, counted from Home opening so it never plays on launch. When it is admitted, the next picture
 * is chosen by the Look edits, downloaded, announced to the drawing owner as a resettle, and written
 * through Home's atmosphere editor, so the chip, the panel and other devices follow it.
 */
export function useIdleResettle(
  input: Readonly<{
    enabled: boolean;
    /** The built-in picture on Home, or null when Home does not show one. */
    picture: string | null;
    idle: boolean;
    visible: boolean;
    reducedMotion: boolean;
    editor: Pick<AtmosphereEditor, 'value' | 'update'>;
    pictures: readonly AtmospherePicture[];
    ensure: (picture: AtmospherePicture) => Promise<unknown>;
  }>,
): void {
  const [openedAt] = React.useState(clock);
  const last = React.useRef(openedAt);
  const latest = React.useRef(input);
  latest.current = input;
  const armed =
    input.enabled && input.picture !== null && input.idle && input.visible;
  React.useEffect(() => {
    if (!armed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(
        admit,
        Math.max(
          0,
          last.current + MOMENT_TRIGGER_WINDOWS_MS.resettle - clock(),
        ),
      );
    };
    const admit = () => {
      const decision = idleResettleTrigger({
        nowMs: clock(),
        lastTriggeredAtMs: last.current,
        homeIdle: true,
        homeVisible: true,
      });
      if (!decision.trigger || decision.lastTriggeredAtMs === null) {
        arm();
        return;
      }
      last.current = decision.lastTriggeredAtMs;
      arm();
      const { editor, pictures, ensure } = latest.current;
      const source = editor.value.picture.ref;
      if (source.kind !== 'builtin') return;
      const ref = withShuffledPicture(editor.value, pictures).picture.ref;
      const next =
        ref.kind === 'builtin'
          ? pictures.find((picture) => picture.id === ref.id)
          : undefined;
      if (!next || next.id === source.id) return;
      // A failed download keeps the picture on screen; the next window tries again.
      void ensure(next).then(
        () => {
          if (cancelled) return;
          const current = latest.current.editor.value;
          if (current.source !== 'picture' || current.picture.ref.kind !== 'builtin' || current.picture.ref.id !== source.id) return;
          atmosphereResettleFact.announce(
            builtinPictureLocalId(next.id),
            latest.current.reducedMotion,
          );
          latest.current.editor.update((value) =>
            value.source === 'picture' && value.picture.ref.kind === 'builtin' && value.picture.ref.id === source.id
              ? { ...value, picture: { ...value.picture, ref: { kind: 'builtin', id: next.id } } }
              : value,
          );
        },
        () => {},
      );
    };
    arm();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [armed, input.picture]);
  React.useEffect(() => () => atmosphereResettleFact.clear(), []);
}
