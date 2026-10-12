import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { BUG_REPORT_DEFAULT_ISSUE_OWNER, BUG_REPORT_DEFAULT_ISSUE_REPO } from '../../bugs/reports/types.js';

export const BUG_REPORT_SUBMISSION_ACTION_IDS = ['bugreport.submit'] as const;

// This is the submission envelope, not a second form-validation policy. The
// answering client's existing draft owner validates required fields and consent.
export const BugReportDraftInputSchema = lazyZodSchema(() => z.object({
  title: z.string(), summary: z.string(), reporterGithubUsername: z.string().optional(),
  currentBehavior: z.string().optional(), expectedBehavior: z.string().optional(),
  reproductionStepsText: z.string(), whatChangedRecently: z.string(),
  frequency: z.enum(['always', 'often', 'sometimes', 'once']).optional(),
  severity: z.enum(['blocker', 'high', 'medium', 'low']).optional(),
  environment: z.object({
    appVersion: z.string(), platform: z.string(),
    osVersion: z.string().optional(), deviceModel: z.string().optional(),
    serverUrl: z.string().optional(), serverVersion: z.string().optional(),
    deploymentType: z.enum(['cloud', 'self-hosted', 'enterprise']),
  }).strict(),
  includeDiagnostics: z.boolean(), diagnosticsKinds: z.array(z.string()).optional(),
  acceptedPrivacyNotice: z.boolean(),
}).strict());

export const BugReportSubmitInputSchema = lazyZodSchema(() => z.object({
  draft: BugReportDraftInputSchema,
  destination: z.object({
    providerUrl: z.string().url().refine(value => {
      const url = new URL(value);
      return !url.username && !url.password;
    }, 'Report destination must not contain credentials').nullable(),
    issueOwner: z.literal(BUG_REPORT_DEFAULT_ISSUE_OWNER),
    issueRepo: z.literal(BUG_REPORT_DEFAULT_ISSUE_REPO),
    existingIssueNumber: z.number().int().positive().optional(),
  }).strict(),
  pastedCliDoctorSnapshotJson: z.string().optional(),
}).strict());

export const BugReportSubmitOutputSchema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fallback') }).strict(),
  z.object({ mode: z.literal('submitted'), reportId: z.string().min(1), issueNumber: z.number().int().positive(),
    issueUrl: z.string().url(), artifactCount: z.number().int().nonnegative() }).strict(),
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
