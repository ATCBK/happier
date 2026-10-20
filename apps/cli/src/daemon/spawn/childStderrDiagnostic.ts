import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';

const CHILD_STDERR_CAPTURE_MAX_CHARS = 16_384;
const CHILD_STDERR_DIAGNOSTIC_MAX_BYTES = 2_048;

export function appendBoundedStderrTail(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk ?? '')}`;
  return next.length > CHILD_STDERR_CAPTURE_MAX_CHARS
    ? next.slice(-CHILD_STDERR_CAPTURE_MAX_CHARS)
    : next;
}

export function sanitizeChildStderrTail(
  stderrTail: string,
  sanitizeDiagnosticText: (value: string) => string,
): string | null {
  const trimmed = stderrTail.trim();
  if (!trimmed) return null;
  const redacted = redactBugReportSensitiveText(sanitizeDiagnosticText(trimmed));
  return trimBugReportTextToMaxBytes(redacted, CHILD_STDERR_DIAGNOSTIC_MAX_BYTES).trim() || null;
}

export function formatChildExitBeforeWebhookMessage(input: Readonly<{
  pid: number;
  reason?: string;
  code: number | null;
  signal: string | null;
  stderrTail?: string | null;
}>): string {
  const stderrTail = sanitizeChildStderrTail(input.stderrTail ?? '', value => value);
  const message = `Child process exited before session webhook (pid=${input.pid}, code=${input.code ?? 'null'}, signal=${input.signal ?? 'null'}${input.reason ? `, reason=${input.reason}` : ''})`;
  return stderrTail ? `${message}; recent stderr: ${stderrTail}` : message;
}
