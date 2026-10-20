import type { ScmBlameFileResponse } from '@happier-dev/protocol/scm';
import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { attributeUncommittedLines, type FileLineAttributionTurn } from './attributeFileLines';

export type FileBlameCommit = Extract<ScmBlameFileResponse, { success: true }>['commits'][number];
export type FileBlameTurn = Readonly<{
    turnId: string;
    sessionId: string;
    label: string;
    agentLabel: string;
    sessionTitle: string;
    writtenAtMs: number;
    requester: Readonly<{ actor: TranscriptAccountActor; name: string }> | null;
}>;
export type FileBlameRun = Readonly<{
    id: string;
    startLine: number;
    lineCount: number;
    label: string;
    ageMs?: number;
} & (
    | { kind: 'commit'; commit: FileBlameCommit; turn?: never }
    | { kind: 'session'; turn: FileBlameTurn; commit?: never }
    | { kind: 'uncommitted'; commit?: never; turn?: never }
)>;

export function deriveFileBlameRuns(params: Readonly<{
    response: ScmBlameFileResponse;
    text: string;
    turns: readonly (FileLineAttributionTurn & { presentation: FileBlameTurn })[];
    uncommittedLabel: string;
    nowMs: number;
}>): readonly FileBlameRun[] {
    if (!params.response.success) return [];
    const lines = params.text === '' ? [] : params.text.split('\n');
    if (params.text.endsWith('\n')) lines.pop();
    const ranges = params.response.ranges;
    const uncommittedLines: number[] = [];
    for (const range of ranges) {
        if (range.commitIndex !== null) continue;
        for (let line = range.startLine; line < range.startLine + range.lineCount && line <= lines.length; line++) {
            uncommittedLines.push(line);
        }
    }
    const owners = attributeUncommittedLines({ uncommittedLines, currentLines: lines, turns: params.turns });
    const turns = new Map(params.turns.map((turn) => [turn.turnId, turn.presentation]));
    const runs: FileBlameRun[] = [];
    const append = (run: FileBlameRun) => {
        const previous = runs.at(-1);
        const sameOwner = previous?.kind === run.kind && (
            run.kind === 'uncommitted'
            || (run.kind === 'commit' && previous.kind === 'commit' && previous.commit.sha === run.commit.sha)
            || (run.kind === 'session' && previous.kind === 'session' && previous.turn.turnId === run.turn.turnId)
        );
        if (previous && sameOwner && previous.startLine + previous.lineCount === run.startLine) {
            runs[runs.length - 1] = { ...previous, lineCount: previous.lineCount + run.lineCount };
        } else runs.push(run);
    };
    for (const range of ranges) {
        const lineCount = Math.min(range.lineCount, lines.length - range.startLine + 1);
        if (lineCount <= 0) continue;
        const commit = range.commitIndex === null ? null : params.response.commits?.[range.commitIndex];
        if (commit) {
            append({ id: `commit:${commit.sha}:${range.startLine}`, kind: 'commit', startLine: range.startLine,
                lineCount, label: commit.authorName, ageMs: Math.max(0, params.nowMs - commit.authoredAtMs), commit });
            continue;
        }
        for (let line = range.startLine; line < range.startLine + lineCount; line++) {
            const owner = range.commitIndex === null ? owners.get(line) : null;
            const turn = owner ? turns.get(owner.turnId) : null;
            if (turn) {
                const label = `${turn.agentLabel} · ${turn.label}${turn.requester ? ` · ${turn.requester.name}` : ''}`;
                append({ id: `session:${turn.turnId}:${line}`, kind: 'session', startLine: line, lineCount: 1,
                    label, ageMs: Math.max(0, params.nowMs - turn.writtenAtMs), turn });
            } else {
                append({ id: `uncommitted:${line}`, kind: 'uncommitted', startLine: line, lineCount: 1, label: params.uncommittedLabel });
            }
        }
    }
    return runs;
}

export type FileBlameSession = Readonly<{
    address: import('@/sync/domains/session/sessionAddress').SessionAddress;
    agentLabel: string;
    title: string;
    /** Pass the exact result of useSessionMessageAuthorshipScope for this Session. */
    authorship: Readonly<{
        viewerScope: ServerAccountScope | null;
        hasOtherNamedCollaborator: boolean;
    }>;
}>;
