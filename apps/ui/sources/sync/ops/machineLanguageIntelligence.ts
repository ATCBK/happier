import { queryCodeIntelligenceFallback, type CodeIntelligenceFallbackInput, type CodeIntelligenceFallbackResult } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import { machineWorkspaceFileSearch } from './machineWorkspaceFileSearch';

export async function machineCodeIntelligenceFallback(
    machineId: string,
    input: CodeIntelligenceFallbackInput,
    options?: Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal }>,
): Promise<CodeIntelligenceFallbackResult> {
    return queryCodeIntelligenceFallback(input, request => machineWorkspaceFileSearch(machineId, request, options));
}
