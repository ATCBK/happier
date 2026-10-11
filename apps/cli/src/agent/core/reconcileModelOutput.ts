import type { AgentMessage } from './AgentBackend';

export type ModelOutputReconciliationState = {
  turnText: string;
  segmentText: string;
};

export type ModelOutputChange = Readonly<
  | { kind: 'none' }
  | { kind: 'append'; text: string }
  | { kind: 'replace'; scope: 'segment' | 'turn'; text: string }
>;

export function resetModelOutputSegment(state: ModelOutputReconciliationState): void {
  state.segmentText = '';
}

/**
 * Reconcile a provider output message into one turn buffer and return its text operation.
 * Segment-scoped fullText is authoritative only for the current assistant segment; turn-scoped
 * fullText replaces the complete turn when it diverges from the accumulated response.
 */
export function reconcileModelOutput(
  state: ModelOutputReconciliationState,
  msg: Extract<AgentMessage, { type: 'model-output' }>,
): ModelOutputChange {
  let delta = typeof msg.textDelta === 'string' ? msg.textDelta : '';
  const fullText = typeof msg.fullText === 'string' ? msg.fullText : '';

  if (!delta && fullText) {
    const fullTextScope = msg.fullTextScope ?? 'turn';
    const reconciledText = fullTextScope === 'segment' ? state.segmentText : state.turnText;
    if (fullText.startsWith(reconciledText)) {
      delta = fullText.slice(reconciledText.length);
    } else {
      const retainedPrefix = state.turnText.slice(0, state.turnText.length - state.segmentText.length);
      state.turnText = fullTextScope === 'segment' ? retainedPrefix + fullText : fullText;
      state.segmentText = fullTextScope === 'turn' && fullText.startsWith(retainedPrefix)
        ? fullText.slice(retainedPrefix.length)
        : fullText;
      return { kind: 'replace', scope: fullTextScope, text: fullText };
    }
  }

  if (delta) {
    state.turnText += delta;
    state.segmentText += delta;
  }
  return delta ? { kind: 'append', text: delta } : { kind: 'none' };
}
