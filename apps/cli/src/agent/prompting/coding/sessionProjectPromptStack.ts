import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { resolveSessionProjectKey, type SessionProjectPromptStackInput } from '@/workspaces/resolveSessionProjectKey';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';

export type { SessionProjectPromptStackInput } from '@/workspaces/resolveSessionProjectKey';

export async function resolveSessionProjectPromptStack(input: SessionProjectPromptStackInput): Promise<readonly PromptStackEntryV1[]> {
  input.signal?.throwIfAborted();
  const pending = (reason: 'project_association_unavailable' | 'project_source_unavailable'): never => {
    throw Object.assign(new Error(reason), { code: 'preparation_pending', status: 'preparation_pending', reason });
  };
  const serverId = input.serverId ?? configuration.activeServerId;
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  const resolved = await resolveSessionProjectKey(input);
  if (resolved.kind === 'none') return [];
  if (resolved.kind === 'pending') return pending(resolved.reason);
  const workspaceRef = resolved.workspaceRef;
  let shared: readonly PromptStackEntryV1[] = [];
  if (workspaceRef.source) {
    const sourceOwner = createCliProjectSourceActionDeps({
      serverHttpBaseUrl,
      admitAccount: target => target === serverId ? null : { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' },
      resolveRequestHeaders: () => ({ Authorization: `Bearer ${input.credentials.token}` }),
      readArtifact: (ref, options) => withCliPromptLibraryArtifactReader(async reader => {
        const artifact = await reader.readArtifact(ref);
        return artifact ? { artifactId: artifact.id, header: artifact.header } : null;
      }, {
        credentials: input.credentials, serverId, signal: options?.signal ?? input.signal,
      }),
    });
    const source = ProjectSourcesReadOutputV1Schema.safeParse(await sourceOwner.projectSourcesRead!({ serverId, sourceId: workspaceRef.source.sourceId }, { signal: input.signal }));
    input.signal?.throwIfAborted();
    if (!source.success || !source.data.ok) return pending('project_source_unavailable');
    shared = (source.data.source.attachments ?? []).flatMap(attachment => attachment.purpose === 'context' ? [attachment.entry] : []);
  }
  input.signal?.throwIfAborted();
  return (workspaceRef.source ? shared : resolved.promptStack).map(entry => ({ ...entry, ref: { ...entry.ref, serverId: entry.ref.serverId ?? serverId } }));
}
