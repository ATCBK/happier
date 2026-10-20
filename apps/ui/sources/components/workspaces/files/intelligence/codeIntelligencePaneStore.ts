import * as React from 'react';
import type { LanguageIntelligenceDiagnostic } from '@happier-dev/protocol/machines/languageIntelligence';

import type { CodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';

import type { CodeReferenceRow } from './CodeReferencesList';

/**
 * What the active File page of a pane offers its References and Problems tabs: the page's one
 * controller (P7 §3.7) and the page-owned operations. The File page is the only producer; the tabs
 * read it and exist only while a producer is registered (P7 §8.3).
 */
export type CodeIntelligencePaneProducer = Readonly<{
  controller: CodeIntelligenceController;
  path: string;
  machineName: string;
  machineUnreachable: boolean;
  openReference: (row: CodeReferenceRow) => void;
  openProblem: (item: LanguageIntelligenceDiagnostic) => void;
  ask: Readonly<{ label: string; run: () => Promise<boolean> }> | null;
}>;

const producers = new Map<string, CodeIntelligencePaneProducer>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function publishCodeIntelligencePaneProducer(
  scopeId: string,
  producer: CodeIntelligencePaneProducer,
): () => void {
  producers.set(scopeId, producer);
  notify();
  return () => {
    if (producers.get(scopeId) !== producer) return;
    producers.delete(scopeId);
    notify();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCodeIntelligencePaneProducer(
  scopeId: string | null | undefined,
): CodeIntelligencePaneProducer | null {
  return React.useSyncExternalStore(
    subscribe,
    () => (scopeId ? (producers.get(scopeId) ?? null) : null),
    () => null,
  );
}
