import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
    createTestSessionTranscriptSource,
    makeToolCall,
    renderWithSessionTranscriptSource,
    standardCleanup,
} from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';

installToolShellCommonModuleMocks();

describe('host Action confirmation in a transcript tool row', () => {
    afterEach(standardCleanup);

    it.each(['approve', 'reject'] as const)('offers the existing one-shot %s decision through the real tool body', async (decision) => {
        const { ToolInlineBody } = await import('./ToolInlineBody');
        const answers: unknown[] = [];
        const source = createTestSessionTranscriptSource({
            sessionId: 'actionwait-session',
            serverId: 'actionwait-home',
            interaction: { canSendMessages: true, canApprovePermissions: true },
            actions: {
                respondToPermission: async (answer) => { answers.push(answer); },
                answerUserAction: async () => {},
                abort: async () => {},
                submitMessage: async () => {},
            },
        });
        const tool = makeToolCall({
            name: 'Happier Action confirmation',
            state: 'running',
            input: {
                actionId: 'session.terminalComposer.clear',
                preview: { sessionId: source.sessionId },
                sessionId: source.sessionId,
                turnId: 'actionwait-turn',
            },
            permission: {
                id: 'action:actionwait-request',
                kind: 'user_action',
                source: 'happier_action',
                status: 'pending',
                turnId: 'actionwait-turn',
            },
        });
        const screen = await renderWithSessionTranscriptSource(
            <ToolInlineBody mode="timeline" tool={tool} normalizedToolName={tool.name}
                metadata={null} messages={[]} sessionId={source.sessionId} serverId={source.serverId ?? undefined}
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
                detailLevel="full" setHeaderActions={() => {}} />,
            source,
        );

        expect(screen.findByTestId('action-confirmation-prompt-card')).toBeTruthy();
        await screen.pressByTestIdAsync(`action-confirmation-${decision}`);
        expect(answers).toEqual([{
            id: 'action:actionwait-request',
            approved: decision === 'approve',
            decision: decision === 'approve' ? 'approved' : 'denied',
            turnId: 'actionwait-turn',
        }]);
    });
});
