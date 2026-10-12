import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}));
import { TmuxUtilities } from './TmuxUtilities';

describe('tmux root spawn failure', () => {
    it('preserves the OS errno through the existing failed launch result', async () => {
        const child = new EventEmitter();
        vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
        const pending = new TmuxUtilities().spawnInTmux(['agent']);
        child.emit('error', Object.assign(new Error('private tmux path'), { code: 'EMFILE', syscall: 'spawn' }));
        await expect(pending).resolves.toMatchObject({ success: false, creationDisposition: 'not_created',
            spawnFailure: { reason: 'too_many_open_files', errno: 'EMFILE' }, error: expect.stringContaining("can't open more files") });
    });
});
