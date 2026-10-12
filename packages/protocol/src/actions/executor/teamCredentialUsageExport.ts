import type { ActionExecuteResult } from '../actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { TeamCredentialUsageExportInputV1Schema, buildTeamCredentialUsageFileResult } from '../../teams/credentials/usageExportV1.js';
import { TeamCredentialUsageQueryResultV1Schema, mergeTeamCredentialUsagePages } from '../../teams/credentials/usageV1.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';

/** The export parent admits the intent; the existing Home usage read owns every number and audience. */
export async function executeTeamCredentialUsageExport(
  input: unknown,
  read: ActionExecutorDeps['homeDomainAction'],
  context: ActionExecutorContext,
): Promise<ActionExecuteResult> {
  if (!read) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
  const request = TeamCredentialUsageExportInputV1Schema.parse(input);
  const queryPage = async (cursor: string | undefined) => {
    context.signal?.throwIfAborted();
    return await read({ actionId: 'teams.credentials.usage.query', input: { ...request.query,
      ...(cursor ? { cursor } : {}) }, context, ...(context.signal ? { signal: context.signal } : {}) });
  };
  const raw = await queryPage(request.query.cursor);
  if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  const failure = readActionFailureEnvelope(raw);
  if (failure) return failure;
  const parsed = TeamCredentialUsageQueryResultV1Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  let result = parsed.data;
  while (request.query.breakdown && request.breakdownRowCount !== undefined
    && (result.breakdown?.length ?? 0) < request.breakdownRowCount && result.nextCursor !== null) {
    const pageRaw = await queryPage(result.nextCursor);
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const pageFailure = readActionFailureEnvelope(pageRaw);
    if (pageFailure) return pageFailure;
    const page = TeamCredentialUsageQueryResultV1Schema.safeParse(pageRaw);
    if (!page.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    result = mergeTeamCredentialUsagePages(result, page.data);
  }
  const rows = result.breakdown ?? [];
  const selected = request.breakdownRowCount === undefined ? rows : rows.slice(0, request.breakdownRowCount);
  return { ok: true, result: buildTeamCredentialUsageFileResult({ resourceName: request.resourceName,
    result: { ...result, breakdown: selected },
    startMs: request.query.startMs, endMs: request.query.endMs, breakdown: request.query.breakdown ?? null,
    breakdownComplete: request.query.cursor === undefined && result.nextCursor === null && selected.length === rows.length,
    costMode: request.query.costMode }) };
}
