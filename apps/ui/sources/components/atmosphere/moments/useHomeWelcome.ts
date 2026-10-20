import * as React from 'react';
import { useLocalSetting } from '@/sync/store/hooks';
import { getStorage } from '@/sync/domains/state/storageStore';

export type HomeWelcome = Readonly<{
  /** The assembly is on screen: Home's planet waits under it. */
  playing: boolean;
  /** Home's planet takes over from the landed assembly in the same frame. */
  arrive: 'fade' | 'instant';
  onLanded: () => void;
  /** After Welcome, this visit may re-type digits. The planet leaf owns the rest clock. */
  retype: boolean;
}>;

/**
 * Plays Welcome once per device: on the first arrival at Home with its planet after sign-in. A Loading
 * cloud already assembled the planet in that arrival counts as the Welcome. Under reduced motion the
 * rest is shown at once and nothing re-types.
 */
export function useHomeWelcome(
  input: Readonly<{
    /** Home shows its planet, is in front, and the planet's place is known. */
    eligible: boolean;
    loadingShown: boolean;
    reducedMotion: boolean;
    /** Re-typing pauses while the person writes. */
    writing: boolean;
  }>,
): HomeWelcome {
  const seenAt = useLocalSetting('homeWelcomeSeenAt');
  const [status, setStatus] = React.useState<
    'idle' | 'playing' | 'resting' | 'done'
  >('idle');
  const play = status === 'idle' && input.eligible && seenAt === null;
  React.useEffect(() => {
    if (!play) return;
    getStorage().getState().applyLocalSettings({ homeWelcomeSeenAt: Date.now() }, { source: 'ui' });
    setStatus(input.loadingShown || input.reducedMotion ? 'done' : 'playing');
  }, [input.loadingShown, input.reducedMotion, play]);
  const [instant, setInstant] = React.useState(false);
  React.useEffect(() => {
    if (instant) setInstant(false);
  }, [instant]);
  const onLanded = React.useCallback(() => {
    setStatus((current) => (current === 'playing' ? 'resting' : current));
    setInstant(true);
  }, []);
  React.useEffect(() => {
    if (status !== 'playing' || !input.reducedMotion) return;
    setStatus('done');
    setInstant(true);
  }, [input.reducedMotion, status]);
  // The resting re-type belongs to this visit: it ends when Home is left.
  const resting = status === 'resting';
  React.useEffect(() => {
    if (resting && !input.eligible) setStatus('done');
  }, [input.eligible, resting]);
  return {
    playing: status === 'playing' || play,
    arrive: instant ? 'instant' : 'fade',
    onLanded,
    retype: resting && input.eligible,
  };
}
