import { lazyZodSchema } from './lazyZodSchema.js';
import { z } from 'zod/mini';

export const StopSessionIncompleteReasonSchema = lazyZodSchema(() => z.enum([
  'invalid_session_id',
  'explicit_stop_failed',
  'legacy_attachment',
  'missing_attachment_identity',
  'tracked_runner_absent',
  'runner_signal_incomplete',
  'runner_exit_observer_unavailable',
  'runner_exit_timeout',
  'terminal_host_adapter_unavailable',
  'attachment_mismatch',
  'missing_topology_proof',
  'disposition_in_progress',
  'destroy_failed',
  'terminal_control_serviceability_retirement_failed',
  'terminal_attachment_descriptor_retirement_failed',
]));

export type StopSessionIncompleteReason = z.infer<typeof StopSessionIncompleteReasonSchema>;

export const StopSessionResultSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('stopped') }),
  z.strictObject({ status: z.literal('requested') }),
  z.strictObject({ status: z.literal('not_found') }),
  z.strictObject({
    status: z.literal('incomplete'),
    reason: StopSessionIncompleteReasonSchema,
  }),
]));

export type StopSessionResult = z.infer<typeof StopSessionResultSchema>;
