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
