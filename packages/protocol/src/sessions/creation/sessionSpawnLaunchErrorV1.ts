import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES, SCOPED_RPC_SOCKET_CONNECTION_PHASES } from '../../rpc/errors.js';

/** Redacted presentation of a failed launch; never launch or retry authority. */
export const SessionSpawnLaunchErrorV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('launch_error'),
  code: z.string().check(z.regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u)),
  message: z.string().check(z.refine(value => value.trim().length > 0)),
  rpcErrorCode: z.optional(z.enum([MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES.OUTCOME_UNKNOWN])),
  connectionPhase: z.optional(z.enum(SCOPED_RPC_SOCKET_CONNECTION_PHASES)),
}));
export type SessionSpawnLaunchErrorV1 = z.infer<typeof SessionSpawnLaunchErrorV1Schema>;
