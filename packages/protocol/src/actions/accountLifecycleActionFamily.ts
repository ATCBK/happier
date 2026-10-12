import { z } from 'zod';

export const ACCOUNT_LIFECYCLE_ACTION_IDS = ['account.signOut', 'account.credentials.forgetAll', 'account.delete'] as const;
export type AccountLifecycleActionId = typeof ACCOUNT_LIFECYCLE_ACTION_IDS[number];
const target = z.object({ serverId: z.string().trim().min(1), accountId: z.string().trim().min(1) }).strict();
export const ACCOUNT_LIFECYCLE_ACTION_INPUT_SCHEMAS = {
  'account.signOut': target,
  'account.credentials.forgetAll': target.extend({ scope: z.literal('all-credentials') }).strict(),
  'account.delete': target,
} as const;
export const ACCOUNT_LIFECYCLE_ACTION_OUTPUT_SCHEMAS = {
  'account.signOut': z.object({ status: z.enum(['signed_out', 'cancelled']) }).strict(),
  'account.credentials.forgetAll': z.object({ status: z.enum(['forgotten', 'cancelled']) }).strict(),
  'account.delete': z.object({ status: z.enum(['deleted', 'deleted_cleanup_pending', 'cancelled']) }).strict(),
} as const;
export type AccountLifecycleActionInput = z.infer<(typeof ACCOUNT_LIFECYCLE_ACTION_INPUT_SCHEMAS)[AccountLifecycleActionId]>;
export function isAccountLifecycleActionId(id: string): id is AccountLifecycleActionId {
  return (ACCOUNT_LIFECYCLE_ACTION_IDS as readonly string[]).includes(id);
}
