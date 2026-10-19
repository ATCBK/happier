import { normalizeSessionTargetV1, type SessionTargetV1, type SessionTargetSelectorV1, type ActionResolvedSessionTargetsV1 } from '../sessionTargetV1.js';
import { parseSessionListQueryActionResultV1 } from '../../sessions/awareness/action.js';
import { FollowRulePreviewResultV1Schema } from '../../sessions/follow/sessionFollowRulePreviewV1.js';
import type { ActionId } from '../actionIds.js';
import type { ActionExecuteFailure } from '../actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps, ActionSessionAddress, ActionSessionReferenceResolution } from './types.js';

function id(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The incumbent qualified-address owner; natural-reference adapters only supply authorized facts. */
export async function resolveActionSessionAddress(
  deps: ActionExecutorDeps,
  input: Readonly<{ sessionId?: unknown; sessionTitle?: unknown }>,
  context: ActionExecutorContext,
  actionId?: ActionId,
  resolveReference = false,
): Promise<ActionSessionReferenceResolution> {
  const sessionId = id(input.sessionId);
  const sessionTitle = id(input.sessionTitle);
  const serverId = id(context.serverId);
  if (sessionId && serverId && !resolveReference) return { kind: 'unique', address: { serverId, sessionId } };
  if (!sessionId && !sessionTitle) return { kind: 'none' };
  if (!deps.resolveSessionReference) return { kind: 'incomplete' };
  return deps.resolveSessionReference({ context, ...(sessionId ? { sessionId } : {}),
    ...(sessionTitle ? { sessionTitle } : {}), ...(actionId ? { actionId } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  });
}

function unavailable(cause: string): ActionExecuteFailure {
  return { ok: false, errorCode: 'session_target_unavailable', error: 'session_target_unavailable', details: { cause } };
}

async function workers(
  deps: ActionExecutorDeps, base: ActionSessionAddress, target: Extract<SessionTargetSelectorV1, { selector: 'workers' }>, context: ActionExecutorContext,
): Promise<readonly ActionSessionAddress[] | ActionExecuteFailure> {
  const targets: ActionSessionAddress[] = [];
  const seenTargets = new Set<string>();
  // Archive retains the manager edge. Both storage partitions belong to the
  // selected subtree; archived targets get their own ordinary operation result.
  for (const storage of ['active', 'archived'] as const) {
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      const raw = await deps.sessionList({ context, serverId: base.serverId,
        query: { v: 1, storage, includeInactive: true, scope: 'all_accessible', attention: 'any',
          audiences: [], tagIds: [], underSessionId: base.sessionId, includeAttention: false,
          ...(cursor ? { cursor } : {}),
        }, ...(context.signal ? { signal: context.signal } : {}),
      });
      const page = parseSessionListQueryActionResultV1(raw);
      if (!page || page.metadataUpgradeRequiredCount || page.botFilterUnavailableCount
        || page.attentionHasNext || page.hasNext === undefined) return unavailable('incomplete_session_corpus');
      for (const row of page.sessions) {
        // Summary rows preserve the canonical manager projection. Awareness rows
        // cannot prove direct membership and are not a substitute for that read.
        if (!('id' in row) || typeof row.id !== 'string') return unavailable('manager_projection_unavailable');
        if (row.id === base.sessionId) continue;
        if (target.recursive !== true) {
          if (!('manager' in row)) return unavailable('manager_projection_unavailable');
          const manager = row.manager;
          if (!manager || typeof manager !== 'object' || !('sessionId' in manager) || manager.sessionId !== base.sessionId) continue;
        }
        if (seenTargets.has(row.id)) continue;
        seenTargets.add(row.id);
        targets.push({ serverId: base.serverId, sessionId: row.id });
      }
      if (!page.hasNext) break;
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) return unavailable('incomplete_session_corpus');
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return targets;
}

async function matching(
  deps: ActionExecutorDeps,
  target: Extract<SessionTargetSelectorV1, { selector: 'matching' }>,
  context: ActionExecutorContext,
  base: ActionSessionAddress | null,
): Promise<readonly ActionSessionAddress[] | ActionExecuteFailure> {
  // Session operands never turn Runs into Session targets.
  if (target.filter.show === 'runs') return [];
  if (!deps.sessionFollowPreview) return unavailable('selector_backing_unavailable');
  // This host port reads the authorized corpus to completion and uses the
  // shared tri-state filter. Its visible preview page is never a target set.
  const preview = FollowRulePreviewResultV1Schema.safeParse(await deps.sessionFollowPreview({
    context, input: { receiver: base ? { kind: 'session', sessionId: base.sessionId } : { kind: 'account' },
      filter: { ...target.filter, show: 'sessions' } },
    ...(context.signal ? { signal: context.signal } : {}),
  }));
  if (!preview.success || preview.data.coverage !== 'complete' || preview.data.continuation
    || preview.data.unavailable.length || preview.data.matchCount !== preview.data.matches.length) {
    return unavailable('incomplete_session_corpus');
  }
  const selected: ActionSessionAddress[] = [];
  const seen = new Set<string>();
  for (const match of preview.data.matches) {
    if (match.source.kind !== 'session') return unavailable('non_session_filter_match');
    const address = { serverId: match.serverId, sessionId: match.source.sessionId };
    const key = JSON.stringify([address.serverId, address.sessionId]);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(address);
  }
  return selected;
}

type SessionTargetsRequest = Readonly<{ actionId: ActionId; declaration: Readonly<{ field: string; cardinality: 'one' | 'many' }>; input: Readonly<Record<string, unknown>>; context: ActionExecutorContext }>;

/** Catalog-owned operand paths; values such as source and CAS identities never supply paths. */
export function readActionSessionTargetField(input: Readonly<Record<string, unknown>>, field: string): unknown {
  let value: unknown = input;
  for (const key of field.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Readonly<Record<string, unknown>>)[key];
  }
  return value;
}

/** Replace only the declared target leaf, preserving its surrounding intent. */
export function replaceActionSessionTargetField(
  input: Readonly<Record<string, unknown>>, field: string, target: SessionTargetV1,
): Readonly<Record<string, unknown>> {
  const separator = field.indexOf('.');
  if (separator < 0) return { ...input, [field]: target };
  const key = field.slice(0, separator);
  const child = input[key];
  if (!child || typeof child !== 'object' || Array.isArray(child)) throw new Error('Session target path is unavailable');
  return { ...input, [key]: replaceActionSessionTargetField(
    child as Readonly<Record<string, unknown>>, field.slice(separator + 1), target,
  ) };
}

async function readActionSessionTargets(
  deps: ActionExecutorDeps,
  args: SessionTargetsRequest,
): Promise<ActionResolvedSessionTargetsV1 | ActionExecuteFailure | null> {
  const { context, declaration, actionId } = args;
  const raw = readActionSessionTargetField(args.input, declaration.field);
  if (raw === undefined) return null; // Existing omitted/current-Session semantics stay with each Action.
  let target;
  try { target = normalizeSessionTargetV1(raw); }
  catch { return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' }; }
  if (typeof target === 'string') return null; // Existing exact-ID result and transport fast path.
  const baseId = target.of ?? id(context.defaultSessionId);
  if (!baseId && (target.selector !== 'matching' || !target.filter.homeServerIds.length)) return unavailable('session_context_unavailable');
  const base = baseId ? await resolveActionSessionAddress(deps, { sessionId: baseId }, context, actionId,
    Boolean(deps.resolveSessionReference) || target.of !== undefined) : null;
  if (base && base.kind !== 'unique') return unavailable(base.kind === 'ambiguous' ? 'session_id_ambiguous' : 'session_context_unavailable');
  let targets: readonly ActionSessionAddress[];
  if (target.selector === 'matching') {
    const selected = await matching(deps, target, context, base?.address ?? null);
    if ('ok' in selected) return selected;
    targets = selected;
  } else if (!base) return unavailable('session_context_unavailable');
  else if (target.selector === 'self') targets = [base.address];
  else if (target.selector === 'manager' || target.selector === 'siblings') {
    if (!deps.readSessionManager) return unavailable('manager_reader_unavailable');
    const relation = await deps.readSessionManager({ address: base.address, context, actionId,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (relation.kind === 'unavailable') return unavailable('manager_reader_unavailable');
    if (!relation.address) targets = [];
    else if (target.selector === 'manager') targets = [relation.address];
    else {
      const siblings = await workers(deps, relation.address, { selector: 'workers' }, context);
      if ('ok' in siblings) return siblings;
      targets = siblings.filter(address => address.serverId !== base.address.serverId || address.sessionId !== base.address.sessionId);
    }
  } else if (target.selector === 'workers') {
    const selected = await workers(deps, base.address, target, context);
    if ('ok' in selected) return selected;
    targets = selected;
  } else return unavailable('selector_backing_unavailable');
  if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  if (declaration.cardinality === 'one' && targets.length !== 1) return {
    ok: false, errorCode: 'session_target_cardinality_mismatch', error: 'session_target_cardinality_mismatch',
    details: { expected: 'one', actualCount: targets.length },
  };
  if (!targets.length) return { ok: false, errorCode: 'session_target_empty', error: 'session_target_empty' };
  return { actionId, field: declaration.field, targets: [...targets],
    selector: declaration.cardinality === 'many' && target.selector !== 'self' && target.selector !== 'manager',
  };
}

/** Resolve once at Action admission. Replay consumes the sealed concrete list, never this enumeration. */
export async function resolveActionSessionTargets(
  deps: ActionExecutorDeps,
  args: SessionTargetsRequest,
): Promise<ActionResolvedSessionTargetsV1 | ActionExecuteFailure | null> {
  try {
    return await readActionSessionTargets(deps, args);
  } catch {
    return args.context.signal?.aborted
      ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
      : unavailable('target_read_failed');
  }
}
