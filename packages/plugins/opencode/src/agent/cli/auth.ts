export type OpenCodeCliAuthProbeResult =
  | Readonly<{
    state: 'logged_in';
    method: 'oauth_cli';
    source: 'command';
    accountLabel: string | null;
  }>
  | Readonly<{
    state: 'logged_out';
    reason: 'missing_credentials' | 'probe_failed';
    method: 'oauth_cli';
    source: 'command' | 'mixed';
    accountLabel: string | null;
  }>;

export function extractOpenCodeCliAuthAccountLabel(stdout: string): string | null {
  const email = stdout.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0]?.trim();
  return email && email.length > 0 ? email : null;
}

export async function detectOpenCodeCliAuthStatus(params: Readonly<{
  runAuthList: () => Promise<Readonly<{ ok: boolean; stdout: string }>>;
}>): Promise<OpenCodeCliAuthProbeResult> {
  const command = await params.runAuthList();
  const accountLabel = extractOpenCodeCliAuthAccountLabel(command.stdout);
  if (!command.ok) {
    return {
      state: 'logged_out',
      reason: 'missing_credentials',
      method: 'oauth_cli',
      source: 'command',
      accountLabel,
    };
  }

  // Native auth list prints its heading even with no stored credentials;
  // environment credentials are reported as a separate inventory.
  const inventoryCounts = Array.from(
    command.stdout.matchAll(/\b(\d+)\s+(?:credentials?|environment variables?)\b/giu),
    (match) => Number(match[1]),
  );
  const emptyInventory = inventoryCounts.length > 0 && inventoryCounts.every((count) => count === 0);
  if (!command.stdout.trim() || emptyInventory) {
    return {
      state: 'logged_out',
      reason: 'missing_credentials',
      method: 'oauth_cli',
      source: 'command',
      accountLabel,
    };
  }

  return {
    state: 'logged_in',
    method: 'oauth_cli',
    source: 'command',
    accountLabel,
  };
}
