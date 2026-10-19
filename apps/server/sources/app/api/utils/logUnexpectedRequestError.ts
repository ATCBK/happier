import { log } from '@/utils/logging/log';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Shared HTTP exception diagnostic: allowlisted class/code and source pointers only. */
export function logUnexpectedRequestError(error: unknown, correlation: Readonly<{
    module: 'external-action-error' | 'fastify-error';
    httpRequestId: string;
    requestId?: string;
    actionId?: string;
    phase?: 'action_request' | 'managed_admission';
}>): void {
    const diagnostic = readUnexpectedActionErrorDiagnosticV1(error);
    const prismaCode = diagnostic.errorCode && /^P\d{4}$/u.test(diagnostic.errorCode) ? diagnostic.errorCode : undefined;
    try {
        log({ ...correlation, level: 'error', ...diagnostic, ...(prismaCode ? { prismaCode } : {}) },
            'Unexpected HTTP request error');
    } catch { /* Diagnostics are best effort and never change the public error. */ }
}
