import { ExternalActionRequestIdV1Schema, ExternalActionTargetV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { z } from 'zod/mini';

export const SIGNED_ROOT_ACTION_EXECUTE_PATH = '/actions/root/execute';
export const SignedRootActionExecuteRequestSchema = z.strictObject({
  actionId: SignedRootActionIdSchema,
  input: z.unknown(),
  // The private host may narrow terminal ingress to MCP automation. Public
  // Action inputs cannot select authority or claim an interactive UI surface.
  surface: z.optional(z.enum(['cli', 'mcp'])),
  target: z.optional(ExternalActionTargetV1Schema),
  // Request identities reuse the one Protocol-owned schema the external Action
  // envelope enforces downstream; no local grammar may trim or rewrite them.
  actionRequestId: z.optional(ExternalActionRequestIdV1Schema),
});
export type SignedRootActionExecuteRequest = z.infer<
  typeof SignedRootActionExecuteRequestSchema
>;
