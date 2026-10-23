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
import { createActivitySourceSessionAddressProjection } from '@/activity/source/activitySourceSessionAddresses';
import { readActivityAttentionStoreSource } from '@/activity/source/createActivityAttentionStoreSourceSelector';
import { useActivityPersonalSessionMembership, type ActivityPersonalSessionMembership } from '@/activity/source/activityPersonalSessionMembership';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { getActiveServerSnapshot, subscribeActiveServer, type ActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
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
  params: Readonly<{ source: ActivityAttentionSource; nowMs: number; addresses?: readonly SessionAddress[] }>,
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

export type SessionTurnStateChanges = Readonly<{
  /** Null removes a formerly admitted Session, so a later reappearance is learned afresh. */
  states: ReadonlyMap<string, SessionTurnState | null>;
  reset: boolean;
}>;

/**
 * Consume the store's changed-id publication, retaining only compact turn facts. Corpus/policy
 * changes rebuild through Activity's address owner; ordinary arrivals classify exact changed
 * addresses through that same attention owner, without Activity's full overview signatures.
 */
export function createSessionTurnStateSelector() {
  let previous: StorageState | null = null;
  let previousMembership: ActivityPersonalSessionMembership | null = null;
  let previousServer: ActiveServerSnapshot | null = null;
  let addressProjection: ReturnType<typeof createActivitySourceSessionAddressProjection> | null = null;
  const known = new Map<string, SessionTurnState>();
  return (state: StorageState, membership: ActivityPersonalSessionMembership, activeServer: ActiveServerSnapshot): SessionTurnStateChanges | null => {
    const samePolicy = previous !== null && previousMembership === membership && previousServer === activeServer
      && previous.profileScope === state.profileScope && previous.isDataReady === state.isDataReady
      && previous.projectAccountRows === state.projectAccountRows
      && previous.sessionOrganizationTagAssignmentsBySessionKey === state.sessionOrganizationTagAssignmentsBySessionKey;
    if (samePolicy && previous?.sessions === state.sessions && previous.sessionListRowsByServerId === state.sessionListRowsByServerId
      && previous.ordinarySessionListMembershipByServerId === state.ordinarySessionListMembershipByServerId) {
      previous = state;
      return null;
    }
    const source: ActivityAttentionSource = {
      ...readActivityAttentionStoreSource(state, false, true), activeServer, activeServerId: activeServer.serverId,
      personalSessionListMembershipByServerId: membership.membershipByServerId,
      personalSessionListQueryStatesByServerId: membership.statesByServerId,
      personalFollowRulesByServerId: membership.followRulesByServerId,
    };
    const delta = state.sessionListRenderableDelta;
    const incremental = samePolicy && previous !== null && addressProjection !== null
      && delta.revision === previous.sessionListRenderableDelta.revision + 1
      && (delta.ordinaryMembershipChanges !== undefined
        || previous.ordinarySessionListMembershipByServerId === state.ordinarySessionListMembershipByServerId);
    if (!incremental || !addressProjection) addressProjection = createActivitySourceSessionAddressProjection(source, true);
    const changedAddresses = incremental ? addressProjection.update(source, delta) : null;
    const addresses = changedAddresses?.addresses ?? addressProjection.all();
    const next = buildSessionTurnStates({ source, nowMs: Date.now(), addresses });
    const changes = new Map<string, SessionTurnState | null>();
    const reset = previous === null || previous.profileScope?.accountId !== state.profileScope?.accountId
      || previous.profileScope?.serverId !== state.profileScope?.serverId;
    if (reset) known.clear();
    const inspectedKeys = changedAddresses
      ? [...addresses, ...changedAddresses.removed].map(address => `${address.serverId}\u0000${address.sessionId}`) : known.keys();
    for (const key of inspectedKeys) {
      if (known.has(key) && !next.has(key)) { known.delete(key); changes.set(key, null); }
    }
    for (const [key, value] of next) {
      const before = known.get(key);
      if (!before || before.lastTurnCompletedAt !== value.lastTurnCompletedAt || before.pendingApproval !== value.pendingApproval) {
        known.set(key, value);
        changes.set(key, value);
      }
    }
    previous = state;
    previousMembership = membership;
    previousServer = activeServer;
    return changes.size > 0 || reset ? { states: changes, reset } : null;
  };
}

/**
 * Counts the ripples Home answers. Every observed session is compared with how it was last seen; a
 * session seen for the first time is learned, never answered, so nothing that finished while Home was
 * hidden, switched off or closed is replayed. Finishes inside the brand's window merge into one answer.
 */
type SessionFinishedRippleInput = Readonly<{
    enabled: boolean;
    visible: boolean;
    states: ReadonlyMap<string, SessionTurnState | null>;
    reset?: boolean;
}>;

export function createSessionFinishedRippleObserver(onAnswer: () => void) {
  let seen: Map<string, SessionTurnState> | null = null;
  let last: number | null = null;
  return ({ enabled, visible, states, reset }: SessionFinishedRippleInput): void => {
    if (!enabled) {
      seen = null;
      return;
    }
    const learning = seen === null || reset;
    const previous = seen ?? new Map<string, SessionTurnState>();
    if (reset) previous.clear();
    seen = previous;
    const nowMs = clock();
    let answer = false;
    for (const [key, state] of states) {
      const before = previous.get(key);
      if (state === null) { previous.delete(key); continue; }
      previous.set(key, state);
      if (!before || learning) continue;
      const completed = state.lastTurnCompletedAt !== null
        && (before.lastTurnCompletedAt === null || state.lastTurnCompletedAt > before.lastTurnCompletedAt);
      const decision = sessionFinishedRippleTrigger({
        nowMs,
        lastTriggeredAtMs: last,
        wasFinished: false,
        turnComplete: completed,
        pendingApproval: state.pendingApproval,
        homeVisible: visible,
      });
      last = decision.lastTriggeredAtMs;
      answer ||= decision.trigger;
    }
    if (answer) onAnswer();
  };
}

/** Admission consumes every store publication synchronously; React may batch its answer count. */
export function useSessionFinishedRipple(input: Readonly<{ enabled: boolean; visible: boolean }>): number {
  const membership = useActivityPersonalSessionMembership();
  const activeServer = React.useSyncExternalStore(subscribeActiveServer, getActiveServerSnapshot, getActiveServerSnapshot);
  const project = React.useMemo(createSessionTurnStateSelector, [input.enabled]);
  const [ripples, setRipples] = React.useState(0);
  const observe = React.useMemo(() => createSessionFinishedRippleObserver(() => setRipples(count => count + 1)), []);
  const latest = React.useRef(input);
  latest.current = input;
  React.useEffect(() => {
    if (!input.enabled) {
      observe({ enabled: false, visible: false, states: new Map() });
      return;
    }
    const update = (state: StorageState) => {
      const changes = project(state, membership, activeServer);
      if (changes) observe({ ...latest.current, ...changes });
    };
    const unsubscribe = storage.subscribe(update);
    update(storage.getState());
    return unsubscribe;
  }, [input.enabled, project, membership, activeServer, observe]);
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
