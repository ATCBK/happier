import {
  ACTION_ID_FAMILIES_V1,
  type RuntimeActionIdV1,
} from '../actionIds.js';
import type { RuntimeActionDispatchArgs } from './types.js';
import { DaemonLocalServicePublicPreviewCreateRequestV1Schema } from '../../local/services/public/v1.js';
import { createLocalServiceActionConfirmationNonceV1 } from '../../local/services/actions/v1.js';
import { readLocalServiceControlActionRequest } from '../specs/localServices.js';

export const LOCAL_SERVICES_RUNTIME_ACTION_IDS = [
  ...ACTION_ID_FAMILIES_V1.local_services_inventory,
  ...ACTION_ID_FAMILIES_V1.local_services_launcher,
  ...ACTION_ID_FAMILIES_V1.local_services_preview,
  ...ACTION_ID_FAMILIES_V1.local_services_public_preview,
  ...ACTION_ID_FAMILIES_V1.local_services_actions,
] as const satisfies readonly RuntimeActionIdV1[];

export type LocalServicesRuntimeActionId = (typeof LOCAL_SERVICES_RUNTIME_ACTION_IDS)[number];

const LOCAL_SERVICES_RUNTIME_ACTION_ID_SET: ReadonlySet<RuntimeActionIdV1> = new Set(
  LOCAL_SERVICES_RUNTIME_ACTION_IDS,
);

export function isLocalServicesRuntimeActionId(actionId: RuntimeActionIdV1): actionId is LocalServicesRuntimeActionId {
  return LOCAL_SERVICES_RUNTIME_ACTION_ID_SET.has(actionId);
}

export async function executeLocalServicesRuntimeAction(args: RuntimeActionDispatchArgs<LocalServicesRuntimeActionId>): Promise<unknown> {
  // This family runs only after the canonical Action approval decision. The
  // downstream raw transports retain their acknowledgement/binding format;
  // neither format is a second human-approval requirement on an admitted Action.
  let input = args.input;
  if (args.actionId === 'localServices.publicPreview.create') {
    const request = DaemonLocalServicePublicPreviewCreateRequestV1Schema.parse(input);
    input = { ...request, confirmation: request.confirmation ?? { acknowledged: true } };
  } else {
    const request = readLocalServiceControlActionRequest(args.actionId, input);
    if (request && !request.confirmationNonce && (request.force || request.action === 'stop_managed'
      || request.action === 'restart_managed' || request.action === 'terminate_detected')) {
      input = { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) };
    }
  }
  return args.runtimeActionExecute({
    actionId: args.actionId,
    input,
    context: args.context,
    ...(args.executeCanonicalAction ? { executeCanonicalAction: args.executeCanonicalAction } : {}),
  });
}
