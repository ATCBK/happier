import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { BUG_REPORT_DEFAULT_ISSUE_OWNER, BUG_REPORT_DEFAULT_ISSUE_REPO } from '../../bugs/reports/types.js';

export const BUG_REPORT_SUBMISSION_ACTION_IDS = ['bugreport.submit'] as const;

// This is the submission envelope, not a second form-validation policy. The
// answering client's existing draft owner validates required fields and consent.
export const BugReportDraftInputSchema = lazyZodSchema(() => z.strictObject({
  title: z.string(), summary: z.string(), reporterGithubUsername: z.optional(z.string()),
  currentBehavior: z.optional(z.string()), expectedBehavior: z.optional(z.string()),
  reproductionStepsText: z.string(), whatChangedRecently: z.string(),
  frequency: z.optional(z.enum(['always', 'often', 'sometimes', 'once'])),
  severity: z.optional(z.enum(['blocker', 'high', 'medium', 'low'])),
  environment: z.strictObject({
    appVersion: z.string(), platform: z.string(),
    osVersion: z.optional(z.string()), deviceModel: z.optional(z.string()),
    serverUrl: z.optional(z.string()), serverVersion: z.optional(z.string()),
    deploymentType: z.enum(['cloud', 'self-hosted', 'enterprise']),
  }),
  includeDiagnostics: z.boolean(), diagnosticsKinds: z.optional(z.array(z.string())),
  acceptedPrivacyNotice: z.boolean(),
}));

export const BugReportSubmitInputSchema = lazyZodSchema(() => z.strictObject({
  draft: BugReportDraftInputSchema,
  destination: z.strictObject({
    providerUrl: z.nullable(z.string().check(z.url(), z.refine(value => {
      const url = new URL(value);
      return !url.username && !url.password;
    }, 'Report destination must not contain credentials'))),
    issueOwner: z.literal(BUG_REPORT_DEFAULT_ISSUE_OWNER),
    issueRepo: z.literal(BUG_REPORT_DEFAULT_ISSUE_REPO),
    existingIssueNumber: z.optional(z.number().check(z.int(), z.positive())),
  }),
  pastedCliDoctorSnapshotJson: z.optional(z.string()),
}));

export const BugReportSubmitOutputSchema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('fallback') }),
  z.strictObject({ mode: z.literal('submitted'), reportId: z.string().check(z.minLength(1)), issueNumber: z.number().check(z.int(), z.positive()),
    issueUrl: z.string().check(z.url()), artifactCount: z.number().check(z.int(), z.nonnegative()) }),
]));
export type BugReportDraftInput = z.infer<typeof BugReportDraftInputSchema>;
export type BugReportSubmitInput = z.infer<typeof BugReportSubmitInputSchema>;
export type BugReportSubmitOutput = z.infer<typeof BugReportSubmitOutputSchema>;

/** Only the declared review operands enter observation or durable approval custody. */
export function projectBugReportSubmitInput(input: unknown) {
  const parsed = BugReportSubmitInputSchema.safeParse(input);
  if (!parsed.success) return {};
  return {
    draft: {
      includeDiagnostics: parsed.data.draft.includeDiagnostics,
      diagnosticsKinds: parsed.data.draft.diagnosticsKinds ?? 'Configured diagnostic defaults',
      acceptedPrivacyNotice: parsed.data.draft.acceptedPrivacyNotice,
    },
    ...(parsed.data.pastedCliDoctorSnapshotJson ? { pastedCliDoctorSnapshotJson: '[supplied privately]' } : {}),
    destination: parsed.data.destination,
  };
}
