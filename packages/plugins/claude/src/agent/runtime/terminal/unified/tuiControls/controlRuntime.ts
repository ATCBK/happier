import { TERMINAL_BRACKETED_PASTE_START, TERMINAL_BRACKETED_PASTE_END } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  TerminalControlPort,
  TerminalControlSendResult,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { parseClaudeScreenState, type ClaudeScreenState } from '../screenState.js';
import type { ControlAttemptResult } from './outcome.js';
import type { ClaudeTuiControlTimings } from './types.js';

/** Shared low-level runtime the slash/mode control modules compose over the terminal control port. */
export type ControlRuntime = Readonly<{
  port: TerminalControlPort;
  wait: (ms: number) => Promise<void>;
  timings: ClaudeTuiControlTimings;
  nowMs: () => number;
}>;

export type CaptureFailure =
  | Readonly<{ kind: 'host_dead'; recoverable: boolean }>
  | Readonly<{ kind: 'capture_failed'; reason: string }>;

export type CaptureOutcome =
  | Readonly<{ kind: 'state'; state: ClaudeScreenState }>
  | CaptureFailure;

export type SendFailureResult =
  | Extract<ControlAttemptResult, Readonly<{ kind: 'unsupported' }>>
  | Extract<ControlAttemptResult, Readonly<{ kind: 'failed' }>>;

/** Display verification for exact text already written by this operation, never a preexisting draft. */
export function doesClaudeOwnedTextMatchCapture(expected: string, captured: string): boolean {
  const visibleText = (text: string) => text.trim().replace(/\s+/gu, ' ');
  return visibleText(expected) === visibleText(captured);
}

/** Native question and plan editors preserve TAB/LF/CR inside bracketed paste (2.1.304 probes). */
export function hasUnsupportedClaudeNativeTextControls(text: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);
}

/** Native editors consume exact payload bytes, unlike interactive terminal paste encoding. */
export function encodeClaudeNativeTextInput(text: string): string {
  return TERMINAL_BRACKETED_PASTE_START + text + TERMINAL_BRACKETED_PASTE_END;
}

export async function captureScreenState(port: TerminalControlPort): Promise<CaptureOutcome> {
  const result = await port.captureScreen();
  switch (result.status) {
    case 'captured':
      // Prefer the styled raw capture when the host produced one (ported S-8): the SGR-dim
      // placeholder walker needs styling info; the parser strips ANSI internally otherwise.
      return {
        kind: 'state',
        state: parseClaudeScreenState(result.capture.styledText ?? result.capture.text, { cursor: result.capture.cursor }),
      };
    case 'host_dead':
      return { kind: 'host_dead', recoverable: result.recoverable };
    case 'unsupported':
      return { kind: 'capture_failed', reason: `capture_unsupported:${result.reason}` };
    case 'failed':
      return { kind: 'capture_failed', reason: result.reason };
  }
}

/** Map a (already-narrowed) capture failure to a public control result. */
export function captureFailureToResult(capture: CaptureFailure): ControlAttemptResult {
  if (capture.kind === 'host_dead') {
    return { kind: 'failed', reason: `host_dead:${capture.recoverable ? 'recoverable' : 'unrecoverable'}` };
  }
  return { kind: 'failed', reason: capture.reason };
}

/** Map a non-`sent` send result to a public control result; returns null when the send succeeded. */
export function sendResultToFailure(send: TerminalControlSendResult): SendFailureResult | null {
  switch (send.status) {
    case 'sent':
      return null;
    case 'host_dead':
      return { kind: 'failed', reason: `host_dead:${send.recoverable ? 'recoverable' : 'unrecoverable'}` };
    case 'unsupported':
      return { kind: 'unsupported', reason: send.reason };
    case 'failed':
      return { kind: 'failed', reason: send.reason };
  }
}
