import { describe, expect, it } from 'vitest';

import { createWorkflowInvocationIndexFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

import { refreshLoadedAttentionSpan } from './workflowRuns';

function attentionRow(id: string, sequence: string) {
    return createWorkflowInvocationIndexFixture({
        id,
        sequence,
        lifecycle: 'waiting_for_approval',
    });
}

describe('refreshLoadedAttentionSpan', () => {
    it('refetches every loaded page so a settled tail leaves and the cursor reflects truth', async () => {
        const calls: Array<string | undefined> = [];
        const pages = new Map<string | undefined, { invocations: ReturnType<typeof attentionRow>[]; nextCursor: string | null }>([
            [undefined, { invocations: [attentionRow('inv-a', '0'), attentionRow('inv-b', '1')], nextCursor: 'cursor-2' }],
            ['cursor-2', { invocations: [attentionRow('inv-c', '2')], nextCursor: null }],
        ]);
        const details = [...pages.values()].flatMap(page => page.invocations.map(index => ({ index, parentRevision: 7, progress: {
            kind: 'happier.workflow-progress.v1' as const, blockKind: 'step' as const, attempt: index.attempt,
            logicalInvocationRecordId: index.id, invocationPath: { blockId: 'work', scope: [] },
            timing: { startedAt: '2026-10-11T10:00:00.000Z', finishedAt: '2026-10-11T10:02:00.000Z' },
        } })));
        const listPage = async (input: { cursor?: string }) => {
            calls.push(input.cursor);
            const page = pages.get(input.cursor)!;
            return { ...page, parentRevision: 7,
                invocationDetails: details.filter(detail => page.invocations.some(index => index.id === detail.index.id)) };
        };

        // Two pages were loaded; the helper refetches both fresh pages.
        const result = await refreshLoadedAttentionSpan({
            listPage,
            previousPageCount: 2,
        });

        expect(calls).toEqual([undefined, 'cursor-2']);
        expect(result.invocations.map((entry) => entry.id)).toEqual(['inv-a', 'inv-b', 'inv-c']);
        expect(result.nextCursor).toBeNull();
        expect(result).toMatchObject({ invocationDetails: details });
    });

    it('merges an addition inside the span without losing the continuation', async () => {
        const listPage = async (input: { cursor?: string }) => {
            if (input.cursor === undefined) {
                return {
                    invocations: [attentionRow('inv-a', '0'), attentionRow('inv-new', '1')],
                    nextCursor: 'cursor-2',
                    parentRevision: 7,
                };
            }
            return {
                invocations: [attentionRow('inv-b', '2')],
                nextCursor: 'cursor-3',
                parentRevision: 7,
            };
        };

        const result = await refreshLoadedAttentionSpan({
            listPage,
            previousPageCount: 2,
        });

        expect(result.invocations.map((entry) => entry.id)).toEqual(['inv-a', 'inv-new', 'inv-b']);
        expect(result.nextCursor).toBe('cursor-3');
    });
});
