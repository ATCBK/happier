import { z } from 'zod/mini';

/** Shared wire invariant for stored and executor-opened Discussion messages. */
export function refineDiscussionAccountActor(
  value: Readonly<{
    authorAccountId: string | null;
    accountActor: Readonly<{ accountId: string }> | null;
  }>,
  context: z.core.$RefinementCtx,
): void {
  if (value.accountActor !== null && value.accountActor.accountId !== value.authorAccountId) {
    context.addIssue({
      code: 'custom',
      path: ['accountActor', 'accountId'],
      message: 'Discussion actor identity must match the authenticated author',
    });
  }
}

