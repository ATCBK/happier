export type ExecutionRunStartIntentPolicyResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: string; errorCode: string; details?: unknown }>;

export type ExecutionRunIntentStartPreflightParams = Readonly<{
  backendId: string;
  intentInput?: unknown;
  cwd: string;
  env: NodeJS.ProcessEnv;
}>;

export function executionRunStartNotAllowed(error: string): Extract<ExecutionRunStartIntentPolicyResult, { ok: false }> {
  return { ok: false, error, errorCode: 'execution_run_not_allowed' };
}
