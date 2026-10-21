import type { Message } from '@happier-dev/session-core/messages';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import { readToolCallMutationPaths, type ToolCallFileMutation } from '@/scm/refresh/workspaceMutationDetection/extractWorkspaceMutations';
import { isAbsoluteLocalPath, normalizeRelativeLocalPath, resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';

export type LiveFileWrite = Readonly<{
    toolCallId: string;
    kind: ToolCallFileMutation['kind'];
    startedAt: number;
    sessionId: string;
    region?: Readonly<{ startLine: number; endLine: number }>;
    /** Without a region: the text the write replaces, for the open file to place (P5 Track caret). */
    anchorText?: string;
}>;
export type FileWriteDerivationOptions = Readonly<{ workspaceRoot: string | null; sessionId?: string }>;
export type SettledFileWrite = Readonly<{ toolCallId: string; sessionId: string; paths: readonly string[] }>;

function relativePath(path: string, workspaceRoot: string | null): string | null {
    const separated = path.replace(/\\/g, '/');
    const relative = isAbsoluteLocalPath(separated)
        ? workspaceRoot ? resolvePathRelativeToRoot({ path, root: workspaceRoot, preservePathSpelling: true }) : null
        : separated;
    if (relative === null) return null;
    const normalized = normalizeRelativeLocalPath(relative);
    return isSafeWorkspaceRelativePath(normalized) ? normalized : null;
}

function visitCalls(messages: readonly Message[], visit: (message: Extract<Message, { kind: 'tool-call' }>) => void, includeSidechains = true): void {
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        visit(message);
        if (includeSidechains) visitCalls(message.children, visit);
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
    // The first hunk of the applied patch is where the write lands (P5 §3.10), not the span to its last hunk.
    const first = parseUnifiedDiffHunks(mutation.unifiedDiff)[0];
    if (!first) return undefined;
    const startLine = Math.max(1, first.newStart);
    return Object.freeze({ startLine, endLine: startLine + Math.max(1, first.newLines) - 1 });
}

/** Session-current writes exclude sidechains; workspace presence also covers nested subagent activity. */
export function deriveLiveFileWrites(messages: readonly Message[], options: FileWriteDerivationOptions & Readonly<{ includeSidechains?: boolean }>): ReadonlyMap<string, LiveFileWrite> {
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
            const anchorText = region ? undefined : mutation.anchorText;
            result.set(normalized, Object.freeze({ toolCallId, sessionId, kind: mutation.kind, startedAt,
                ...(region ? { region } : {}), ...(anchorText ? { anchorText } : {}) }));
        }
    }, options.includeSidechains === true);
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
