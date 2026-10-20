import {
    ScmBlameFileRequestSchema,
    ScmBlameFileResponseSchema,
    type ScmBlameFileRequest,
    type ScmBlameFileResponse,
} from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { runMachineScmRpcWithFallback, type MachineScmCallOptions } from './scm/machineScm';
import { normalizeUiScmFacadeResult } from './scm/scmActionInvocation';

export async function machineScmBlameFile(
    machineId: string,
    request: ScmBlameFileRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBlameFileResponse> {
    const payload = ScmBlameFileRequestSchema.parse(request);
    const response = await runMachineScmRpcWithFallback<ScmBlameFileResponse, ScmBlameFileRequest>(
        machineId, RPC_METHODS.SCM_BLAME_FILE, payload, options,
    );
    // This new read owns its error vocabulary. Only transport/admission failures
    // enter the legacy facade normalizer; stale_file remains an alignment fact.
    const parsed = ScmBlameFileResponseSchema.safeParse(response);
    if (parsed.success) return parsed.data;
    if ('success' in response && response.success) {
        return { success: false, errorCode: 'COMMAND_FAILED', error: 'The blame response could not be validated.' };
    }
    return normalizeUiScmFacadeResult<ScmBlameFileResponse>(response);
}
