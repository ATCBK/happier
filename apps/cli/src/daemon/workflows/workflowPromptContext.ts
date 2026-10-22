import { renderDiscussionContextBlockV1, type DiscussionPromptAuthorV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { WorkflowValueReference } from '@happier-dev/protocol/workflows';
import { isWorkflowJsonObject, type WorkflowJsonValue } from './input';

export type WorkflowPromptContext = {
  author: DiscussionPromptAuthorV1;
  reference: WorkflowValueReference;
  token?: string;
  source?: WorkflowJsonValue;
  value: WorkflowJsonValue;
  incomplete?: true;
};

/** Source identities remain descriptive; reads still pass through their authorized Actions. */
export function projectWorkflowPromptContext(input: Readonly<{
  token?: string; reference: WorkflowValueReference; value: WorkflowJsonValue;
  resultSource?: Readonly<{ author: DiscussionPromptAuthorV1; source: WorkflowJsonValue;
    entries?: readonly Readonly<{ author: DiscussionPromptAuthorV1; source: WorkflowJsonValue; value: WorkflowJsonValue }>[] }>;
}>): WorkflowPromptContext[] {
  const { reference, value } = input;
  if (reference.kind === 'result' && reference.path.length === 0 && input.resultSource?.entries) {
    return input.resultSource.entries.flatMap(entry => projectWorkflowPromptContext({ reference, value: entry.value,
      resultSource: { author: entry.author, source: entry.source } }));
  }
  if (isWorkflowJsonObject(value) && Array.isArray(value.outcomeReferences)) {
    const { outcomeReferences, context, nextParticipants: _nextParticipants, ...summary } = value;
    return [
      ...projectWorkflowPromptContext({ ...input, value: summary }),
      ...(isWorkflowJsonObject(context) ? projectWorkflowPromptContext({ ...input, value: context }) : []),
      ...outcomeReferences.map(outcome => {
        const row = isWorkflowJsonObject(outcome) ? outcome : {};
        const participant = isWorkflowJsonObject(row.participant) ? row.participant : {};
        const session = isWorkflowJsonObject(participant.session) ? participant.session : {};
        const { participant: _participant, ...content } = row;
        return { reference, author: { kind: participant.kind === 'model' ? 'model' as const : 'agent_session' as const,
          ...(typeof session.sessionId === 'string' ? { sessionId: session.sessionId } : {}),
          ...(typeof row.executionSessionId === 'string' ? { sessionId: row.executionSessionId } : {}) },
          source: { runId: row.runId ?? null, invocation: { recordId: row.invocationRecordId ?? null }, readAction: 'workflow.run.invocations.get' },
          value: content };
      }),
    ];
  }
  if (isWorkflowJsonObject(value) && Array.isArray(value.messages) && isWorkflowJsonObject(value.discussion)) {
    return value.messages.map(message => {
      const row = isWorkflowJsonObject(message) ? message : {};
      const producer = isWorkflowJsonObject(row.producerV1) ? row.producerV1 : undefined;
      return { reference, ...(input.token ? { token: input.token } : {}),
        author: { kind: producer ? 'agent_session' : 'person',
          ...(typeof row.authorAccountId === 'string' ? { accountId: row.authorAccountId } : {}),
          ...(typeof producer?.sessionId === 'string' ? { sessionId: producer.sessionId } : {}) },
        source: { discussion: value.discussion!, messageId: row.id ?? null, throughSeq: value.throughSeq ?? null,
          readAction: 'discussion.read' }, value: message };
    });
  }
  return [{ reference, ...(input.token ? { token: input.token } : {}), value,
    author: input.resultSource?.author ?? (reference.kind === 'result'
      ? { kind: 'agent_session', displayName: `Workflow result: ${reference.producer.blockId}` }
      : { kind: 'person', displayName: 'Workflow input' }),
    ...(input.resultSource ? { source: input.resultSource.source } : {}) }];
}

export function renderWorkflowPromptContext(entries: readonly WorkflowPromptContext[]): string {
  return renderDiscussionContextBlockV1(entries.map(({ author, ...entry }) => ({ author, text: JSON.stringify(entry) })));
}

/** Reduce only the prompt projection. Exact values and source custody remain at their existing owners. */
export function compactWorkflowPromptContext(entries: WorkflowPromptContext[]): boolean {
  // Preserve the original question/request and the newest Discussion item. Older
  // messages become source references before any individual body is shortened.
  const discussionEntries = entries.filter(entry => isWorkflowJsonObject(entry.source) && entry.source.readAction === 'discussion.read');
  const older = discussionEntries.slice(0, -1).find(entry => !entry.incomplete);
  if (older) { older.value = null; older.incomplete = true; return true; }
  const candidates = entries.filter(entry => !(entry.reference.kind === 'input'
    && (entry.reference.name === 'question' || entry.reference.name === 'request')));
  const largest = candidates.map(entry => ({ entry, text: typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value) }))
    .filter(candidate => candidate.text.length > 1 && candidate.entry.value !== null)
    .sort((left, right) => right.text.length - left.text.length)[0];
  if (!largest) return false;
  // Repeated halving is logarithmic and uses the containing materialization
  // allowance; this introduces no second budget or per-source limit.
  largest.entry.value = largest.text.slice(-Math.floor(largest.text.length / 2));
  largest.entry.incomplete = true;
  return true;
}
