import { z } from 'zod';
import { ClaudeSessionRuntimeUsageLimitDetailsSchema, ClaudeSessionRuntimeTemporaryThrottleDetailsSchema } from './providerFailureDetails.js';
import { mapClaudeProviderFailureToUsageDetails as mapProviderFailure } from '../../auth/services/runtime/usage.js';

const ClaudeSessionRuntimeIssueSourceSchema = z.enum([
  'agent_status_error',
  'agent_process_exit',
  'agent_process_exit_after_switch',
  'agent_session_error',
  'usage_limit',
  'auth_error',
  'dependency_failure',
  'stream_error',
  'permission_blocked',
  'unknown',
]);


export const ClaudeSessionRuntimeIssueSchema = z.object({
  v: z.literal(1),
  scope: z.literal('primary_session'),
  status: z.literal('failed'),
  code: z.string().trim().min(1).max(256),
  source: ClaudeSessionRuntimeIssueSourceSchema,
  occurredAt: z.number().int().nonnegative(),
  sessionSeq: z.number().int().nonnegative().optional(),
  agentId: z.string().trim().min(1).max(128).optional(),
  agentTurnId: z.string().trim().min(1).max(256).optional(),
  sanitizedPreview: z.string().trim().min(1).max(2_000).optional(),
  usageLimit: ClaudeSessionRuntimeUsageLimitDetailsSchema.optional(),
  temporaryThrottle: ClaudeSessionRuntimeTemporaryThrottleDetailsSchema.optional(),
  agentProcessExitAfterSwitch: z.object({
    exitCode: z.number().int().nullable(),
    signal: z.string().trim().min(1).max(128).nullable(),
    lastStderrLine: z.string().trim().min(1).max(2_000).nullable(),
    // Claude minted this id: presence-validated, never renormalized.
    vendorResumeId: z.string()
      .refine((value) => value.trim().length > 0, 'Opaque identifiers must contain a non-whitespace character')
      .max(512)
      .nullable(),
    materializationRoot: z.string().trim().min(1).max(2_000).nullable(),
    effectiveStateMode: z.enum(['shared', 'isolated']).nullable(),
  }).strict().optional(),
}).readonly();

export type ClaudeSessionRuntimeIssue = z.infer<typeof ClaudeSessionRuntimeIssueSchema>;
export type ClaudeSessionRuntimeIssueSource = ClaudeSessionRuntimeIssue['source'];
export type ClaudeSessionRuntimeTemporaryThrottleDetails = NonNullable<
  ClaudeSessionRuntimeIssue['temporaryThrottle']
>;
export type ClaudeSessionRuntimeUsageLimitDetails = NonNullable<
  ClaudeSessionRuntimeIssue['usageLimit']
>;

export type ClaudeSessionRuntimeIssueInput = Readonly<{
  code: string;
  source: ClaudeSessionRuntimeIssueSource;
  occurredAt: number;
  sessionSeq?: number | null;
  agentId?: string | null;
  agentTurnId?: string | null;
  sanitizedPreview?: string | null;
  usageLimit?: ClaudeSessionRuntimeUsageLimitDetails | null;
  temporaryThrottle?: ClaudeSessionRuntimeTemporaryThrottleDetails | null;
  agentProcessExitAfterSwitch?: ClaudeSessionRuntimeIssue['agentProcessExitAfterSwitch'] | null;
}>;

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

function normalizeBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function buildClaudeSessionRuntimeIssue(
  input: ClaudeSessionRuntimeIssueInput,
): ClaudeSessionRuntimeIssue {
  const code = normalizeBoundedString(input.code, 256) ?? input.source;
  const occurredAt = normalizeNonNegativeInteger(input.occurredAt) ?? Date.now();
  const sessionSeq = normalizeNonNegativeInteger(input.sessionSeq);
  const agentId = normalizeBoundedString(input.agentId, 128);
  const agentTurnId = normalizeBoundedString(input.agentTurnId, 256);
  const sanitizedPreview = normalizeBoundedString(input.sanitizedPreview, 2_000);

  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code,
    source: input.source,
    occurredAt,
    ...(sessionSeq === null ? {} : { sessionSeq }),
    ...(agentId === null ? {} : { agentId }),
    ...(agentTurnId === null ? {} : { agentTurnId }),
    ...(sanitizedPreview === null ? {} : { sanitizedPreview }),
    ...(input.usageLimit ? { usageLimit: input.usageLimit } : {}),
    ...(input.temporaryThrottle ? { temporaryThrottle: input.temporaryThrottle } : {}),
    ...(input.agentProcessExitAfterSwitch
      ? { agentProcessExitAfterSwitch: input.agentProcessExitAfterSwitch }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectEvidenceParts(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceParts(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of [
    'type',
    'code',
    'kind',
    'error',
    'message',
    'detail',
    'description',
    'text',
    'content',
    'last_assistant_message',
    'lastAssistantMessage',
  ]) {
    collectEvidenceParts(value[key], output);
  }
}

function readPreview(value: unknown, fallback?: string | null): string | undefined {
  const parts: string[] = [];
  collectEvidenceParts(value, parts);
  const preview = parts.join(' ').replace(/\s+/gu, ' ').trim() || fallback?.trim() || '';
  return preview ? preview.slice(0, 2_000) : undefined;
}

function buildClaudeIssue(
  issue: ClaudeSessionRuntimeIssueInput,
  evidence: unknown,
  fallbackMessage?: string | null,
): ClaudeSessionRuntimeIssue {
  return buildClaudeSessionRuntimeIssue({
    ...issue,
    sanitizedPreview: readPreview(evidence, fallbackMessage),
  });
}

export function mapClaudeProviderFailureToUsageDetails(
  evidence: unknown,
): ClaudeSessionRuntimeUsageLimitDetails | null {
  const usage = mapProviderFailure(evidence);
  return usage ? { ...usage, limitCategory: usage.limitCategory ?? 'rate_limit' } : null;
}

export function buildClaudeRuntimeIssue(params: Readonly<{
  evidence: unknown;
  occurredAt: number;
  fallbackMessage?: string | null;
}>): ClaudeSessionRuntimeIssue {
  const usageLimit = mapClaudeProviderFailureToUsageDetails(params.evidence);
  if (usageLimit?.limitCategory === 'capacity') {
    return buildClaudeIssue({
      code: 'claude.provider.capacity',
      source: 'agent_status_error',
      occurredAt: params.occurredAt,
      agentId: 'claude',
      usageLimit,
    }, params.evidence, params.fallbackMessage);
  }
  if (usageLimit) {
    return buildClaudeIssue({
      code: 'claude.usage_limit',
      source: 'usage_limit',
      occurredAt: params.occurredAt,
      agentId: 'claude',
      usageLimit,
    }, params.evidence, params.fallbackMessage);
  }
  return buildClaudeIssue({
    code: 'claude.provider.failure',
    source: 'agent_session_error',
    occurredAt: params.occurredAt,
    agentId: 'claude',
  }, params.evidence, params.fallbackMessage);
}

export function buildClaudeProcessExitRuntimeIssue(params: Readonly<{
  occurredAt: number;
  exitCode: number | null;
  signal: string | null;
  turnWasInFlight: boolean;
}>): ClaudeSessionRuntimeIssue {
  const exitCode = params.exitCode === null ? '' : ` code ${params.exitCode}`;
  const signal = params.signal ? ` signal ${params.signal}` : '';
  const fallbackMessage = params.turnWasInFlight
    ? `Claude unified terminal process exited while a turn was in flight${exitCode}${signal}`
    : `Claude unified terminal process exited while the session was idle${exitCode}${signal}`;
  return buildClaudeIssue({
    code: 'claude.process_exited',
    source: 'agent_process_exit',
    occurredAt: params.occurredAt,
    agentId: 'claude',
  }, {
    message: fallbackMessage,
    exitCode: params.exitCode,
    signal: params.signal,
  }, fallbackMessage);
}
