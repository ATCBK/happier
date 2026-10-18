import { createContext, useContext, useId, useLayoutEffect } from 'react';

/**
 * The host's one sentence about a part of this mount that cannot run now (its Run-on Machine cannot be
 * reached), and how a failure state claims it. While the host has such a sentence, a plugin's failure
 * state (`ErrorState`, a failed `SurfaceState`) says the host's sentence in its own place instead of its
 * own copy, keeping its own action; the host says it itself only while no failure state does. Either
 * way the cause is said once and the rest of the body stays as the plugin drew it.
 */
export type PluginUiSurfaceNotice = Readonly<{
  sentence: string;
  /** Keep stable for the host's lifetime: a failure state claims once and releases on unmount. */
  claim(id: string): () => void;
}>;

export const PluginUiSurfaceNoticeContext = createContext<PluginUiSurfaceNotice | null>(null);

/** The host sentence a failure state says instead of its own copy, or `null` (no host sentence, or not a failure). */
export function useClaimedPluginUiSurfaceNotice(failure: boolean): string | null {
  const notice = useContext(PluginUiSurfaceNoticeContext);
  const id = useId();
  const claim = failure ? notice?.claim : undefined;
  useLayoutEffect(() => (claim ? claim(id) : undefined), [claim, id]);
  return failure && notice ? notice.sentence : null;
}
