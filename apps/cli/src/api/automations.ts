import axios from 'axios';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkflowHttpErrorDetailsV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { normalizeWorkflowActionThrownError } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { AutomationDefinitionListRequestSchema, AutomationDefinitionListResponseSchema, AutomationDefinitionDetailSchema, AutomationDefinitionCreateRequestSchema, AutomationDefinitionReconcileRequestSchema, AutomationDeleteResponseSchema, AutomationV3RunMutationResponseSchema, type AutomationV3RunMutationResponse, type AutomationDeleteResponse } from '@happier-dev/protocol/automations/automationApiV3';
import type { AutomationDefinitionListResponse, AutomationDefinitionListRequest, AutomationDefinitionDetail, AutomationDefinitionCreateRequest, AutomationDefinitionReconcileRequest } from '@happier-dev/protocol';

import {
  createAuthenticationHttpStatusError,
  createHttpStatusError,
  isAuthenticationStatus,
} from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';

// The incumbent Automation HTTP owner budget applies to every definition operation.
const AUTOMATION_HTTP_TIMEOUT_MS = 15_000;

function unresolvedMutationReceipt(cause: unknown): never {
  throw Object.assign(new Error('workflow_outcome_unresolved', { cause }), { code: 'workflow_outcome_unresolved' });
}

function parseMutationReceipt<T>(raw: unknown, parse: (raw: unknown) => T): T {
  try { return parse(raw); } catch (cause) { return unresolvedMutationReceipt(cause); }
}

/** All Account Automation transports retain only closed, content-free server refusals. */
function automationHttpError(status: number, body: unknown) {
  const record = body !== null && typeof body === 'object' ? body : {};
  const codeSchema = WorkflowHttpErrorDetailsV1Schema.shape.code;
  const nativeCode = ['code', 'errorCode', 'error'].map(key => codeSchema.safeParse(Reflect.get(record, key)))
    .find(parsed => parsed.success && parsed.data !== undefined);
  const code = nativeCode?.success ? nativeCode.data : undefined;
  if (isAuthenticationStatus(status) && code === undefined) {
    return createAuthenticationHttpStatusError(status, 'Authentication failed while accessing automation');
  }
  const message = `Workflow request failed (HTTP ${status}${code ? `; ${code}` : ''})`;
  // The family already owns these semantic aliases; retain its native input.
  if (code === 'automation_disabled' || code === 'automation_not_found') return createHttpStatusError(status, message, code);
  const semanticFailure = code ? normalizeWorkflowActionThrownError(Object.assign(new Error(message), { code })) : null;
  if (semanticFailure && (semanticFailure.errorCode !== 'storage_unavailable' || code === 'storage_unavailable')) {
    return createHttpStatusError(status, message, semanticFailure.errorCode);
  }
  return Object.assign(createHttpStatusError(status, message, 'workflow_http_error'), {
    details: WorkflowHttpErrorDetailsV1Schema.parse({ status, ...(code ? { code } : {}) }),
  });
}

export async function listAutomationDefinitions(params: Readonly<Partial<AutomationDefinitionListRequest> & {
  token: string;
}>): Promise<AutomationDefinitionListResponse> {
  const query = AutomationDefinitionListRequestSchema.parse({
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    ...(params.workflowDefinitionId === undefined ? {} : { workflowDefinitionId: params.workflowDefinitionId }),
    ...(params.scopeSessionId === undefined ? {} : { scopeSessionId: params.scopeSessionId }),
    ...(params.scope === undefined ? {} : { scope: params.scope }),
  });
  const search = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor) search.set('cursor', query.cursor);
  if (query.workflowDefinitionId) search.set('workflowDefinitionId', query.workflowDefinitionId);
  if (query.scopeSessionId) search.set('scopeSessionId', query.scopeSessionId);
  if (query.scope) search.set('scope', query.scope);
  const response = await axios.get(
    `${resolveServerHttpBaseUrl()}/v3/automations?${search.toString()}`,
    {
      headers: { Authorization: `Bearer ${params.token}` },
      timeout: AUTOMATION_HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    },
  );

  if (response.status < 200 || response.status >= 300) {
    throw automationHttpError(response.status, response.data);
  }
  return AutomationDefinitionListResponseSchema.parse(response.data);
}

/** Admission preserves the explicit Workflow correspondence supplied by the saved Automation owner. */
export async function runAutomationNowReceipt(params: Readonly<{
  token: string;
  automationId: string;
  idempotencyKey?: string | null;
  authorization?: ExternalActionExecutionAuthorizationV1;
  requiresRequesterCustody?: boolean;
  signal?: AbortSignal;
}>): Promise<AutomationV3RunMutationResponse> {
  const path = `/v3/automations/${encodeURIComponent(params.automationId)}/run-now`;
  const root = params.authorization?.binding;
  const requester = params.authorization?.requesterHttpProjection;
  if ((params.requiresRequesterCustody && !root) || root && (root.actionId !== 'workflow.trigger.run_now'
    || (root.automationId !== undefined && root.automationId !== params.automationId)
    || root.idempotencyKey !== (params.idempotencyKey ?? undefined)
    || !requester || requester.accountId !== root.accountId)) {
    throw Object.assign(new Error('credential_scope_denied'), { code: 'credential_scope_denied' });
  }
  const headers = root && requester ? await requester.createRequestHeaders({
    effectActionId: root.actionId, method: 'POST', path, ...(params.signal ? { signal: params.signal } : {}),
  }) : { Authorization: `Bearer ${params.token}`,
    ...(params.idempotencyKey ? { 'Idempotency-Key': params.idempotencyKey } : {}) };
  if (!headers) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
  const response = await axios.post(
    `${requester?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}${path}`,
    undefined,
    {
      // Axios POST otherwise invents a form content type for this bodyless route.
      headers: { ...headers, 'Content-Type': false },
      ...(params.signal ? { signal: params.signal } : {}),
      timeout: AUTOMATION_HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    },
  ).catch((cause: unknown) => {
    throw Object.assign(new Error('workflow_outcome_unresolved', { cause }), { code: 'workflow_outcome_unresolved' });
  });

  if (response.status < 200 || response.status >= 300) {
    if (response.status >= 500) return unresolvedMutationReceipt(automationHttpError(response.status, response.data));
    throw automationHttpError(response.status, response.data);
  }
  try {
    return AutomationV3RunMutationResponseSchema.parse(response.data);
  } catch (cause) {
    throw Object.assign(new Error('workflow_outcome_unresolved', { cause }), { code: 'workflow_outcome_unresolved' });
  }
}

/** Account trigger writes use the current Automation owner, never a daemon-private store. */
async function requestAutomationDefinition(params: Readonly<{
  token: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE'; automationId?: string; body?: unknown;
}>): Promise<unknown | null> {
  const response = await axios.request({
    method: params.method,
    url: `${resolveServerHttpBaseUrl()}/v3/automations${params.automationId ? `/${encodeURIComponent(params.automationId)}` : ''}`,
    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.token}`,
      ...(params.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(params.body === undefined ? {} : { data: params.body }), timeout: AUTOMATION_HTTP_TIMEOUT_MS, validateStatus: () => true,
  }).catch((cause: unknown) => {
    if (params.method === 'GET') throw cause;
    return unresolvedMutationReceipt(cause);
  });
  if (response.status === 404 && params.method === 'GET') return null;
  if (response.status < 200 || response.status >= 300) {
    if (params.method !== 'GET' && response.status >= 500) return unresolvedMutationReceipt(automationHttpError(response.status, response.data));
    throw automationHttpError(response.status, response.data);
  }
  return response.data;
}

export async function getAutomationDefinition(params: Readonly<{ token: string; automationId: string }>): Promise<AutomationDefinitionDetail | null> {
  const raw = await requestAutomationDefinition({ ...params, method: 'GET' });
  return raw === null ? null : AutomationDefinitionDetailSchema.parse(raw);
}
export async function createAutomationDefinition(params: Readonly<{ token: string; input: AutomationDefinitionCreateRequest }>): Promise<AutomationDefinitionDetail> {
  return parseMutationReceipt(await requestAutomationDefinition({ token: params.token,
    method: 'POST', body: AutomationDefinitionCreateRequestSchema.parse(params.input) }), raw => AutomationDefinitionDetailSchema.parse(raw));
}
export async function reconcileAutomationDefinition(params: Readonly<{ token: string; automationId: string; input: AutomationDefinitionReconcileRequest }>): Promise<AutomationDefinitionDetail> {
  return parseMutationReceipt(await requestAutomationDefinition({ token: params.token, automationId: params.automationId,
    method: 'PUT', body: AutomationDefinitionReconcileRequestSchema.parse(params.input) }), raw => AutomationDefinitionDetailSchema.parse(raw));
}
export async function deleteAutomationDefinition(params: Readonly<{ token: string; automationId: string }>): Promise<AutomationDeleteResponse> {
  return parseMutationReceipt(await requestAutomationDefinition({ ...params, method: 'DELETE' }), raw => AutomationDeleteResponseSchema.parse(raw));
}
