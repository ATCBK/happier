import { buildScmReviewedMarksKey, createScmReviewedMarksRecordPort } from '@happier-dev/protocol/scm/reviewedMarks';
import { buildScmReviewScopeId } from '@happier-dev/protocol/scm/comparisonOccurrences';
import type { ScmComparison, ScmReviewedMarkResponse, ScmReviewedMarksSource } from '@happier-dev/protocol/scm';
import { createCliAccountKvJsonTransport, type CliAccountKvJsonTransportParams } from '@/api/client/accountKvJsonTransport';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

type AccountMarkParams = Omit<CliAccountKvJsonTransportParams, 'key'> & Readonly<({ comparison: ScmComparison; source?: never } | { comparison?: never; source: ScmReviewedMarksSource }) & {
  /** Actual authenticated requester from the host ingress, never Action input. */
  requesterAccountId?: string;
}>;
function port(params: AccountMarkParams) {
  // Account crypto and the token are a pair. A Machine collaborator's identity
  // cannot turn the custodian's pair into that collaborator's personal record.
  if (params.requesterAccountId !== undefined && params.requesterAccountId !== readAccountIdFromToken(params.credentials.token)) {
    throw Object.assign(new Error('Authenticated requester Account material is unavailable'), { code: 'reviewed_marks_unavailable' });
  }
  const scope = params.comparison ? { repositoryRootPath: params.comparison.repository.rootPath, source: params.comparison.source } : params.source;
  const transport = createCliAccountKvJsonTransport({ ...params, key: buildScmReviewedMarksKey(buildScmReviewScopeId(scope)) });
  return createScmReviewedMarksRecordPort(params.comparison ? { comparison: params.comparison, transport } : { source: params.source, transport });
}
async function execute(operation: () => Promise<ScmReviewedMarkResponse>): Promise<ScmReviewedMarkResponse> {
  try { return await operation(); }
  catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code : 'reviewed_marks_unavailable';
    return { success: false, errorCode: code, error: error instanceof Error ? error.message : 'Reviewed marks are unavailable' };
  }
}
/** Called only after Action admission has checked captured or live change membership. */
export function createCliScmReviewedMarkAction(params: AccountMarkParams & Readonly<({ changeRefs: readonly string[]; changeKeys?: never } | { changeRefs?: never; changeKeys: readonly string[] }) & { reviewed: boolean }>): Promise<ScmReviewedMarkResponse> {
  return execute(() => params.changeKeys ? port(params).setReviewedKeys(params.changeKeys, params.reviewed) : port(params).setReviewed(params.changeRefs, params.reviewed));
}
