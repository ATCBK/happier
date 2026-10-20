import { describe, expect, it } from 'vitest';
import type { ToolCallMessage, ToolCall } from '@happier-dev/session-core/messages';
import { createToolCallMessageFixture } from '@/dev/testkit';

import { deriveLiveFileWrites, deriveSettledFileWrites } from './deriveLiveFileWrites';

function call(id: string, name: string, input: unknown, state: ToolCall['state'] = 'running'): ToolCallMessage {
    return createToolCallMessageFixture({ id: `row-${id}`, createdAt: 10, tool: {
        id, name, input, state, createdAt: 10, startedAt: 12, completedAt: state === 'running' ? null : 15, description: null,
    } });
}

const options = { workspaceRoot: '/repo', sessionId: 'session-1' };

describe('deriveLiveFileWrites', () => {
    it('projects canonical Edit, Write, MultiEdit, Patch and rename calls while excluding inspection and shell', () => {
        const writes = deriveLiveFileWrites([
            call('edit', 'Edit', { file_path: '/repo/src/edit.ts', old_string: 'old', new_string: 'new' }),
            call('write', 'Write', { file_path: 'src/write.ts', content: 'new' }),
            call('multi', 'MultiEdit', { file_path: 'src/multi.ts', edits: [{ old_string: 'a', new_string: 'b' }] }),
            call('patch', 'apply_patch', { changes: { 'src/patch.ts': { type: 'modify', old_content: 'a', new_content: 'b' } } }),
            call('acp', 'Patch', { changes: [{ path: 'src/acp.ts', kind: { type: 'update' }, diff: '' }] }),
            call('rename', 'move', { from: 'src/old.ts', to: 'src/new.ts' }),
            call('diff', 'Diff', { files: [{ file_path: 'src/inspection.ts' }] }),
            call('shell', 'Bash', { command: 'touch src/shell.ts' }),
        ], options);
        expect([...writes.keys()]).toEqual(['src/edit.ts', 'src/write.ts', 'src/multi.ts', 'src/patch.ts', 'src/acp.ts', 'src/old.ts', 'src/new.ts']);
        expect(writes.get('src/write.ts')).toEqual({ toolCallId: 'write', kind: 'create', startedAt: 12, sessionId: 'session-1' });
        expect(writes.get('src/new.ts')?.kind).toBe('rename');
        expect(Object.isFrozen(writes)).toBe(true);
    });

    it('drops terminal calls, includes nested writes, rejects outside-root and traversal paths', () => {
        const parent = call('task', 'Task', {});
        parent.children = [call('child', 'Delete', { file_path: 'src/deleted.ts' })];
        const writes = deriveLiveFileWrites([
            parent,
            call('done', 'Write', { path: 'done.ts' }, 'completed'),
            call('error', 'Write', { path: 'error.ts' }, 'error'),
            call('unavailable', 'Write', { path: 'unavailable.ts' }, 'unavailable'),
            call('outside', 'Write', { path: '/repo-other/no.ts' }),
            call('traversal', 'Write', { path: '../no.ts' }),
        ], options);
        expect([...writes.keys()]).toEqual(['src/deleted.ts']);
    });

    it('normalizes Windows paths with root containment and retains explicit input line coordinates', () => {
        const writes = deriveLiveFileWrites([
            call('edit', 'Edit', { file_path: 'C:\\Repo\\src\\One.ts', start_line: 8, end_line: 10 }),
            call('sibling', 'Edit', { file_path: 'C:\\Repo-other\\outside.ts' }),
        ], { workspaceRoot: 'c:/repo', sessionId: 'windows' });
        expect([...writes.keys()]).toEqual(['src/One.ts']);
        expect(writes.get('src/One.ts')?.region).toEqual({ startLine: 8, endLine: 10 });
    });
});

describe('deriveSettledFileWrites', () => {
    it('keeps completed and error path evidence independent of the active-session presence gate', () => {
        const settled = deriveSettledFileWrites([
            call('done', 'Write', { path: 'done.ts' }, 'completed'),
            call('error', 'Delete', { path: 'gone.ts' }, 'error'),
            call('running', 'Edit', { path: 'live.ts' }),
            call('unavailable', 'Write', { path: 'unavailable.ts' }, 'unavailable'),
        ], options);
        expect([...settled].map(([id, write]) => [id, write.paths])).toEqual([
            ['done', ['done.ts']], ['error', ['gone.ts']],
        ]);
    });
});
