import { createRoleSourceReaderV1, type RoleSourceReaderV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import type { PluginRoleContributionV1 } from '@happier-dev/protocol';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { logger } from '@/ui/logger';

export type RoleSourceReaderParams = Readonly<{
  artifactStore?: Pick<ReturnType<typeof createAccountArtifactStore>, 'read' | 'list'>;
  readPluginRoles?: () => readonly PluginRoleContributionV1[];
  accountId?: string;
  readRawAccountSettings?: () => Promise<Readonly<Record<string, unknown>>>;
}>;
export type RoleSourceReader = RoleSourceReaderV1;

/** One source reader for Action, prompt and permission role resolution. */
export function createRoleSourceReader(params: RoleSourceReaderParams): RoleSourceReader {
  const readPluginRoles = params.readPluginRoles ?? (async () => {
    const [{ readPluginRoleSources }, { readCurrentContributionRegistry }] = await Promise.all([
      import('@/plugins/projection/registry/roles'),
      import('@/agent/catalog/snapshot'),
    ]);
    return readPluginRoleSources(readCurrentContributionRegistry());
  });
  const read = createRoleSourceReaderV1({ ...params, readPluginRoles,
    ...(params.readRawAccountSettings ? { readRawAccountSettings: async () => {
      const startedAt = performance.now();
      try { return await params.readRawAccountSettings!(); }
      finally { logger.infoFile('[Session] Role source legacy settings timing', { durationMs: Math.round(performance.now() - startedAt) }); }
    } } : {}),
  });
  const pending = new Map<AbortSignal | undefined, ReturnType<RoleSourceReader>>();
  return async (signal, options) => {
    signal?.throwIfAborted();
    // Selected reads are fresh and must never borrow a concurrent full catalog.
    if (options?.roleIds !== undefined) return read(signal, options);
    let current = pending.get(signal);
    if (!current) { current = read(signal); pending.set(signal, current); }
    try { return await current; }
    finally { if (pending.get(signal) === current) pending.delete(signal); }
  };
}
