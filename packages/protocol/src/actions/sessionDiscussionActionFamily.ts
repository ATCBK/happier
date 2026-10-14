import type { z } from 'zod/mini';

import {
  isSessionDiscussionActionIdV1,
  type SessionDiscussionActionIdV1,
} from '../sessions/discussions/actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { bindHomeDomainHttpRequestV1, type HomeDomainHttpRequestV1 } from './homeDomainHttpBinding.js';

/**
 * The Session-discussion family's transport and codec lookup.
 *
 * It lives in the Action layer for the same reason the Home and Session-access
 * families' lookups do: the Action id registry and the feature graph already
 * import each other, and pulling the registry into a domain schema leaf makes
 * that graph evaluate before the leaf finishes. Ids and schemas stay
 * dependency-light; the registry-aware lookup lives here.
 *
 * Every value is read from the registered Action row, which is the single
 * declaration of each intent's transport and codecs. This module holds no path
 * or schema table of its own.
 */
export type { SessionDiscussionActionIdV1 };

export { isSessionDiscussionActionIdV1 };

/** The strict semantic-plaintext input this intent declared on its Action row. */
export function sessionDiscussionActionInputSchemaV1(
  actionId: SessionDiscussionActionIdV1,
): z.ZodMiniType {
  return getActionSpec(actionId).inputSchema;
}

/** The strict opened result this intent declared on its Action row. */
export function sessionDiscussionActionOutputSchemaV1(
  actionId: SessionDiscussionActionIdV1,
): z.ZodMiniType {
  const outputSchema = getActionSpec(actionId).outputSchema;
  if (!outputSchema) {
    // A registered family row without a result schema is a registry defect, not
    // a runtime condition a caller could recover from.
    throw new TypeError(`Session discussion Action declares no result schema: ${actionId}`);
  }
  return outputSchema;
}

/**
 * Binds one discussion intent to the exact HTTP request its row declared.
 *
 * Typed on the family id so a caller cannot bind an Action from another family
 * through this seam, and so the descriptor binder — not a client-side route
 * table — stays the only place that turns an Action id into a request address.
 *
 * The bound request carries no body: discussion content is strict semantic
 * plaintext at the Action boundary and must be sealed through the Session
 * cipher by the executing host before it becomes a storage request.
 */
export function bindSessionDiscussionActionHttpRequestV1(
  actionId: SessionDiscussionActionIdV1,
  input: unknown,
): HomeDomainHttpRequestV1 {
  const spec = getActionSpec(actionId);
  if (!spec.serverTransport) {
    throw new TypeError(`Session discussion Action declares no server transport: ${actionId}`);
  }
  return bindHomeDomainHttpRequestV1({
    transport: spec.serverTransport,
    inputSchema: spec.inputSchema,
    input,
  });
}
