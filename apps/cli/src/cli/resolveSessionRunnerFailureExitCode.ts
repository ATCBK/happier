import { HostTerminalTranscriptFollowAdmissionError } from '@/agent/runtime/session/terminal/contract';
import { isPluginError } from '@happier-dev/plugin-sdk';
import {
  isAgentSessionContinuationUnreachableError,
  SESSION_RUNNER_EXIT_CODES,
} from '@/session/shared/spawnSessionContract';

/** Preserve non-retryable host admission failures across the runner process boundary. */
export function resolveSessionRunnerFailureExitCode(error: unknown): number {
  if (isAgentSessionContinuationUnreachableError(error)) {
    return SESSION_RUNNER_EXIT_CODES.CONTINUATION_UNREACHABLE;
  }
  // Binding failed before a terminal child existed. Repeating the same launch
  // cannot supply the missing admission; the preserved Session can be retried explicitly.
  if (error instanceof HostTerminalTranscriptFollowAdmissionError && error.phase === 'bind') {
    return SESSION_RUNNER_EXIT_CODES.TERMINAL_FOLLOW_ADMISSION_FAILED;
  }
  // A refused requester cannot be supplied by repeating this same runner.
  // Keep the existing terminal admission disposition and explicit Resume recovery.
  if (isPluginError(error) && error.code === 'project_requester_credentials_unavailable') {
    return SESSION_RUNNER_EXIT_CODES.TERMINAL_FOLLOW_ADMISSION_FAILED;
  }
  return 1;
}
