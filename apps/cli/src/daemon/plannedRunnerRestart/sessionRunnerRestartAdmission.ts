import { z } from 'zod/mini';

import { daemonPost, type DaemonControlRequestOptions } from '../controlHttp';

export const SESSION_RUNNER_RESTART_ADMISSION_CURRENT_PATH = '/session-runners/restart-admission/current';
export const SessionRunnerRestartAdmissionIdentitySchema = z.strictObject({
  requestId: z.string().check(z.minLength(1)),
  expectedPid: z.number().check(z.int(), z.positive()),
});
export const SessionRunnerRestartAdmissionCurrentSchema = z.strictObject({ current: z.boolean() });
export type SessionRunnerRestartAdmissionIdentity = z.infer<typeof SessionRunnerRestartAdmissionIdentitySchema>;
export type SessionRunnerRestartAdmissionAttempt = SessionRunnerRestartAdmissionIdentity & Readonly<{ signal: AbortSignal }>;

/** Unknown daemon observations keep receiving admission closed. No control read authorizes a restart. */
export async function readSessionRunnerRestartAdmissionCurrent(
  request: SessionRunnerRestartAdmissionIdentity,
  options: DaemonControlRequestOptions = {},
): Promise<boolean | null> {
  const result: unknown = await daemonPost(SESSION_RUNNER_RESTART_ADMISSION_CURRENT_PATH, request, { ...options, timeoutMs: null });
  const parsed = SessionRunnerRestartAdmissionCurrentSchema.safeParse(result);
  return parsed.success ? parsed.data.current : null;
}
