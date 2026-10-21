import { z } from 'zod/mini';
import { getUsageQueryKey, normalizeUsageQuery, type UsageQuery } from '../../inputs/usageQuery.js';
import { PublicProfilePolicyV1Schema, type PublicProfilePolicyV1,
  type PublicProfileMetadataV1, PublicProfileLinkV1Schema } from '../../account/publicProfile.js';
import { PublicProfileOwnerReadV1Schema, PublicProfilePreparedRequestV1Schema, PublicProfileMutationResultV1Schema,
  type PublicProfileOwnerReadV1, type PublicProfilePreparedRequestV1, type PublicProfileOwnerRecordV1 } from '../../account/publicProfilePublication.js';
import { PublicProfilePreviewIntentV1Schema, PublicProfilePublishIntentV1Schema, PublicProfileUpdateIntentV1Schema,
  type PublicProfileMetadataSelectionV1 } from '../../account/publicProfileIntents.js';
import { type PublicProfilePreparationActionIdV1 } from '../../account/publicProfileActionIds.js';
import { projectPublicProfilePreview } from '../../account/projectPublicProfile.js';
import { ScmCredentialFreeRepositorySelectorV1Schema, type ScmHostingRepositoryGetResponseV1 } from '../../scm/repositoryClone.js';
import { UsageQueryBatchResultSchema, type UsageQueryResultSlice } from '../../usage/resolveUsagePageAggregation.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '../actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import type { UsageActionPorts } from './usageActions.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import type { PublicProfileSnapshotBuildResult } from '../../account/publicProfileSnapshot.js';
export type { PublicProfileSnapshotBuildResult } from '../../account/publicProfileSnapshot.js';

type ProjectSelection = z.infer<typeof ScmCredentialFreeRepositorySelectorV1Schema>;

/** Hosts bind custody and real IO only. Snapshot computation remains a shared domain owner. */
export type PublicProfileActionPorts = Readonly<{
  assertCurrent(context: ActionExecutorContext): void | Promise<void>;
  read(context: ActionExecutorContext): Promise<PublicProfileOwnerReadV1 | ActionExecuteFailure>;
  dispatchPrepared(request: PublicProfilePreparedRequestV1, context: ActionExecutorContext): Promise<unknown>;
  usage?: UsageActionPorts;
  /** Only key-holding hosts bind the canonical public snapshot computation. */
  buildSnapshot?(input: Readonly<{ queryResult: UsageQueryResultSlice; policy: PublicProfilePolicyV1; nowMs: number }>): PublicProfileSnapshotBuildResult;
  getRepository?(selector: ProjectSelection, context: ActionExecutorContext): Promise<ScmHostingRepositoryGetResponseV1 | ActionExecuteFailure>;
}>;

/** Both key-holding hosts bind the incumbent captured Account HTTP port here. */
export function bindPublicProfileActionPorts(input: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  assertCurrent: PublicProfileActionPorts['assertCurrent'];
  usage?: UsageActionPorts;
  getRepository?: PublicProfileActionPorts['getRepository'];
  buildSnapshot?: PublicProfileActionPorts['buildSnapshot'];
}>): PublicProfileActionPorts {
  return {
    assertCurrent: input.assertCurrent, usage: input.usage, getRepository: input.getRepository, buildSnapshot: input.buildSnapshot,
    read: async context => {
      const raw = await input.homeDomainAction({ actionId: 'account.public_profile.get', input: {}, context,
        ...(context.signal ? { signal: context.signal } : {}) });
      const refused = readActionFailureEnvelope(raw);
      if (refused) return refused;
      const parsed = PublicProfileOwnerReadV1Schema.safeParse(raw);
      return parsed.success ? parsed.data : failure('invalid_action_output');
    },
    dispatchPrepared: (request, context) => input.homeDomainAction({
      actionId: `account.public_profile.${request.operation}`, input: {}, preparedRequest: request, context,
      ...(context.signal ? { signal: context.signal } : {}),
    }),
  };
}

export type PreparedPublicProfileAction = Readonly<{
  actionId: PublicProfilePreparationActionIdV1;
  request: PublicProfilePreparedRequestV1;
  /** The exact selected effect is retained by the host's existing live approval continuation. */
  requiresRefresh: boolean;
}>;
export type PublicProfileActionPreparation = Readonly<{ kind: 'prepared'; effect: PreparedPublicProfileAction }>
  | Readonly<{ kind: 'settled'; result: ActionExecuteResult }>;

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
/** A captured Account refusal has one typed meaning across both host bindings. */
export class PublicProfileAccountScopeError extends Error {
  readonly code = 'action_account_scope_changed';
  constructor() { super('action_account_scope_changed'); }
}
async function check(ports: PublicProfileActionPorts, context: ActionExecutorContext) {
  context.signal?.throwIfAborted();
  try { await ports.assertCurrent(context); }
  catch (error) {
    context.signal?.throwIfAborted();
    throw new PublicProfileAccountScopeError();
  }
  context.signal?.throwIfAborted();
}

async function resolveMetadata(input: PublicProfileMetadataSelectionV1, policy: PublicProfilePolicyV1,
  ports: PublicProfileActionPorts, context: ActionExecutorContext) {
  const { projectSelections: selected = [], ...disclosure } = input;
  const metadata: PublicProfileMetadataV1 = {
    ...(policy.fields.bio && disclosure.bio !== undefined ? { bio: disclosure.bio } : {}),
    ...(policy.fields.links && disclosure.links !== undefined ? { links: disclosure.links } : {}),
    ...(policy.fields.avatar && disclosure.avatar !== undefined ? { avatar: disclosure.avatar } : {}),
  };
  const projectSelections = policy.fields.projects ? selected : [];
  if (!projectSelections.length) return { metadata, projectSelections };
  if (!ports.getRepository) return null;
  const observed = await Promise.all(projectSelections.map(selector => ports.getRepository!(selector, context)));
  await check(ports, context);
  const projects: NonNullable<PublicProfileMetadataV1['projects']> = [];
  for (const observation of observed) {
    if (!('kind' in observation) || observation.kind !== 'public') return null;
    const link = PublicProfileLinkV1Schema.safeParse(observation.repository);
    if (!link.success) return null;
    if (!projects.some(project => project.label === link.data.label && project.url === link.data.url)) projects.push(link.data);
  }
  return { metadata: { ...metadata, projects }, projectSelections };
}

async function recheckProjects(record: PublicProfileOwnerRecordV1, ports: PublicProfileActionPorts, context: ActionExecutorContext) {
  if (!record.policy?.fields.projects || !record.projectSelections.length) return undefined;
  const observed = await Promise.all(record.projectSelections.map(async selector => {
    try { return await ports.getRepository?.(selector, context); }
    catch { return undefined; }
  }));
  await check(ports, context);
  // Refresh can remove consented links; even a newly public or renamed repository
  // cannot add a link that was absent from the acknowledged public edition.
  return (record.metadata?.projects ?? []).filter(link => observed.some(observation => observation
    && 'kind' in observation && observation.kind === 'public' && observation.repository.label === link.label
    && observation.repository.url === link.url));
}

async function snapshot(query: UsageQuery, policy: PublicProfilePolicyV1, ports: PublicProfileActionPorts, context: ActionExecutorContext) {
  if (!ports.usage || !ports.buildSnapshot) return null;
  const queried = await ports.usage.query({ queries: [query] }, { ...context, usageQueryReadiness: 'public_profile' });
  await check(ports, context);
  if (readActionFailureEnvelope(queried)) return null;
  const batch = UsageQueryBatchResultSchema.safeParse(queried);
  const slice = batch.success && batch.data.results.length === 1 ? batch.data.results[0] : undefined;
  if (!slice || getUsageQueryKey(slice.requestedQuery) !== getUsageQueryKey(query)
    || getUsageQueryKey(slice.shownQuery) !== getUsageQueryKey(query)) return null;
  const built = ports.buildSnapshot({ queryResult: slice, policy, nowMs: Date.now() });
  await check(ports, context);
  return built.kind === 'ready' ? built.snapshot : null;
}

/** Public preparation never inherits the ordinary private-history population. */
function publicQuery(query: UsageQuery) {
  return normalizeUsageQuery({ ...query, population: 'public_eligible_personal', includeAccounting: true,
    includeActivity: true, activityResolution: 'both', includeSessionEvidence: true, includeWorkEvidence: true,
    includeQuotaHistory: false, includeTranscriptEvidence: false });
}

/** Intent preparation always precedes approval and generic Home-domain dispatch. */
export async function preparePublicProfileAction(actionId: PublicProfilePreparationActionIdV1, value: unknown,
  ports: PublicProfileActionPorts | undefined, context: ActionExecutorContext): Promise<PublicProfileActionPreparation> {
  const unavailable = (reason: string): PublicProfileActionPreparation => ({ kind: 'settled', result: actionId === 'account.public_profile.preview'
    ? { ok: true, result: { kind: 'unavailable', reason } }
    : { ok: false, errorCode: 'public_profile_preparation_unavailable', error: 'public_profile_preparation_unavailable', details: { reason } },
  });
  if (!ports) return unavailable('preparation_unavailable');
  await check(ports, context);
  const read = await ports.read(context);
  await check(ports, context);
  const refused = readActionFailureEnvelope(read);
  if (refused) return { kind: 'settled', result: refused };
  const parsedRead = PublicProfileOwnerReadV1Schema.safeParse(read);
  if (!parsedRead.success) return unavailable('invalid_stored_content');
  const owner = parsedRead.data;
  const record = owner.kind === 'ready' ? owner.record : null;
  if (record?.restriction) return unavailable('restricted');
  if (actionId === 'account.public_profile.update') {
    const intent = PublicProfileUpdateIntentV1Schema.parse(value);
    if (!record?.policy) return unavailable('not_published');
    const policy = intent.policy ?? record.policy;
    const metadata = intent.metadataSelection ? await resolveMetadata(intent.metadataSelection, policy, ports, context) : undefined;
    if (metadata === null) return unavailable('project_visibility_unavailable');
    await check(ports, context);
    return { kind: 'prepared', effect: { actionId, requiresRefresh: intent.policy !== undefined || intent.query !== undefined,
      request: PublicProfilePreparedRequestV1Schema.parse({ operation: 'update', body: {
        ...(intent.policy ? { policy: intent.policy } : {}), ...(metadata ?? {}),
        ...(intent.query ? { query: publicQuery(intent.query) } : {}),
        ...(intent.layout ? { layout: intent.layout } : {}), ...(intent.appearance ? { appearance: intent.appearance } : {}),
      } }),
    } };
  }
  if (!owner.context.handle) return unavailable('username_required');
  if (!owner.context.service || !owner.context.urls) return unavailable('public_ingress_unconfigured');
  if (actionId === 'account.public_profile.refresh' || actionId === 'account.public_profile.resume') {
    if (!record?.policy || !record.query || record.state !== (actionId === 'account.public_profile.resume' ? 'paused' : 'published')) {
      return unavailable('not_published');
    }
    const query = publicQuery(record.query);
    const built = await snapshot(query, record.policy, ports, context);
    if (!built) return unavailable('usage_unavailable');
    const projectLinks = await recheckProjects(record, ports, context);
    await check(ports, context);
    return { kind: 'prepared', effect: { actionId, requiresRefresh: false,
      request: PublicProfilePreparedRequestV1Schema.parse({ operation: actionId === 'account.public_profile.resume' ? 'resume' : 'refresh',
        body: { query, snapshot: built, ...(projectLinks ? { projectLinks } : {}) } }),
    } };
  }
  const intent = actionId === 'account.public_profile.preview'
    ? PublicProfilePreviewIntentV1Schema.parse(value) : PublicProfilePublishIntentV1Schema.parse(value);
  const policy = PublicProfilePolicyV1Schema.parse(intent.policy);
  const metadata = await resolveMetadata(intent.metadataSelection, policy, ports, context);
  if (!metadata) return unavailable('project_visibility_unavailable');
  const query = publicQuery(intent.query);
  const built = await snapshot(query, policy, ports, context);
  if (!built) return unavailable('usage_unavailable');
  if (actionId === 'account.public_profile.preview') {
    const view = projectPublicProfilePreview({ context: owner.context, policy, metadata: metadata.metadata,
      snapshot: built, layout: intent.layout, appearance: intent.appearance });
    return view ? { kind: 'settled', result: { ok: true, result: { kind: 'ready', view } } } : unavailable('preparation_unavailable');
  }
  await check(ports, context);
  return { kind: 'prepared', effect: { actionId, requiresRefresh: false,
    request: PublicProfilePreparedRequestV1Schema.parse({ operation: 'publish', body: { policy, ...metadata, query,
      snapshot: built, layout: intent.layout, appearance: intent.appearance } }),
  } };
}

/** Dispatch the retained bytes; acknowledgement is never undone by optional child refresh. */
export async function executePublicProfileAction(effect: PreparedPublicProfileAction, ports: PublicProfileActionPorts,
  context: ActionExecutorContext, refresh: () => Promise<ActionExecuteResult>): Promise<ActionExecuteResult> {
  await check(ports, context);
  const raw = await ports.dispatchPrepared(effect.request, context);
  const refused = readActionFailureEnvelope(raw);
  if (refused) return refused;
  const result = PublicProfileMutationResultV1Schema.safeParse(raw);
  if (!result.success) return failure('invalid_action_output');
  if (effect.request.operation !== 'update' || result.data.kind !== 'updated') return { ok: true, result: result.data };
  const acknowledged = { ...result.data, refresh: 'not_needed' as const };
  if (!effect.requiresRefresh) return { ok: true, result: acknowledged };
  try {
    await check(ports, context);
    const followOn = await refresh();
    if (!followOn.ok) return { ok: true, result: { ...acknowledged,
      refresh: followOn.errorCode === 'public_profile_preparation_unavailable' ? 'unavailable' : 'failed', refreshReason: followOn.errorCode } };
    const value = followOn.result;
    if (value && typeof value === 'object' && 'kind' in value && value.kind === 'approval_request_created') {
      return { ok: true, result: { ...acknowledged, refresh: 'pending_approval' } };
    }
    const settled = PublicProfileMutationResultV1Schema.safeParse(value);
    return { ok: true, result: { ...acknowledged, ...(settled.success && settled.data.kind === 'updated'
      ? { record: settled.data.record, refresh: 'complete' } : { refresh: 'unavailable' }) } };
  } catch {
    return { ok: true, result: { ...acknowledged, refresh: 'unavailable', refreshReason: context.signal?.aborted ? 'cancelled' : 'account_unavailable' } };
  }
}
