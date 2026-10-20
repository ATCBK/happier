import { isWorkflowRunExecutorStorageOperationV1 } from '@happier-dev/protocol/workflows/workflowRunStorageV1';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServerFetch } from '@/sync/http/client';
import { getAutomationAuthHeaders, readAutomationJsonOrThrow } from './apiAutomationHttp';

/** Account storage carries opaque content and durable intent, never worker publication. */
export function createWorkflowRunAccountStorage(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    request: ServerFetch;
    assertCurrent: () => void;
}>) {
    return {
        execute: async (operation: Readonly<Record<string, unknown>>, options?: Readonly<{ signal?: AbortSignal; publisherMachineId?: string; onTransportIssued?: () => void }>): Promise<unknown> => {
            params.assertCurrent();
            if (isWorkflowRunExecutorStorageOperationV1(operation.operation)
                || Object.hasOwn(operation, 'publisherMachineId')
                || options?.publisherMachineId !== undefined) {
                throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
            }
            options?.signal?.throwIfAborted();
            const response = await params.request('/v3/automations/runs/workflow-storage', {
                method: 'POST',
                headers: getAutomationAuthHeaders(params.credentials, { includeJsonContentType: true }),
                body: JSON.stringify(operation),
                ...(options?.signal ? { signal: options.signal } : {}),
            }, { includeAuth: false,
                ...(operation.operation === 'delete' && options?.onTransportIssued ? { onIssued: options.onTransportIssued } : {}),
            });
            const result = await readAutomationJsonOrThrow(response);
            params.assertCurrent();
            return result;
        },
    };
}
