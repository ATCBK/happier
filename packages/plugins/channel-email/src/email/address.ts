/** Owner-entered principal ids are single bare SMTP addresses, never address lists. */
export function normalizeEmailAddress(value: string): string | null {
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  const address = value.trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(address)
    && !address.startsWith('.') && !address.includes('..')
    ? address : null;
}
