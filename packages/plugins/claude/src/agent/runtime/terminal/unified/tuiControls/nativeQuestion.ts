import { summarizeAgentRequestQuestions } from '@happier-dev/plugin-sdk/sessions';
import { StructuredQuestionAnswersV1Schema, type StructuredQuestionAnswersV1 } from '@happier-dev/plugin-sdk/sessions';
import type { TerminalControlPort, TerminalSpecialKey } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildNativeAskUserQuestionAnswersForClaude, normalizeAskUserQuestionInputForPublication } from '../../../../permissions/askUserQuestion.js';
import { captureScreenState, encodeClaudeNativeTextInput, doesClaudeOwnedTextMatchCapture, hasUnsupportedClaudeNativeTextControls, sendResultToFailure } from './controlRuntime.js';
import { matchesClaudeNativeQuestionScreen, type ClaudeNativeQuestionPresentation } from './nativeQuestionScreen.js';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from './types.js';

export { matchesClaudeNativeQuestionScreen, parseClaudeNativeQuestionScreen, type ClaudeNativeQuestionPresentation } from './nativeQuestionScreen.js';

export type ClaudeNativeQuestionAnswerResult =
  | Readonly<{ status: 'answered' | 'not_visible' }>
  | Readonly<{ status: 'failed'; reason: string }>;

export async function answerClaudeNativeQuestion(params: Readonly<{
  port: TerminalControlPort;
  questions: readonly unknown[];
  answers: StructuredQuestionAnswersV1;
  isCurrent: () => boolean;
  wait: (ms: number) => Promise<void>;
  settleMs: number;
  verifyPollIntervalMs?: number | undefined;
  verifyPollTimeoutMs?: number | undefined;
  verifyApplied?: (() => 'pending' | 'matched' | 'mismatched') | undefined;
}>): Promise<ClaudeNativeQuestionAnswerResult> {
  const failed = (reason: string): ClaudeNativeQuestionAnswerResult => ({ status: 'failed', reason });
  // The host question-response owner validates choices before invoking this native driver.
  const parsed = StructuredQuestionAnswersV1Schema.safeParse(params.answers);
  if (!parsed.success) return failed('invalid_question_answers');
  const answers = parsed.data;
  const publication = normalizeAskUserQuestionInputForPublication('AskUserQuestion', { questions: params.questions });
  const questions = summarizeAgentRequestQuestions(publication !== null && typeof publication === 'object'
    && 'questions' in publication && Array.isArray(publication.questions) ? publication.questions : []);
  if (!questions.length || questions.length !== params.questions.length) return failed('invalid_questions');
  if (new Set(questions.map((question) => question.answerKey)).size !== questions.length
    || Object.keys(answers).some((key) => !questions.some((question) => question.answerKey === key))) return failed('invalid_question_answers');
  const providerAnswers = buildNativeAskUserQuestionAnswersForClaude(params.questions, answers);
  const desired = questions.map((question) => {
    const values = answers[question.answerKey] ?? [];
    const selected = question.choices.flatMap((option, index) => values.includes(option.value) ? [index] : []);
    const freeform = values.filter((value) => !question.choices.some((option) => option.value === value));
    return { selected, freeform, rendered: providerAnswers[question.question]! };
  });
  // Inline native text entry has one row. A placeholder-shaped value cannot be distinguished
  // from that empty row in a plain capture, and Enter on the empty row declines the whole tool.
  const unrepresentable = desired.some((answer) => answer.freeform.length > 1 || answer.freeform.some((text) => (
    !text.trim() || /^Type something\.?$/u.test(text) || hasUnsupportedClaudeNativeTextControls(text)
  )));
  if (unrepresentable) return failed('native_freeform_unrepresentable');

  let presentation: ClaudeNativeQuestionPresentation | null = null;
  let completionVisible = false;
  let captureReason: string | null = null;
  const capture = async (): Promise<boolean> => {
    if (!params.isCurrent()) { captureReason = 'request_retired'; return false; }
    const result = await captureScreenState(params.port);
    if (result.kind !== 'state') {
      captureReason = result.kind === 'host_dead' ? `host_dead:${result.recoverable ? 'recoverable' : 'unrecoverable'}` : result.reason;
      return false;
    }
    presentation = result.state.nativeQuestionPresentation;
    completionVisible = result.state.inputBoxInteractive || result.state.generating;
    if (presentation && !matchesClaudeNativeQuestionScreen(presentation, params.questions)) {
      captureReason = 'native_question_changed'; return false;
    }
    return true;
  };
  const send = async (key: TerminalSpecialKey | { text: string }): Promise<boolean> => {
    if (!params.isCurrent()) { captureReason = 'request_retired'; return false; }
    const result = typeof key === 'string'
      ? await params.port.sendSpecialKey(key)
      : /[\r\n\t]/u.test(key.text)
        ? await params.port.sendRawSequence(encodeClaudeNativeTextInput(key.text))
        : await params.port.sendLiteralText(key.text);
    const failure = sendResultToFailure(result);
    if (failure) { captureReason = ('reason' in failure ? failure.reason : undefined) ?? failure.kind; return false; }
    return true;
  };
  const refresh = async (): Promise<boolean> => {
    await params.wait(params.settleMs);
    if (!await capture()) return false;
    if (!presentation) { captureReason = 'native_question_disappeared_during_edit'; return false; }
    return true;
  };
  if (!await capture()) return failed(captureReason!);
  if (!presentation) return { status: 'not_visible' };
  const read = (): ClaudeNativeQuestionPresentation => presentation!;
  const ownDrafts = new Map<number, string>();
  // Native rendering makes logical newlines and visual wraps indistinguishable. Only an exact
  // payload written by this operation may use a display comparison across those boundaries.
  const draftMatches = (index: number, actual: string, expected: string): boolean => (
    ownDrafts.get(index) === expected
      ? doesClaudeOwnedTextMatchCapture(expected, actual)
      : !actual.includes('\n') && actual === expected
  );
  const reviewMatches = (screen: ClaudeNativeQuestionPresentation): boolean => (
    screen.kind === 'review' && screen.reviewAnswers.length === questions.length
    && screen.reviewAnswers.every((answer, index) => ownDrafts.has(index)
      ? doesClaudeOwnedTextMatchCapture(desired[index]!.rendered, answer.answer)
      : answer.answer === desired[index]!.rendered)
  );
  const questionIndex = () => questions.findIndex((question) => question.question?.trim() === read().question?.trim());
  const conflict = (index: number): boolean => {
    const screen = read();
    const target = desired[index]!;
    const question = questions[index]!;
    const draft = screen.options.at(-1)!;
    const draftText = /^Type something\.?$/u.test(draft.label) ? '' : draft.label;
    return screen.options.slice(0, question.choices.length).some((option, optionIndex) => option.checked === true && !target.selected.includes(optionIndex))
      || Boolean(draftText && !draftMatches(index, draftText, target.freeform[0] ?? ''));
  };
  const moveTo = async (target: number, index: number): Promise<boolean> => {
    // The bound is the exact visible row count, including native multi-select's Next row.
    const steps = read().options.length + Number(read().multiSelect);
    for (let step = 0; step <= steps; step += 1) {
      if (read().kind !== 'question' || questionIndex() !== index || conflict(index)) { captureReason = 'local_answer_conflict'; return false; }
      const current = read().nextFocused ? read().options.length : read().options.findIndex((option) => option.focused);
      if (current === target) return true;
      if (!await send(target > current ? 'ArrowDown' : 'ArrowUp') || !await refresh()) return false;
      const next = read().nextFocused ? read().options.length : read().options.findIndex((option) => option.focused);
      if (next === current) { captureReason = 'selection_did_not_move'; return false; }
    }
    captureReason = 'selection_target_unreachable'; return false;
  };
  // Native tabs retain independent drafts. Inspect from the first page even when the human
  // has browsed ahead or opened Submit, so every answer is matched against its real options.
  if (read().kind === 'review') {
    if (!await send('ShiftTab') || !await refresh()) return failed(captureReason!);
    if (read().kind !== 'question' || questionIndex() !== questions.length - 1) return failed('native_question_navigation_stalled');
  }
  for (let index = questionIndex(); index > 0; index -= 1) {
    if (!await send('ShiftTab') || !await refresh()) return failed(captureReason!);
    if (read().kind !== 'question' || questionIndex() !== index - 1) return failed('native_question_navigation_stalled');
  }
  const seenPages = new Set<number>();
  let submitted = false;
  while (!submitted) {
    const screen = read();
    if (screen.kind === 'review') {
      if (!reviewMatches(screen)) return failed('local_answer_conflict');
      if (!screen.options[0]!.focused) {
        if (!await send('ArrowUp') || !await refresh()) return failed(captureReason!);
        if (!read().options[0]!.focused || !reviewMatches(read())) return failed('native_review_changed');
      }
      if (!await send('Enter')) return failed(captureReason!);
      submitted = true;
      continue;
    }
    const index = questionIndex();
    if (index < 0 || seenPages.has(index)) return failed('native_question_navigation_stalled');
    seenPages.add(index);
    if (conflict(index)) return failed('local_answer_conflict');
    const question = questions[index]!;
    const target = desired[index]!;
    for (const optionIndex of target.selected) {
      if (read().options[optionIndex]!.checked === true) continue;
      if (!await moveTo(optionIndex, index) || !await send('Enter')) return failed(captureReason!);
      if (question.selection !== 'multiple' && questions.length === 1) { submitted = true; break; }
      if (!await refresh()) return failed(captureReason!);
      if (question.selection !== 'multiple') break;
      if (read().options[optionIndex]?.checked !== true) return failed('native_selection_not_applied');
    }
    if (submitted) continue;
    if (target.freeform.length > 0) {
      const freeformIndex = question.choices.length;
      if (!await moveTo(freeformIndex, index)) return failed(captureReason!);
      const freeformText = target.freeform[0]!;
      if (!draftMatches(index, read().options[freeformIndex]!.label, freeformText)) {
        if (!await send({ text: freeformText })) return failed(captureReason!);
        ownDrafts.set(index, freeformText);
        if (!await refresh()) return failed(captureReason!);
        if (questionIndex() !== index || conflict(index) || !draftMatches(index, read().options[freeformIndex]?.label ?? '', freeformText)) return failed('native_freeform_not_applied');
      }
      if (question.selection !== 'multiple' || read().options[freeformIndex]!.checked !== true) {
        if (!await send('Enter')) return failed(captureReason!);
        if (question.selection !== 'multiple' && questions.length === 1) { submitted = true; continue; }
        if (!await refresh()) return failed(captureReason!);
        if (question.selection === 'multiple' && read().options[freeformIndex]?.checked !== true) return failed('native_selection_not_applied');
      }
    }
    if (question.selection === 'multiple' || read().kind === 'question' && questionIndex() === index) {
      if (!await send('Tab') || !await refresh()) return failed(captureReason!);
      // In Claude's multiline editor Tab first leaves text entry for the same page's Next row.
      if (read().kind === 'question' && questionIndex() === index && read().nextFocused) {
        if (conflict(index)) return failed('local_answer_conflict');
        if (!await send('Enter') || !await refresh()) return failed(captureReason!);
      }
    }
  }
  const interval = Math.max(1, params.verifyPollIntervalMs ?? DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.verifyPollIntervalMs);
  const timeout = Math.max(interval, params.verifyPollTimeoutMs ?? DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.verifyPollTimeoutMs);
  for (let poll = 0; poll < Math.ceil(timeout / interval); poll += 1) {
    await params.wait(poll === 0 ? params.settleMs : interval);
    if (params.verifyApplied) {
      const applied = params.verifyApplied();
      if (applied === 'matched') return { status: 'answered' };
      if (applied === 'mismatched') return failed('native_answer_mismatch');
      continue;
    }
    // A hook may retire the exact occurrence immediately after native submission.
    if (!params.isCurrent()) return { status: 'answered' };
    if (!await capture()) return failed(captureReason!);
    if (!presentation && completionVisible) return { status: 'answered' };
    if (!presentation) continue;
    if (read().kind !== 'review' && questions.length > 1) return failed('native_question_changed_after_submit');
  }
  if (params.verifyApplied) return failed('native_answer_unverified');
  return failed(presentation ? 'native_question_still_visible' : 'native_question_completion_unverified');
}
