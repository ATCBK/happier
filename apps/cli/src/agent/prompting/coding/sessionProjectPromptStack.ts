import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { resolveSessionProjectKey, type SessionProjectPromptStackInput, type SessionProjectKeyResolution } from '@/workspaces/resolveSessionProjectKey';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { migrateProjectPromptStackSkillRules, readProjectAccountRows, readProjectAccountRowsObservation,
  type ProjectStackSkillMigrationResult, type ProjectAccountRowsObservation } from '@/workspaces/projectAccountRows';
import { readProjectContextEntriesV1 } from '@happier-dev/protocol/projects/projectContextV1';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';

export type { SessionProjectPromptStackInput } from '@/workspaces/resolveSessionProjectKey';

type SessionProjectPromptStackResult = Readonly<{
  entries: readonly PromptStackEntryV1[]; projectKey: string | null; skillMigration: ProjectStackSkillMigrationResult;
}>;
const projectPending = (reason: 'project_association_unavailable' | 'project_source_unavailable'): never => {
  throw Object.assign(new Error(reason), { code: 'preparation_pending', status: 'preparation_pending', reason });
};

export type SessionProjectPromptStackPreparation = Readonly<{
  resolve(input: Pick<SessionProjectPromptStackInput, 'metadata' | 'machineId' | 'directory'>): Promise<SessionProjectPromptStackResult>;
  assertCurrent(): Promise<void>;
}>;

/** One fresh Project observation for a finite multi-Session preparation, never reused by another request. */
export function createSessionProjectPromptStackPreparation(binding: Readonly<{
  credentials: SessionProjectPromptStackInput['credentials']; serverId: string; signal?: AbortSignal;
}>): SessionProjectPromptStackPreparation {
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  let observation: Promise<ProjectAccountRowsObservation> | undefined;
  const contexts = new Map<string, Promise<SessionProjectPromptStackResult>>();
  const assertCurrent = async () => {
    binding.signal?.throwIfAborted();
    if (observation && !await (await observation).isCurrent()) projectPending('project_association_unavailable');
    binding.signal?.throwIfAborted();
  };
  const readRows: typeof readProjectAccountRows = async input => {
    observation ??= runWithServerHttpBaseUrl(serverHttpBaseUrl, () => readProjectAccountRowsObservation(input));
    const current = await observation;
    await assertCurrent();
    return current.snapshot;
  };
  return { assertCurrent, resolve: async local => {
    binding.signal?.throwIfAborted();
    const input = { ...binding, metadata: local.metadata, machineId: local.machineId, directory: local.directory };
    const resolved = await resolveSessionProjectKey(input, readRows);
    if (resolved.kind === 'none') return { entries: [], projectKey: null, skillMigration: { status: 'ready' } };
    if (resolved.kind === 'pending') return projectPending(resolved.reason);
    // Association remains per Session. Only the selected Project's identical
    // source/context read is shared, not its Session attachments or exclusions.
    const key = JSON.stringify([resolved.projectKey, resolved.workspaceRef.source ?? null]);
    let context = contexts.get(key);
    if (!context) {
      context = readResolvedSessionProjectPromptStack(input, resolved, serverHttpBaseUrl);
      contexts.set(key, context);
    }
    const result = await context;
    await assertCurrent();
    return result;
  } };
}

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

export async function resolveSessionProjectPromptStack(input: SessionProjectPromptStackInput): Promise<SessionProjectPromptStackResult> {
  input.signal?.throwIfAborted();
  const serverHttpBaseUrl = input.operationContext?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const resolved = await resolveSessionProjectKey(input);
  if (resolved.kind === 'none') return { entries: [], projectKey: null, skillMigration: { status: 'ready' } };
  if (resolved.kind === 'pending') return projectPending(resolved.reason);
  return readResolvedSessionProjectPromptStack(input, resolved, serverHttpBaseUrl);
}

async function readResolvedSessionProjectPromptStack(input: SessionProjectPromptStackInput,
  resolved: Extract<SessionProjectKeyResolution, { kind: 'resolved' }>, serverHttpBaseUrl: string): Promise<SessionProjectPromptStackResult> {
  const serverId = input.serverId ?? input.credentials.requesterSessionCredentialScope?.serverId ?? configuration.activeServerId;
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
    if (!source.success || !source.data.ok) return projectPending('project_source_unavailable');
    shared = (source.data.source.attachments ?? []).flatMap(attachment => attachment.purpose === 'context' ? [attachment.entry] : []);
  }
  input.signal?.throwIfAborted();
  const entries = (workspaceRef.source ? shared : resolved.promptStack).map(entry => ({ ...entry,
    ref: { ...entry.ref, serverId: entry.ref.serverId ?? serverId } }));
  const skillMigration = await migrateProjectPromptStackSkillRules({ credentials: input.credentials, serverId, serverHttpBaseUrl,
    projectKey: resolved.projectKey, entries, signal: input.signal, operationContext: input.operationContext });
  return { entries, projectKey: resolved.projectKey, skillMigration };
}
