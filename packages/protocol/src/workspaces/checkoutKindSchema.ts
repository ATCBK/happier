import { z } from 'zod/mini';

export const WorkspaceCheckoutKindSchema = z.enum([
  'primary',
  'git_worktree',
]);
export type WorkspaceCheckoutKind = z.infer<typeof WorkspaceCheckoutKindSchema>;
