/**
 * Some tools/IDEs set environment variables to detect "nested sessions".
 * If those variables leak into spawned processes, child tools may refuse to
 * start (e.g. to prevent recursive/nested execution).
 *
 * Today we strip Claude Code's nested-session detection variables.
 * Keep this helper backend-agnostic since the daemon and multiple backends
 * spawn child processes.
 */
export function stripNestedSessionDetectionEnv(
  input: NodeJS.ProcessEnv,
  explicitEnvironment?: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...input };
  delete out.CLAUDECODE;
  delete out.CLAUDE_CODE_ENTRYPOINT;
  // Attribution deliberately selected for this child is not an inherited
  // nested-session marker. Never restore a value removed by scoped merging.
  const explicitEntrypoint = explicitEnvironment?.CLAUDE_CODE_ENTRYPOINT;
  if (typeof explicitEntrypoint === 'string' && input.CLAUDE_CODE_ENTRYPOINT === explicitEntrypoint) {
    out.CLAUDE_CODE_ENTRYPOINT = explicitEntrypoint;
  }
  // Happier reports managed agent lifecycle to Herdr. Native provider hooks
  // must not claim the same pane and replace Happier's resume command.
  delete out.HERDR_ENV;
  return out;
}
