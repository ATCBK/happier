import type { ActionExecuteResult, ExecutionRunScmDiffSummaryInputV1, ScmComparison, ScmDiffSummaryOutputs, ScmDiffSummaryOutputState } from '@happier-dev/protocol';
import { ScmPullRequestOpenComposeResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { normalizeRawMessages } from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { extractStdStreams, normalizeToolCallForRendering } from '@happier-dev/session-core/tools';
import { resolve } from 'node:path';
import { captureScmComparison, readCapturedScmComparison, type CapturedScmComparison, type CaptureScmComparisonInput } from '@/scm/comparisons/captureScmComparison';
import { resolveCwd } from '@/scm/runtime';
import { resolveFilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { ReadRepositoryCheckpointTranscriptPage } from '@/scm/checkpoints/readRepositoryCheckpointTranscriptPage';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';

/** Uses the same admitted transcript and command projections as the Session, without prose test claims. */
async function readTestingContext(input: Readonly<{ sessionId?: string; readTranscriptPage?: ReadRepositoryCheckpointTranscriptPage;
  signal?: AbortSignal }>) {
  const rows: Awaited<ReturnType<ReadRepositoryCheckpointTranscriptPage>>['messages'][number][] = [];
  let state: 'complete' | 'incomplete' | 'unavailable' = input.sessionId && input.readTranscriptPage ? 'complete' : 'unavailable';
  if (input.sessionId && input.readTranscriptPage) {
    let afterSeq = 0;
    try {
      for (;;) {
        input.signal?.throwIfAborted();
        const page = await input.readTranscriptPage({ sessionId: input.sessionId, afterSeq });
        rows.push(...page.messages);
        if (!page.hasMore) break;
        if (page.nextAfterSeq === null || page.nextAfterSeq <= afterSeq) { state = 'incomplete'; break; }
        afterSeq = page.nextAfterSeq;
      }
    } catch {
      input.signal?.throwIfAborted();
      state = rows.length ? 'incomplete' : 'unavailable';
    }
  }
  const normalized = normalizeRawMessages(rows.map(row => ({ id: `transcript:${row.seq}`, localId: row.localId,
    seq: row.seq, createdAt: row.createdAt, raw: row.content })));
  const messages = reducer(createReducer(), normalized, null).messages;
  const toolMessages = messages.filter(message => message.kind === 'tool-call');
  for (const message of toolMessages) toolMessages.push(...message.children.filter(child => child.kind === 'tool-call'));
  const commands = toolMessages.flatMap(message => {
    const tool = normalizeToolCallForRendering(message.tool);
    if (tool.name !== 'Bash') return [];
    const rawInput: unknown = tool.input;
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return [];
    const fields = rawInput as Record<string, unknown>;
    const command = fields.command ?? fields.cmd;
    if (typeof command !== 'string' && !(Array.isArray(command) && command.every(part => typeof part === 'string'))) return [];
    const result = tool.state === 'completed' || tool.state === 'error' ? extractStdStreams(tool.result) : null;
    return [{ command, state: tool.state, ...(tool.permission ? { permission: tool.permission.status } : {}),
      ...(result ? { result } : {}) }];
  });
  return { state, ...(input.sessionId ? { sessionId: input.sessionId } : {}), commands };
}

/** PR drafting enriches the canonical summary's evidence; it never invokes a publishing operation. */
export async function loadScmPullRequestDraftEvidence(input: Readonly<{
  cwd: string; comparison: ScmComparison; sessionId?: string; providerId?: string;
  readTranscriptPage?: ReadRepositoryCheckpointTranscriptPage; signal?: AbortSignal;
  executeCanonicalAction: (actionId: 'scm.pullRequest.openCompose', input: unknown) => Promise<ActionExecuteResult>;
}>): Promise<string> {
  const base = input.comparison.pullRequest?.baseOid ?? input.comparison.endpoints.before;
  const head = input.comparison.endpoints.after;
  const unavailable = () => Object.assign(new Error('The captured pull request template is unavailable'), { code: 'DIFF_UNAVAILABLE' });
  if (!base || !head) throw unavailable();
  input.signal?.throwIfAborted();
  const prepared = await input.executeCanonicalAction('scm.pullRequest.openCompose', { cwd: input.cwd, base, head,
    ...(input.providerId ? { providerId: input.providerId } : {}), includeTemplate: true }).catch(() => {
      input.signal?.throwIfAborted();
      throw unavailable();
    });
  if (!prepared.ok) throw unavailable();
  const parsed = ScmPullRequestOpenComposeResponseSchema.safeParse(prepared.result);
  if (!parsed.success || !parsed.data.success || !parsed.data.template) throw unavailable();
  if (parsed.data.template.kind === 'needs_input') {
    throw Object.assign(new Error(parsed.data.template.error), { code: 'DIFF_UNAVAILABLE' });
  }
  const inventory = await scmDiffSummaryResultStore.list({ admitScope: scope => Promise.resolve(
    resolve(scope.cwd) === resolve(input.cwd) && scope.sessionId === input.sessionId
      && (!scope.sourceSessionId || scope.sourceSessionId === input.sessionId)) });
  let summary: (NonNullable<NonNullable<ScmDiffSummaryOutputs['summary']>['value']> & {
    resultId: string; revision: number; state: ScmDiffSummaryOutputState | 'unknown';
  }) | undefined;
  for (const item of inventory.results.filter(item => item.comparisonId === input.comparison.id)) {
    input.signal?.throwIfAborted();
    const saved = await scmDiffSummaryResultStore.read({ cwd: input.cwd, sessionId: input.sessionId, resultId: item.resultId });
    if (!saved.success) continue;
    const output = saved.result.output;
    const value = output.outputs?.summary?.value ?? (output.success && output.summaryMarkdown ? {
      summaryMarkdown: output.summaryMarkdown, ...(output.testImpact ? { testImpact: output.testImpact } : {}),
    } : undefined);
    if (!value) continue;
    summary = { ...value, resultId: item.resultId, revision: saved.result.revision, state: output.outputs?.summary?.state ?? 'unknown' };
    break;
  }
  const testing = await readTestingContext(input);
  input.signal?.throwIfAborted();
  return JSON.stringify({ comparisonId: input.comparison.id, template: parsed.data.template.body ?? null,
    ...(summary ? { summary } : {}), testing });
}

export async function loadScmDiffSummaryContext(params: Readonly<{
  input: ExecutionRunScmDiffSummaryInputV1;
  workingDirectory: string;
  sessionId?: string;
  captureCommitTarget?: CaptureScmComparisonInput['captureCommitTarget'];
}>): Promise<CapturedScmComparison> {
  const input = params.input;
  const authorized = resolveCwd(input.cwd, params.workingDirectory, resolveFilesystemAccessPolicy());
  if (!authorized.ok) {
    throw Object.assign(new Error('Comparison evidence is unavailable for this Run filesystem scope'), { code: 'DIFF_UNAVAILABLE' });
  }
  const sessionId = params.sessionId;
  const sourceSessionId = typeof input.source.sessionId === 'string' ? input.source.sessionId : undefined;
  if ((input.sessionId && input.sessionId !== sessionId) || (sourceSessionId && sourceSessionId !== sessionId)) {
    throw Object.assign(new Error('Comparison evidence is unavailable for this Run scope'), { code: 'DIFF_UNAVAILABLE' });
  }
  if (input.comparisonId) {
    return await readCapturedScmComparison({ cwd: authorized.cwd,
      comparisonId: input.comparisonId, sessionId, source: input.source, turnId: input.turnId,
      checkpointReceiptId: input.checkpointReceiptId, turnEvidenceMode: input.turnEvidenceMode });
  }
  return await captureScmComparison({ cwd: authorized.cwd, source: input.source,
    ...(params.captureCommitTarget ? { captureCommitTarget: params.captureCommitTarget } : {}),
    sessionId, turnId: input.turnId, checkpointReceiptId: input.checkpointReceiptId,
    turnEvidenceMode: input.turnEvidenceMode });
}
