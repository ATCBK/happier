import type { Message } from '@happier-dev/session-core/messages';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import { readToolCallMutationPaths, type ToolCallFileMutation } from '@/scm/refresh/workspaceMutationDetection/extractWorkspaceMutations';
import { isAbsoluteLocalPath, resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';

export type LiveFileWrite = Readonly<{
    toolCallId: string;
    kind: ToolCallFileMutation['kind'];
    startedAt: number;
    sessionId: string;
    region?: Readonly<{ startLine: number; endLine: number }>;
}>;
export type FileWriteDerivationOptions = Readonly<{ workspaceRoot: string | null; sessionId?: string }>;
export type SettledFileWrite = Readonly<{ toolCallId: string; sessionId: string; paths: readonly string[] }>;

function relativePath(path: string, workspaceRoot: string | null): string | null {
    const separated = path.replace(/\\/g, '/');
    const relative = isAbsoluteLocalPath(separated)
        ? workspaceRoot ? resolvePathRelativeToRoot({ path, root: workspaceRoot, preservePathSpelling: true }) : null
        : separated;
    if (relative === null) return null;
    const normalized = relative.replace(/^\.\/+/, '').replace(/\/{2,}/g, '/');
    return isSafeWorkspaceRelativePath(normalized) ? normalized : null;
}

function visitCalls(messages: readonly Message[], visit: (message: Extract<Message, { kind: 'tool-call' }>) => void): void {
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        visit(message);
        visitCalls(message.children, visit);
    }
}

function readSessionId(input: unknown): string {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
    const metadata = (input as Record<string, unknown>)._happier;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
    const sessionId = (metadata as Record<string, unknown>).sessionId;
    return typeof sessionId === 'string' ? sessionId : '';
}

function regionForMutation(mutation: ToolCallFileMutation): LiveFileWrite['region'] {
    if (mutation.region) return mutation.region;
    if (!mutation.unifiedDiff) return undefined;
    const hunks = parseUnifiedDiffHunks(mutation.unifiedDiff);
    if (hunks.length === 0) return undefined;
    let startLine = Infinity;
    let endLine = 1;
    for (const hunk of hunks) {
        startLine = Math.min(startLine, Math.max(1, hunk.newStart));
        endLine = Math.max(endLine, hunk.newStart + Math.max(1, hunk.newLines) - 1);
    }
    return Object.freeze({ startLine, endLine });
}

export function deriveLiveFileWrites(messages: readonly Message[], options: FileWriteDerivationOptions): ReadonlyMap<string, LiveFileWrite> {
    const result = new Map<string, LiveFileWrite>();
    visitCalls(messages, message => {
        if (message.tool.state !== 'running') return;
        const toolCallId = message.tool.id ?? message.id;
        const sessionId = options.sessionId ?? readSessionId(message.tool.input);
        const startedAt = message.tool.startedAt ?? message.tool.createdAt;
        for (const [path, mutation] of readToolCallMutationPaths(message.tool).mutations) {
            const normalized = relativePath(path, options.workspaceRoot);
            if (!normalized || (result.get(normalized)?.startedAt ?? -Infinity) > startedAt) continue;
            const region = regionForMutation(mutation);
            result.set(normalized, Object.freeze({ toolCallId, sessionId, kind: mutation.kind, startedAt, ...(region ? { region } : {}) }));
        }
    });
    return Object.freeze(result);
}

export function deriveSettledFileWrites(messages: readonly Message[], options: FileWriteDerivationOptions = { workspaceRoot: null }): ReadonlyMap<string, SettledFileWrite> {
    const result = new Map<string, SettledFileWrite>();
    visitCalls(messages, message => {
        if (message.tool.state !== 'completed' && message.tool.state !== 'error') return;
        const paths = [...readToolCallMutationPaths(message.tool).paths]
            .map(path => relativePath(path, options.workspaceRoot))
            .filter((path): path is string => path !== null);
        if (paths.length === 0) return;
        const toolCallId = message.tool.id ?? message.id;
        result.set(toolCallId, Object.freeze({ toolCallId, sessionId: options.sessionId ?? readSessionId(message.tool.input), paths: Object.freeze([...new Set(paths)]) }));
    });
    return Object.freeze(result);
}
