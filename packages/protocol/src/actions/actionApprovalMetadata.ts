import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ActionSurfaceSchema } from './metadata.js';

/** Host-only confirmation ownership; result custody remains in ActionApproval. */
export const ActionApprovalPolicySchema = lazyZodSchema(() => z.object({
  uiConfirmation: z.literal('policy').optional(),
  uiConfirmationForInput: z.custom<(input: unknown) => boolean>((value) => typeof value === 'function').optional(),
  agentDefault: z.enum(['egress', 'authority']).optional(),
  requiredSurfaces: z.array(ActionSurfaceSchema.keyof()).readonly().optional(),
  scopeAdmissionOwnsConfirmation: z.literal(true).optional(),
  pluginCaptureWaiver: z.literal(true).optional(),
  computerConsent: z.literal(true).optional(),
  control: z.literal(true).optional(),
  rpcConfirmation: z.literal(true).optional(),
  retainUiFieldIntent: z.literal(true).optional(),
}).strict());

export const ActionApprovalFlowSchema = lazyZodSchema(() => z.enum(['blocking', 'deferred']));
export type ActionApprovalFlow = z.infer<typeof ActionApprovalFlowSchema>;

export const ActionApprovalResultSchema = lazyZodSchema(() => z.enum(['required', 'optional', 'none']));
export type ActionApprovalResult = z.infer<typeof ActionApprovalResultSchema>;

export const ActionApprovalSchema = lazyZodSchema(() => z
  .object({
    flow: ActionApprovalFlowSchema.optional(),
    result: ActionApprovalResultSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.result === 'optional' && value.flow == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow'],
        message: 'optional approval results require an explicit flow',
      });
    }
  }));
export type ActionApproval = z.infer<typeof ActionApprovalSchema>;

export function resolveActionApprovalFlow(approval: ActionApproval): ActionApprovalFlow {
  if (approval.flow) return approval.flow;
  return approval.result === 'required' ? 'blocking' : 'deferred';
}
