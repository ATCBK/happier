import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionAuthoringCheckoutCreationDraftV1Schema } from '../authoring/creationFieldsV1.js';
import { SessionExecutionTargetV1Schema } from './sessionExecutionTargetV1.js';
import { SessionDirectoryIntentV1Schema, refineSessionDirectoryIntentCheckoutV1 } from './sessionDirectoryIntentV1.js';
import { SessionCreationTagV1Schema } from './sessionCreationIdentityV1.js';
import type { SessionSpawnNewInputV2 } from './sessionSpawnNewInputV2.js';
import type { SessionExecutionTargetV1 } from './sessionExecutionTargetV1.js';

/**
 * Host-only evidence that a user approved creation of this exact canonical
 * target directory. It is retained with the existing Action approval artifact,
 * never accepted from the public Session-spawn input, and is discarded once
 * the daemon has consumed it to materialize the directory.
 */
export const SessionCreationDirectoryApprovalV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  executionTarget: SessionExecutionTargetV1Schema,
  directory: z.string().check(z.trim(), z.minLength(1)),
}));
export type SessionCreationDirectoryApprovalV1 = z.infer<
  typeof SessionCreationDirectoryApprovalV1Schema
>;

export const SessionCreationTargetPreparationRequestV1Schema = lazyZodSchema(() => z.strictObject({
  directory: SessionDirectoryIntentV1Schema,
  sessionCreationTag: z.optional(SessionCreationTagV1Schema),
  checkoutCreationDraft: z.optional(z.nullable(SessionAuthoringCheckoutCreationDraftV1Schema)),
}).check(z.superRefine(refineSessionDirectoryIntentCheckoutV1)));
export type SessionCreationTargetPreparationRequestV1 = z.infer<
  typeof SessionCreationTargetPreparationRequestV1Schema
>;

export const SessionCreationPreparedCheckoutV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('git_worktree'),
  finalDirectory: z.string().check(z.trim(), z.minLength(1)),
  baseRef: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  branchMode: z.enum(['new', 'existing']),
  /** Last observed actual branch; null proves detached, omission is unavailable. */
  branchName: z.optional(z.nullable(z.string())),
  /**
   * Target-owned materialization receipt. Only an explicit `true` proves this
   * preparation created the checkout and may authorize a compensating remove.
   * Older targets omit it and are therefore never cleaned up speculatively.
   */
  created: z.optional(z.boolean()),
}));
export type SessionCreationPreparedCheckoutV1 = z.infer<
  typeof SessionCreationPreparedCheckoutV1Schema
>;

export const SessionCreationTargetPreparationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    directory: z.string().check(z.trim(), z.minLength(1)),
    directoryKind: z.enum(['path', 'managed']),
    /** Whether this direct target requires user authorization before mkdir. */
    directoryCreationRequired: z.boolean(),
    checkout: z.nullable(SessionCreationPreparedCheckoutV1Schema),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      'invalid_directory',
      'checkout_unavailable',
      'checkout_failed',
    ]),
  }),
]));
export type SessionCreationTargetPreparationResultV1 = z.infer<
  typeof SessionCreationTargetPreparationResultV1Schema
>;

/** Worktrees and managed directories retain their separate materialization owner. */
export function needsSessionCreationDirectoryApprovalPreflightV1(
  input: Pick<SessionSpawnNewInputV2, 'directory' | 'checkoutCreationDraft'>,
): boolean {
  return input.directory.kind === 'path' && !input.checkoutCreationDraft;
}

/** UI and CLI retain the same target-produced proof before asking for consent. */
export function projectSessionCreationDirectoryApprovalV1(
  executionTarget: SessionExecutionTargetV1,
  preparedTarget: Extract<SessionCreationTargetPreparationResultV1, { ok: true }>,
): SessionCreationDirectoryApprovalV1 | null {
  return preparedTarget.directoryCreationRequired
    ? { v: 1, executionTarget, directory: preparedTarget.directory }
    : null;
}
