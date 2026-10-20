import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

const conflictCode = 'claude_managed_mcp_policy_conflict';

export function readClaudeManagedMcpPolicyFailure(error: unknown) {
    return isPluginError(error) && error.code === conflictCode
        ? { code: conflictCode, retryable: false } as const
        : {};
}

export function createClaudeManagedMcpPolicyConflictError() {
    return new PluginError({ code: conflictCode, retryable: false,
        message: 'Claude organization policy prevents the requested MCP configuration or isolation. Ask your administrator to provide a compatible policy; Happier will not weaken the requested restriction.' });
}

