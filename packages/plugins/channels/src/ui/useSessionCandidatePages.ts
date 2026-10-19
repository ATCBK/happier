import * as React from 'react';
import { useExecutePluginAction } from '@happier-dev/plugin-ui';

export type SessionCandidate = Readonly<{ id: string; label: string }>;
type SessionCandidatePage = Readonly<{
  candidates: readonly SessionCandidate[];
  nextCursor?: string;
}>;

function parseSessionCandidatePage(value: unknown): SessionCandidatePage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const page = value as Record<string, unknown>;
  if (page.view !== 'awareness' || page.projectionVersion !== 1) return undefined;
  if (!Array.isArray(page.sessions)) return undefined;
  const nonEmpty = (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0;
  if (page.nextCursor !== undefined && page.nextCursor !== null && !nonEmpty(page.nextCursor)) return undefined;
  const seen = new Set<string>();
  const candidates: SessionCandidate[] = [];
  for (const value of page.sessions) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (!nonEmpty(entry.sessionId) || seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    // Titles are sufficient for picking a Session; transcript previews stay private.
    candidates.push({ id: entry.sessionId, label: nonEmpty(entry.title) ? entry.title : 'Session' });
  }
  return {
    candidates,
    ...(nonEmpty(page.nextCursor) ? { nextCursor: page.nextCursor } : {}),
  };
}

/** One cursor owner for Channels' existing-Session pickers. */
export function useSessionCandidatePages(options: Readonly<{
  signal?: AbortSignal;
  isLocked?: () => boolean;
  onStarted?: () => void;
  onUnavailable?: () => void;
}> = {}) {
  const action = useExecutePluginAction('session.list');
  const execute = action.execute;
  const optionsRef = React.useRef(options);
  optionsRef.current = options;
  const mountedRef = React.useRef(true);
  const inFlightRef = React.useRef(false);
  const attemptedCursorRef = React.useRef<string | undefined>(undefined);
  const [candidates, setCandidates] = React.useState<readonly SessionCandidate[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | undefined>();
  const [loaded, setLoaded] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = React.useCallback(async (cursor?: string) => {
    const current = optionsRef.current;
    if (inFlightRef.current || current.signal?.aborted || current.isLocked?.()) return;
    inFlightRef.current = true;
    attemptedCursorRef.current = cursor;
    setUnavailable(false);
    current.onStarted?.();
    try {
      const settled = await execute({
        view: 'awareness',
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!mountedRef.current || current.signal?.aborted) return;
      const page = settled.status === 'success' ? parseSessionCandidatePage(settled.result) : undefined;
      if (page === undefined) {
        setUnavailable(true);
        optionsRef.current.onUnavailable?.();
        return;
      }
      setCandidates((previous) => {
        if (cursor === undefined) return page.candidates;
        const seen = new Set(previous.map((candidate) => candidate.id));
        const appended = page.candidates.filter((candidate) => {
          if (seen.has(candidate.id)) return false;
          seen.add(candidate.id);
          return true;
        });
        return appended.length === 0 ? previous : [...previous, ...appended];
      });
      setNextCursor(page.nextCursor);
    } catch {
      if (!mountedRef.current || current.signal?.aborted) return;
      setUnavailable(true);
      optionsRef.current.onUnavailable?.();
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && !current.signal?.aborted) setLoaded(true);
    }
  }, [execute]);

  const retry = React.useCallback(() => load(attemptedCursorRef.current), [load]);
  const reset = React.useCallback(() => {
    setCandidates([]);
    setNextCursor(undefined);
    setLoaded(false);
    setUnavailable(false);
    attemptedCursorRef.current = undefined;
  }, []);

  return {
    candidates,
    nextCursor,
    loaded,
    unavailable,
    loading: action.execution.status === 'pending',
    execution: action.execution,
    load,
    retry,
    reset,
  };
}
