import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import {
  ScmOperationErrorCodeSchema,
} from './operationError.js';
import { ScmRequestBaseSchema } from './requestBase.js';
import { ScmOperationOutcomeSchema } from './operationOutcome.js';

export const SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN = 'remove-worktree' as const;

export const ScmWorktreeCommandResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: ScmOperationOutcomeSchema.optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
}));
export type ScmWorktreeCommandResponse = z.infer<typeof ScmWorktreeCommandResponseSchema>;

export const ScmWorktreeCreateRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  displayName: z.string().min(1).optional(),
  baseRef: z.string().min(1).optional(),
  branchMode: z.enum(['new', 'existing']).optional(),
}));
export type ScmWorktreeCreateRequest = z.infer<typeof ScmWorktreeCreateRequestSchema>;

export const ScmWorktreeCreateResponseSchema = lazyZodSchema(() => z.discriminatedUnion('success', [z.object({
  success: z.literal(true),
  outcome: ScmOperationOutcomeSchema.optional(),
  worktreePath: z.string(),
  branchName: z.string(),
  sourceRootPath: z.string().optional(),
  repositoryRootPath: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
}), z.object({
  success: z.literal(false),
  outcome: ScmOperationOutcomeSchema.optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
})]));
export type ScmWorktreeCreateResponse = z.infer<typeof ScmWorktreeCreateResponseSchema>;

export const ScmWorktreeRemoveRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  worktreePath: z.string().min(1),
  confirmed: z.literal(true),
  authorizationToken: z.literal(SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN),
}));
export type ScmWorktreeRemoveRequest = z.infer<typeof ScmWorktreeRemoveRequestSchema>;

export const ScmWorktreeRemoveResponseSchema = ScmWorktreeCommandResponseSchema;
export type ScmWorktreeRemoveResponse = z.infer<typeof ScmWorktreeRemoveResponseSchema>;

/** Separate advertised operations: an older backend must never ignore a retention request. */
export const ScmWorktreeRetireRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  worktreePath: z.string().min(1),
  targetPath: z.string().min(1),
  entryId: z.string().min(1),
}).strict());
export type ScmWorktreeRetireRequest = z.infer<typeof ScmWorktreeRetireRequestSchema>;
export const ScmWorktreeReinstateRequestSchema = ScmWorktreeRetireRequestSchema;
export type ScmWorktreeReinstateRequest = ScmWorktreeRetireRequest;

export const ScmWorktreePruneRequestSchema = ScmRequestBaseSchema;
export type ScmWorktreePruneRequest = z.infer<typeof ScmWorktreePruneRequestSchema>;

export const ScmWorktreePruneResponseSchema = ScmWorktreeCommandResponseSchema;
export type ScmWorktreePruneResponse = z.infer<typeof ScmWorktreePruneResponseSchema>;
