import * as React from 'react';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/** An accepted Make this a bot / Make a regular session write (plan 60 motion: "accepted marker feedback"). */
export type BotMarkerAccepted = Readonly<{
  serverId: string;
  sessionId: string;
  bot: boolean;
}>;

type Listener = (event: BotMarkerAccepted) => void;

const listeners = new Set<Listener>();

/**
 * Said once by the marker's accepted-outcome owner (`sessionActionExecution`), never on a request or a
 * timer: the Session's header mark acknowledges it and the rail's Bots entry nudges toward where the
 * Bot now lives.
 */
export function announceBotMarkerAccepted(event: BotMarkerAccepted): void {
  for (const listener of [...listeners]) listener(event);
}

export function useBotMarkerAccepted(listener: Listener): void {
  const latest = React.useRef(listener);
  latest.current = listener;
  React.useEffect(() => {
    const forward: Listener = (event) => latest.current(event);
    listeners.add(forward);
    return () => {
      listeners.delete(forward);
    };
  }, []);
}

type FeedbackSession = Readonly<{
  serverId: string | null | undefined;
  sessionId: string;
}>;

/** Whether an accepted marker reaches this feedback: a mark answers its own Session, a nudge every promotion. */
export function shouldPlayBotMarkerFeedback(
  kind: 'mark' | 'nudge',
  session: FeedbackSession | undefined,
  event: BotMarkerAccepted,
): boolean {
  if (kind === 'nudge') return event.bot;
  if (!session || event.sessionId !== session.sessionId) return false;
  return !session.serverId || event.serverId === session.serverId;
}

/**
 * Plays a one-shot on the accepted marker: `kind="mark"` dips and returns the mark's opacity over
 * `durationMs.base` on `easing.standard` (the picture is not replaced); `kind="nudge"` lifts the entry
 * a little and settles it, once. Reduced motion: nothing moves.
 */
export function BotMarkerFeedback(
  props: Readonly<{
    kind: 'mark' | 'nudge';
    /** The Session a header mark belongs to; a nudge answers every promotion. */
    session?: FeedbackSession;
    children: React.ReactNode;
  }>,
) {
  const reducedMotion = useReducedMotionPreference();
  const progress = useSharedValue(0);
  const session = props.session;
  useBotMarkerAccepted((event) => {
    if (reducedMotion || !shouldPlayBotMarkerFeedback(props.kind, session, event)) return;
    const half = reanimatedMotionTokens.durationMs.base / 2;
    const easing = reanimatedMotionTokens.easing.standard;
    cancelAnimation(progress);
    progress.value = 0;
    progress.value = withSequence(
      withTiming(1, { duration: half, easing }),
      withTiming(0, { duration: half, easing }),
    );
  });
  const kind = props.kind;
  const style = useAnimatedStyle(() =>
    kind === 'mark'
      ? { opacity: 1 - 0.6 * progress.value }
      : { transform: [{ scale: 1 + 0.12 * progress.value }] },
  );
  return <Animated.View style={style}>{props.children}</Animated.View>;
}
