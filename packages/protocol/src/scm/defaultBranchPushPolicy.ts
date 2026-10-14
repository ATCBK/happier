import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export const ScmDefaultBranchPushPolicySchema = lazyZodSchema(() => z.enum([
  'allow',
  'requires-feature-branch',
  'deny',
]));
export type ScmDefaultBranchPushPolicy = z.infer<typeof ScmDefaultBranchPushPolicySchema>;
