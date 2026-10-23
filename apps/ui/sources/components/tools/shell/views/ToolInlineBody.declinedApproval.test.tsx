import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    renderWithSessionTranscriptSource as renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

const { ToolInlineBody } = await import('./ToolInlineBody');
const { ToolError } = await import('@/components/tools/shell/presentation/ToolError');

function actionCall(outcome: unknown) {
    const text = JSON.stringify(outcome);
    return {
        id: 'call-1', name: 'mcp__happier__action_execute', state: 'error' as const, createdAt: 1, startedAt: 1, completedAt: 2, description: null,
        input: { actionId: 'mcp.servers.signIn.start', input: {} },
        result: { content: [{ type: 'text', text }], structuredContent: null, text, _mcp: { serverId: 'happier', toolId: 'action_execute' } },
    };
}

function renderBody(tool: ReturnType<typeof actionCall>, declinedApprovalShown: boolean) {
    return renderScreen(
        <ToolInlineBody mode="timeline" tool={tool} normalizedToolName="mcp__happier__action_execute" metadata={null} messages={[]}
            detailLevel="summary" setHeaderActions={() => {}} declinedApprovalShown={declinedApprovalShown} />,
    );
}

describe('ToolInlineBody with a declined approval card at its call', () => {
    afterEach(() => { standardCleanup(); });

    it('leaves the declined outcome to the card instead of drawing the generic failure block', async () => {
        const tool = actionCall({ errorCode: 'approval_rejected', error: 'approval_rejected' });
        expect(await renderBody(tool, true).then((screen) => screen.findAllByType(ToolError))).toHaveLength(0);
        // Without the card the body still states the failure itself.
        expect(await renderBody(tool, false).then((screen) => screen.findAllByType(ToolError)).then((found) => found.length)).toBeGreaterThan(0);
    });

    it('never hides a real execution failure behind the card', async () => {
        const tool = actionCall({ errorCode: 'filesystem_operation_failed', error: 'EISDIR' });
        expect(await renderBody(tool, true).then((screen) => screen.findAllByType(ToolError).length)).toBeGreaterThan(0);
    });
});
