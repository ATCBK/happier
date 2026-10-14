import * as React from 'react';

const DEFAULT_COPY_FEEDBACK_MS = 1_200;

/** One keyed feedback timer and copy settlement owner for app and public surfaces. */
export function useHappierCopyFeedback(durationMs: number = DEFAULT_COPY_FEEDBACK_MS) {
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = React.useRef(true);

  const clearCopiedFeedback = React.useCallback(() => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    if (mountedRef.current) setCopiedKey(null);
  }, []);

  const markCopied = React.useCallback((key: string = 'default') => {
    if (!mountedRef.current) return;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    setCopiedKey(key);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      if (mountedRef.current) setCopiedKey(null);
    }, durationMs);
  }, [durationMs]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearCopiedFeedback();
    };
  }, [clearCopiedFeedback]);

  // Public host clipboard writes return void; only explicit false or rejection is a failure.
  const copy = React.useCallback(async (action: () => unknown, key: string = 'default'): Promise<boolean> => {
    try {
      if (await action() === false) {
        console.warn('Clipboard write was refused by the platform.');
        clearCopiedFeedback();
        return false;
      }
      markCopied(key);
      return true;
    } catch {
      console.warn('Clipboard write failed.');
      clearCopiedFeedback();
      return false;
    }
  }, [clearCopiedFeedback, markCopied]);

  return React.useMemo(() => ({
    copiedKey,
    clearCopiedFeedback,
    markCopied,
    copy,
    isCopied: (key: string = 'default') => copiedKey === key,
  }), [clearCopiedFeedback, copiedKey, copy, markCopied]);
}
