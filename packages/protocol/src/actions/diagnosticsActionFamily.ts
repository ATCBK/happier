import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const DIAGNOSTICS_ACTION_IDS = ['diagnostics.diagnosis.run', 'diagnostics.daemons.check', 'diagnostics.status.get'] as const;
export type DiagnosticsActionId = typeof DIAGNOSTICS_ACTION_IDS[number];
export const DiagnosticsActionIdSchema = lazyZodSchema(() => z.enum(DIAGNOSTICS_ACTION_IDS));

const EmptyInputSchema = lazyZodSchema(() => z.object({}).strict());
const UnavailableSchema = lazyZodSchema(() => z.object({ status: z.literal('unavailable') }).strict());
export const DiagnosisReportSchema = lazyZodSchema(() => z.object({
  capturedAt: z.string(),
  findings: z.array(z.object({
    code: z.enum(['server.mismatch.ui_vs_machine', 'server.mismatch.ui_vs_pasted', 'server.mismatch.settings_vs_resolved',
      'server.multiple_machines_multiple_servers', 'server.profile_missing_for_active_url', 'auth.mismatch.ui_vs_machine_account',
      'auth.machine_missing_account', 'machine.none_online', 'server.diagnostics_disabled', 'auth.server_401', 'server.unreachable', 'server.http_error']),
    severity: z.enum(['info', 'warning', 'error']),
    machineIds: z.array(z.string()).optional(),
    details: z.object({
      activeServerId: z.string().optional(), activeServerUrl: z.string().optional(),
      uiServerUrl: z.string().optional(), machineServerUrl: z.string().optional(), pastedServerUrl: z.string().optional(),
      uiProfileId: z.string().nullable().optional(), machineAccountId: z.string().optional(),
      settingsActiveServerId: z.string().optional(), resolvedServerId: z.string().optional(),
      machineServerUrls: z.array(z.string()).optional(), httpStatus: z.number().int().optional(), detail: z.string().optional(),
    }).strict().optional(),
  }).strict()),
}).strict());
export type DiagnosisReportV1 = z.infer<typeof DiagnosisReportSchema>;

export const DiagnosticsActionInputSchemas = {
  'diagnostics.diagnosis.run': EmptyInputSchema,
  'diagnostics.daemons.check': EmptyInputSchema,
  'diagnostics.status.get': EmptyInputSchema,
} as const;
export const DiagnosticsActionOutputSchemas = {
  'diagnostics.diagnosis.run': lazyZodSchema(() => z.union([
    z.object({ status: z.literal('completed'), report: DiagnosisReportSchema }).strict(), UnavailableSchema,
  ])),
  'diagnostics.daemons.check': lazyZodSchema(() => z.union([
    z.object({ status: z.literal('completed'), machines: z.array(z.object({
      machineId: z.string(), status: z.enum(['ready', 'error']),
    }).strict()) }).strict(), UnavailableSchema,
  ])),
  // This is the incumbent sanitized Copy JSON export, not an executable or policy envelope.
  'diagnostics.status.get': lazyZodSchema(() => z.union([
    z.object({ status: z.literal('available'), json: z.string() }).strict(), UnavailableSchema,
  ])),
} as const;
export type DiagnosticsActionResult = z.infer<typeof DiagnosticsActionOutputSchemas[DiagnosticsActionId]>;
