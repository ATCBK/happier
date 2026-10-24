import {
    projectAgentConnectedAccountPurposeDefaultsToSessionBindings,
    resolveAgentConnectedAccountPurposeDefaults,
} from '@happier-dev/protocol/account/settings/connected-services';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';

/** Resolve the selected Agent's Account defaults as an explicit spawn choice, including native. */
export function resolveAgentConnectedServicesDefaultBindings(
    input: Parameters<typeof resolveAgentConnectedAccountPurposeDefaults>[0],
): ConnectedServiceBindingsV2 {
    return projectAgentConnectedAccountPurposeDefaultsToSessionBindings(
        resolveAgentConnectedAccountPurposeDefaults(input),
    ) ?? { v: 2, bindingsByServiceId: {} };
}
