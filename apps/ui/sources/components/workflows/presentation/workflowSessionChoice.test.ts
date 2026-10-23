import { describe, expect, it, vi } from 'vitest';

import { resolveWorkflowSessionChoice, workflowSessionMenuState } from './workflowSessionChoice';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('workflowSessionMenuState', () => {
    it('leads a failed read with the situation and offers trying again as its action', () => {
        const state = workflowSessionMenuState(resolveWorkflowSessionChoice('error', false), 'empty');
        expect(state.leadingItems).toHaveLength(1);
        expect(state.leadingItems[0]).toMatchObject({
            title: 'workflows.conversation.sessionsFailed',
            subtitle: 'workflows.conversation.retryLoadingSessions',
        });
    });
});
