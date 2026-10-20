import { PluginError } from '@happier-dev/plugin-sdk';
import type { ManagedServiceErrorCode } from '@happier-dev/plugin-sdk/managed-services';

// SVC09's retained complete-message contract, shared by local access and its
// runner wire producer/reader. This is not a Provider inference policy limit.
export const MAX_MANAGED_SERVICE_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
export const MANAGED_SERVICE_REQUEST_SIZE_ERROR_CODE = 'plugin_managed_service_request_too_large' satisfies ManagedServiceErrorCode;

export function failManagedServiceRequestSize(
    resource: 'body_bytes' | 'header_count' | 'header_value' | 'header_bytes',
    limit: number,
    actual: number,
): never {
    throw new PluginError({
        code: MANAGED_SERVICE_REQUEST_SIZE_ERROR_CODE,
        message: `Managed-service request ${resource} exceeds carrier limit ${limit}`,
        details: { resource, limit, actual },
    });
}

export function assertManagedServiceRequestBodySize(body: Uint8Array | undefined): void {
    if (body !== undefined && body.byteLength > MAX_MANAGED_SERVICE_REQUEST_BODY_BYTES) {
        failManagedServiceRequestSize('body_bytes', MAX_MANAGED_SERVICE_REQUEST_BODY_BYTES, body.byteLength);
    }
}
