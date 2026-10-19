import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { resolveSessionProjectKey, type SessionProjectPromptStackInput } from '@/workspaces/resolveSessionProjectKey';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { migrateProjectPromptStackSkillRules, readProjectAccountRows, type ProjectStackSkillMigrationResult } from '@/workspaces/projectAccountRows';
import { readProjectContextEntriesV1 } from '@happier-dev/protocol/projects/projectContextV1';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';

export type { SessionProjectPromptStackInput } from '@/workspaces/resolveSessionProjectKey';

/** Read a named Project without Session inference or preparation-time mutations. */
export async function readCliProjectPromptStackContext(input: Readonly<{
  credentials: SessionProjectPromptStackInput['credentials']; projectRef: QualifiedProjectKeyV1; signal?: AbortSignal;
}>): ReturnType<typeof readProjectContextEntriesV1> {
  const { credentials, projectRef, signal } = input;
  const sourceOwner = createCliProjectSourceActionDeps({ serverHttpBaseUrl: resolveServerHttpBaseUrl(),
    admitAccount: async target => await isServerProfileHomeIdentity(projectRef.serverId, target)
      ? null : { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' },
    resolveRequestHeaders: () => ({ Authorization: `Bearer ${credentials.token}` }),
    readArtifact: (ref, options) => withCliPromptLibraryArtifactReader(async reader => {
      const artifact = await reader.readArtifact(ref);
      return artifact ? { artifactId: artifact.id, header: artifact.header } : null;
    }, { credentials, serverId: projectRef.serverId, signal: options?.signal ?? signal }),
  });
  return readProjectContextEntriesV1({
    readRows: () => readProjectAccountRows({ credentials, serverId: projectRef.serverId, signal }),
    readSource: request => sourceOwner.projectSourcesRead!(request, { signal }),
  }, projectRef);
}

export async function resolveSessionProjectPromptStack(input: SessionProjectPromptStackInput): Promise<Readonly<{
  entries: readonly PromptStackEntryV1[]; projectKey: string | null; skillMigration: ProjectStackSkillMigrationResult;
}>> {
  input.signal?.throwIfAborted();
  const pending = (reason: 'project_association_unavailable' | 'project_source_unavailable'): never => {
    throw Object.assign(new Error(reason), { code: 'preparation_pending', status: 'preparation_pending', reason });
  };
  const serverId = input.serverId ?? input.credentials.requesterSessionCredentialScope?.serverId ?? configuration.activeServerId;
  const serverHttpBaseUrl = input.operationContext?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const resolved = await resolveSessionProjectKey(input);
  if (resolved.kind === 'none') return { entries: [], projectKey: null, skillMigration: { status: 'ready' } };
  if (resolved.kind === 'pending') return pending(resolved.reason);
  const workspaceRef = resolved.workspaceRef;
  let shared: readonly PromptStackEntryV1[] = [];
  if (workspaceRef.source) {
    const sourceOwner = createCliProjectSourceActionDeps({
      serverHttpBaseUrl,
      admitAccount: async target => await isServerProfileHomeIdentity(serverId, target)
        ? null : { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' },
      resolveRequestHeaders: () => ({ Authorization: `Bearer ${input.credentials.token}` }),
      readArtifact: (ref, options) => withCliPromptLibraryArtifactReader(async reader => {
        const artifact = await reader.readArtifact(ref);
        return artifact ? { artifactId: artifact.id, header: artifact.header } : null;
      }, {
        credentials: input.credentials, serverId, signal: options?.signal ?? input.signal,
        operationContext: input.operationContext,
      }),
    });
    const source = ProjectSourcesReadOutputV1Schema.safeParse(await sourceOwner.projectSourcesRead!({ serverId, sourceId: workspaceRef.source.sourceId }, { signal: input.signal }));
    input.signal?.throwIfAborted();
    if (!source.success || !source.data.ok) return pending('project_source_unavailable');
    shared = (source.data.source.attachments ?? []).flatMap(attachment => attachment.purpose === 'context' ? [attachment.entry] : []);
  }
  input.signal?.throwIfAborted();
  const entries = (workspaceRef.source ? shared : resolved.promptStack).map(entry => ({ ...entry,
    ref: { ...entry.ref, serverId: entry.ref.serverId ?? serverId } }));
  const skillMigration = await migrateProjectPromptStackSkillRules({ credentials: input.credentials, serverId, serverHttpBaseUrl,
    projectKey: resolved.projectKey, entries, signal: input.signal, operationContext: input.operationContext });
  return { entries, projectKey: resolved.projectKey, skillMigration };
}
