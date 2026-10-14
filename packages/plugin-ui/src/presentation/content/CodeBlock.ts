import * as React from 'react';

import { useHappierCopyFeedback } from '../interaction/copyFeedback.js';

export type HappierCodeBlockBehaviorInput = Readonly<{
  language?: string | null;
  showHeaderRow: boolean;
  showCopyButton: boolean;
  hasHeaderLeft: boolean;
  hasHeaderRight: boolean;
  onCopy: () => unknown;
  copiedDurationMs?: number;
}>;

/** Normalize the optional syntax label shared by app and public code blocks. */
export function normalizeHappierCodeLanguage(language: string | null | undefined): string | undefined {
  const normalized = language?.trim().toLowerCase();
  return normalized ? normalized.slice(0, 64) : undefined;
}

export function resolveHappierCodeBlockLayout(input: Pick<
  HappierCodeBlockBehaviorInput,
  'language' | 'showHeaderRow' | 'showCopyButton' | 'hasHeaderLeft' | 'hasHeaderRight'
>) {
  const language = normalizeHappierCodeLanguage(input.language);
  const header = input.showHeaderRow && (Boolean(language) || input.hasHeaderLeft || input.hasHeaderRight);
  return {
    language,
    shouldRenderHeaderRow: header,
    shouldOverlayCopyButton: input.showCopyButton && !header,
  } as const;
}

/** One copy settlement/timer and header-placement owner for app and public code blocks. */
export function useHappierCodeBlockBehavior(input: HappierCodeBlockBehaviorInput) {
  const feedback = useHappierCopyFeedback(input.copiedDurationMs);
  const layout = resolveHappierCodeBlockLayout(input);
  const copyAction = feedback.copy;
  const copy = React.useCallback(() => copyAction(input.onCopy), [copyAction, input.onCopy]);

  return { ...layout, copied: feedback.isCopied(), copy } as const;
}
