import { isPluginError } from '@happier-dev/plugin-sdk';
import type { ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';
import { PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import { MANAGED_SERVICE_REQUEST_SIZE_ERROR_CODE } from '@/plugins/runtime/invocation/services/managedServiceRequestSize';

/** Preserve the carrier's typed refusal through Provider adapters without
 * repeating its size decision or exposing request/credential material. */
export function readProviderBrokerTransportFailure(error: unknown): ManagedServiceResponse | null {
    if (!isPluginError(error) || error.code !== MANAGED_SERVICE_REQUEST_SIZE_ERROR_CODE) return null;
    return {
        ok: false,
        status: 413,
        statusText: 'Payload Too Large',
        headers: {
            'content-type': 'application/json',
            [PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER]: 'request_too_large',
        },
        body: new Response(JSON.stringify({ type: 'error', error: {
            type: 'invalid_request_error', code: 'request_too_large',
            message: 'Request exceeds the managed-service carrier size limit.',
        } })).body,
    };
}
