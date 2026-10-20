import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { RestartSessionRunnerRequestV1Schema } from './sessionRunnerRestartV1.js';

import { SessionProviderBindingSecurityChangeConfirmationV1Schema } from '../../providers/sessions/bindingMetadataV1.js';
import { SessionRunnerProcessIdentityV2Schema } from './sessionRunnerRuntimeV2.js';

const SessionRunnerSessionIdV2Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const SessionRunnerIdentityV2Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const SessionRunnerPidV2Schema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));

/**
 * Additive, recovery-only restart contract. V1 remains the predecessor-exact
 * ordinary restart wire and must not gain these fields or reason values.
 */
export const RestartSessionRunnerRequestV2Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(2),
    sessionId: SessionRunnerSessionIdV2Schema,
    mode: z.literal('force_current_cli'),
    reason: z.literal('provider_binding_change_recovery'),
    expectedRunnerPid: SessionRunnerPidV2Schema,
    expectedProcessCommandHash: SessionRunnerIdentityV2Schema,
    expectedRunnerEntrypointIdentity: SessionRunnerIdentityV2Schema,
    expectedRunnerProcessIdentity: SessionRunnerProcessIdentityV2Schema,
    providerBindingSecurityChangeConfirmationV1:
      z.optional(SessionProviderBindingSecurityChangeConfirmationV1Schema),
  }).check(z.superRefine((value, ctx) => {
    if (value.expectedRunnerPid !== value.expectedRunnerProcessIdentity.pid) {
      ctx.addIssue({
        code: "custom",
        path: ['expectedRunnerProcessIdentity', 'pid'],
        message: 'Expected runner process identity must match the guarded runner PID',
      });
    }
    const confirmation = value.providerBindingSecurityChangeConfirmationV1;
    if (confirmation && confirmation.sessionId !== value.sessionId) {
      ctx.addIssue({
        code: "custom",
        path: ['providerBindingSecurityChangeConfirmationV1', 'sessionId'],
        message: 'Provider binding confirmation must target the restarted session',
      });
    }
  })));
export type RestartSessionRunnerRequestV2 = z.infer<typeof RestartSessionRunnerRequestV2Schema>;

/** Explicit consent changes the operation, while both predecessor request shapes remain unchanged. */
export const RestartSessionRunnerConfirmedBackgroundRequestSchema = lazyZodSchema(() => z.union([
  RestartSessionRunnerRequestV1Schema,
  RestartSessionRunnerRequestV2Schema,
]));
export type RestartSessionRunnerConfirmedBackgroundRequest = z.infer<typeof RestartSessionRunnerConfirmedBackgroundRequestSchema>;
