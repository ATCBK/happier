import { getActionSpec } from '../../actions/actionSpecs.js';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '../../actions/externalActionApi.js';
import {
  SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1,
  SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1,
  type SessionReadStateActionIdV1,
  type SessionReadStateActionOutputV1,
} from './actions.js';
import {
  SessionReadStateRouteForbiddenResponseV1Schema,
  SessionReadStateRouteInvalidRequestResponseV1Schema,
  SessionReadStateRouteNotFoundResponseV1Schema,
  SessionReadStateRouteNotTrackedResponseV1Schema,
  SessionReadStateRoutePresentUserRequiredResponseV1Schema,
  SessionReadStateRouteSuccessResponseV1Schema,
  type SessionReadStateActionErrorCodeV1,
} from './api.js';
import type { SessionViewerProjectionV1 } from '../personal/viewer.js';

export type SessionReadStateActionTransportFailureV1 = Readonly<{
  errorCode: SessionReadStateActionErrorCodeV1 | 'credential_scope_denied' | 'present_user_required' | 'unsupported_action' | 'unavailable';
  viewer?: SessionViewerProjectionV1;
}>;

/**
 * The one HTTP-failure-to-Action projection shared by UI and CLI hosts.
 * Unknown or malformed payloads never become caller-controlled Action error
 * codes. A generic 404 means an older Home lacks the route; only the exact
 * incumbent not-found payload means the Session itself is absent.
 */
export function projectSessionReadStateActionTransportFailure(
  status: number,
  payload: unknown,
): SessionReadStateActionTransportFailureV1 {
  const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(status, payload);
  if (scopeDenial) return { errorCode: scopeDenial.errorCode };
  if (status === 400 && SessionReadStateRouteInvalidRequestResponseV1Schema.safeParse(payload).success) {
    return { errorCode: 'invalid_parameters' };
  }
  if (status === 403 && SessionReadStateRouteForbiddenResponseV1Schema.safeParse(payload).success) {
    return { errorCode: 'forbidden' };
  }
  if (status === 403 && SessionReadStateRoutePresentUserRequiredResponseV1Schema.safeParse(payload).success) {
    return { errorCode: 'present_user_required' };
  }
  if (status === 409) {
    const conflict = SessionReadStateRouteNotTrackedResponseV1Schema.safeParse(payload);
    if (conflict.success) {
      return {
        errorCode: 'session_not_tracked',
        ...(conflict.data.viewer ? { viewer: conflict.data.viewer } : {}),
      };
    }
  }
  if (status === 404) {
    return SessionReadStateRouteNotFoundResponseV1Schema.safeParse(payload).success
      ? { errorCode: 'session_not_found' }
      : { errorCode: 'unsupported_action' };
  }
  if (status === 405 || status === 501) return { errorCode: 'unsupported_action' };
  return { errorCode: 'unavailable' };
}

/**
 * Project the catalog's method/path and strict input into the domain HTTP
 * request. Every `:param` named in `serverTransport.path` is lifted out of the
 * parsed input into the URL; only `{ state }` travels as JSON body.
 */
export function resolveSessionReadStateActionRequest(
  actionId: SessionReadStateActionIdV1,
  input: unknown,
): Readonly<{ path: string; method: 'POST'; body: Record<string, unknown> }> {
  const data: Record<string, unknown> = SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
  const transport = getActionSpec(actionId).serverTransport;
  if (!transport || transport.method !== 'POST') throw new Error('Invalid Session read-state Action transport');
  const body = { ...data };
  const path = transport.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, key: string) => {
    const value = data[key];
    if (typeof value !== 'string') throw new Error('Missing Session read-state Action path parameter');
    delete body[key];
    return encodeURIComponent(value);
  });
  return { path, method: 'POST', body };
}

/**
 * Validate the domain route success payload once and project the canonical
 * Action result. The `success` envelope flag is a transport detail. The
 * optional canonical viewer projection is retained so an interactive host can
 * replace its private cached facts without re-deriving attention locally.
 */
export function parseSessionReadStateActionResponse<TActionId extends SessionReadStateActionIdV1>(
  actionId: TActionId,
  input: unknown,
  payload: unknown,
): SessionReadStateActionOutputV1[TActionId] {
  SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
  const route = SessionReadStateRouteSuccessResponseV1Schema.parse(payload);
  const result = {
    state: route.state,
    lastViewedSessionSeq: route.lastViewedSessionSeq,
    didChange: route.didChange,
    ...(route.viewer === undefined ? {} : { viewer: route.viewer }),
  };
  return SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result) as SessionReadStateActionOutputV1[TActionId];
}
