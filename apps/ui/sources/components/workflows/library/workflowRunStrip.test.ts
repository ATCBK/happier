import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            if (key === 'workflows.destination.strip.label') return `Last ${params?.count} runs: ${params?.parts}`;
            if (key === 'workflows.destination.strip.labelPlain') return `Last ${params?.count} runs`;
            if (key === 'workflows.destination.strip.completed') return `${params?.count} completed`;
            if (key === 'workflows.destination.strip.failed') return `${params?.count} failed`;
            if (key === 'workflows.destination.strip.needsYou') return `${params?.count} need you`;
            if (key === 'workflows.destination.strip.separator') return ', ';
            return key;
        },
    });
});

import { hasWorkingWorkflowLibraryRun, projectWorkflowRunStrip, WORKFLOW_RUN_STRIP_LENGTH } from './workflowRunStrip';

describe('working workflow summaries', () => {
    it.each(['interrupted', 'paused', 'succeeded', 'cancelled'] as const)('does not call a %s Run working', (state) => {
        expect(hasWorkingWorkflowLibraryRun({ recent: [{ runId: 'run', state }] })).toBe(false);
    });

    it('keeps actual work discoverable behind a newer completed Run and leaves unknown summaries quiet', () => {
        expect(hasWorkingWorkflowLibraryRun({ recent: [{ runId: 'newer', state: 'succeeded' }, { runId: 'working', state: 'running' }] })).toBe(true);
        expect(hasWorkingWorkflowLibraryRun(undefined)).toBe(false);
        expect(hasWorkingWorkflowLibraryRun({ recent: [] })).toBe(false);
    });
});

describe('projectWorkflowRunStrip', () => {
    it('draws the most recent runs oldest to newest, holding its width with empty cells', () => {
        const strip = projectWorkflowRunStrip({
            recent: [
                { runId: 'r3', state: 'succeeded' },
                { runId: 'r2', state: 'failed' },
                { runId: 'r1', state: 'succeeded' },
            ],
            needsYouCount: 0,
            needsYouRunId: null,
        });
        expect(strip.cells).toHaveLength(WORKFLOW_RUN_STRIP_LENGTH);
        expect(strip.cells.slice(-3).map((cell) => cell.kind)).toEqual(['ok', 'failed', 'ok']);
        expect(strip.cells.slice(0, WORKFLOW_RUN_STRIP_LENGTH - 3).every((cell) => cell.kind === 'none')).toBe(true);
    });

    it('marks the run that needs you and says what the strip shows, omitting zero parts', () => {
        const strip = projectWorkflowRunStrip({
            recent: [
                { runId: 'r3', state: 'running' },
                { runId: 'r2', state: 'failed' },
                { runId: 'r1', state: 'succeeded' },
            ],
            needsYouCount: 1,
            needsYouRunId: 'r3',
        });
        expect(strip.cells.at(-1)?.kind).toBe('needsYou');
        expect(strip.accessibilityLabel).toBe('Last 3 runs: 1 completed, 1 failed, 1 need you');
    });

    it('keeps healthy runs neutral, including a stop you chose', () => {
        const strip = projectWorkflowRunStrip({
            recent: [{ runId: 'r2', state: 'cancelled' }, { runId: 'r1', state: 'running' }],
            needsYouCount: 0,
            needsYouRunId: null,
        });
        expect(strip.cells.slice(-2).map((cell) => cell.kind)).toEqual(['ok', 'ok']);
        expect(strip.accessibilityLabel).toBe('Last 2 runs');
    });
});
