import type { TerminalControlPort } from '@happier-dev/plugin-sdk/agents/runtime';

import type { ClaudeScreenState } from '../screenState.js';
import { captureScreenState, sendResultToFailure } from './controlRuntime.js';
import {
  getClaudeUnifiedDialogIdentity,
  resolveClaudeUnifiedVisibleDialog,
  type ClaudeUnifiedDialogId,
  type ClaudeUnifiedDialogOption,
} from './dialogRegistry.js';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from './types.js';

/** The one presentation-aware answerer for every Claude Unified selection dialog. */
export type ClaudeUnifiedDialogAnswerResult =
  | Readonly<{ status: 'answered' }>
  | Readonly<{ status: 'not_visible' }>
  | Readonly<{ status: 'dialog_changed'; dialogId: ClaudeUnifiedDialogId | null }>
  | Readonly<{ status: 'failed'; reason: string }>;

function failed(reason: string): ClaudeUnifiedDialogAnswerResult {
  return { status: 'failed', reason };
}

function captureFailureReason(
  failure: Extract<Awaited<ReturnType<typeof captureScreenState>>, { kind: 'host_dead' | 'capture_failed' }>,
): string {
  return failure.kind === 'host_dead'
    ? `host_dead:${failure.recoverable ? 'recoverable' : 'unrecoverable'}`
    : failure.reason;
}

async function sendKey(port: TerminalControlPort, key: 'ArrowUp' | 'ArrowDown' | 'Enter') {
  const failure = sendResultToFailure(await port.sendSpecialKey(key));
  return failure ? failed(failure.reason ?? failure.kind) : null;
}

export async function answerClaudeUnifiedRegisteredDialog(params: Readonly<{
  port: TerminalControlPort;
  dialogId: ClaudeUnifiedDialogId;
  expectedIdentity?: string | undefined;
  option: ClaudeUnifiedDialogOption;
  initialState?: ClaudeScreenState | undefined;
  verifyAfterSubmit?: boolean | undefined;
  settleMs: number;
  wait: (ms: number) => Promise<void>;
  /** Fired after the option's complete answer recipe was successfully written to the terminal. */
  onSubmitted?: (() => void) | undefined;
}>): Promise<ClaudeUnifiedDialogAnswerResult> {
  let captured = params.initialState
    ? { kind: 'state' as const, state: params.initialState }
    : await captureScreenState(params.port);
  if (captured.kind !== 'state') return failed(captureFailureReason(captured));

  let dialog = resolveClaudeUnifiedVisibleDialog(captured.state);
  if (!dialog) return { status: 'not_visible' };
  if (
    dialog.dialogId !== params.dialogId
    || (params.expectedIdentity !== undefined && getClaudeUnifiedDialogIdentity(dialog) !== params.expectedIdentity)
  ) {
    return { status: 'dialog_changed', dialogId: dialog.dialogId };
  }

  let currentOption = dialog.options.find((candidate) => candidate.choice === params.option.choice);
  if (!currentOption) return { status: 'dialog_changed', dialogId: dialog.dialogId };
  if (currentOption.answer.kind === 'unavailable') return failed('selection_unavailable');

  if (currentOption.answer.kind === 'literal') {
    const failure = sendResultToFailure(await params.port.sendLiteralText(currentOption.answer.text));
    if (failure) return failed(failure.reason ?? failure.kind);
  } else if (currentOption.answer.kind === 'key') {
    const failure = await sendKey(params.port, currentOption.answer.key);
    if (failure) return failure;
  } else {
    const targetLabel = currentOption.answer.targetLabel;
    const maxSteps = Math.max(1, captured.state.visibleDialogSelection?.options.length ?? 0);
    let submitted = false;
    for (let step = 0; step <= maxSteps; step += 1) {
      const presentation = captured.state.visibleDialogSelection;
      if (!presentation || presentation.kind !== 'focused') return failed('selection_presentation_changed');
      const targetIndexes = presentation.options.flatMap((candidate, index) => (
        candidate.label === targetLabel ? [index] : []
      ));
      const focusedIndexes = presentation.options.flatMap((candidate, index) => candidate.focused ? [index] : []);
      if (targetIndexes.length !== 1 || focusedIndexes.length !== 1) return failed('selection_ambiguous');
      const targetIndex = targetIndexes[0]!;
      const focusedIndex = focusedIndexes[0]!;
      if (focusedIndex === targetIndex) {
        const failure = await sendKey(params.port, 'Enter');
        if (failure) return failure;
        submitted = true;
        break;
      }

      const failure = await sendKey(params.port, targetIndex > focusedIndex ? 'ArrowDown' : 'ArrowUp');
      if (failure) return failure;
      await params.wait(params.settleMs);
      const next = await captureScreenState(params.port);
      if (next.kind !== 'state') return failed(captureFailureReason(next));
      const nextDialog = resolveClaudeUnifiedVisibleDialog(next.state);
      if (!nextDialog) return failed('dialog_disappeared_during_navigation');
      if (
        nextDialog.dialogId !== params.dialogId
        || (params.expectedIdentity !== undefined && getClaudeUnifiedDialogIdentity(nextDialog) !== params.expectedIdentity)
      ) {
        return { status: 'dialog_changed', dialogId: nextDialog.dialogId };
      }
      const nextFocused = next.state.visibleDialogSelection?.options.findIndex((candidate) => candidate.focused) ?? -1;
      if (nextFocused === focusedIndex) return failed('selection_did_not_move');
      captured = next;
      dialog = nextDialog;
      currentOption = dialog.options.find((candidate) => candidate.choice === params.option.choice);
      if (!currentOption || currentOption.answer.kind !== 'selection') return failed('selection_presentation_changed');
    }
    if (!submitted) return failed('selection_target_unreachable');
  }

  params.onSubmitted?.();
  if (params.verifyAfterSubmit === false) return { status: 'answered' };
  const { verifyPollIntervalMs, verifyPollTimeoutMs } = DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS;
  const maxVerifyPolls = Math.max(1, Math.ceil(verifyPollTimeoutMs / verifyPollIntervalMs));
  for (let poll = 0; poll < maxVerifyPolls; poll += 1) {
    await params.wait(poll === 0 ? params.settleMs : verifyPollIntervalMs);
    const after = await captureScreenState(params.port);
    if (after.kind !== 'state') return failed(captureFailureReason(after));
    const afterDialog = resolveClaudeUnifiedVisibleDialog(after.state);
    const sameDialog = afterDialog && (
      params.expectedIdentity === undefined
        ? afterDialog.dialogId === params.dialogId
        : getClaudeUnifiedDialogIdentity(afterDialog) === params.expectedIdentity
    );
    if (!sameDialog) return { status: 'answered' };
  }
  return failed('dialog_still_visible');
}
