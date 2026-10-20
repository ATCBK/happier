import { readMcpServersFromCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { AccountSettings, McpServersSettingsV1 } from '@happier-dev/protocol';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

export class McpServerCatalogUnavailableError extends Error {
  readonly code = 'mcp_catalog_unavailable';
  constructor(readonly reason: string) {
    super('MCP server catalog is unavailable');
    this.name = 'McpServerCatalogUnavailableError';
  }
}

/** Required MCP preparation uses the daemon's existing Home-recovery policy. */
export function isRetryableMcpServerCatalogUnavailableError(error: unknown): boolean {
  return error instanceof McpServerCatalogUnavailableError
    && (error.reason === 'unreachable' || error.reason === 'database_transaction_conflict_exhausted');
}

/** Runtime admission never falls back to a retained Settings root. */
export function readMcpServersSettingsFromAccountSettings(snapshot: ActiveAccountSettingsSnapshot | null): McpServersSettingsV1 {
  if (!snapshot?.mcpServerCatalog) throw new McpServerCatalogUnavailableError('catalog-unobserved');
  const read = readMcpServersFromCatalogSnapshotV1({ snapshot: snapshot.mcpServerCatalog,
    strictMode: snapshot.settings.mcpServersStrictMode === true });
  if (read.status !== 'ready') throw new McpServerCatalogUnavailableError(read.reason);
  return read.settings;
}

/** Startup may omit optional MCP servers, but never borrow another Account's catalog. */
export function readMcpServersSettingsForStartup(input: Readonly<{
  snapshot: ActiveAccountSettingsSnapshot | null;
  settings?: AccountSettings | null;
}>): Readonly<{ status: 'ready'; settings: McpServersSettingsV1 }>
  | Readonly<{ status: 'unavailable'; error: McpServerCatalogUnavailableError }> {
  try {
    return { status: 'ready', settings: readMcpServersSettingsFromAccountSettings(input.snapshot) };
  } catch (error) {
    if (!(error instanceof McpServerCatalogUnavailableError)
      || (input.snapshot?.settings ?? input.settings)?.mcpServersStrictMode === true
      || ['scope-retired', 'cancelled', 'account-not-found', 'account-inconsistent',
        'account-mode-mismatch', 'encryption-material-unavailable', 'unauthorized'].includes(error.reason)) {
      throw error;
    }
    return { status: 'unavailable', error };
  }
}
