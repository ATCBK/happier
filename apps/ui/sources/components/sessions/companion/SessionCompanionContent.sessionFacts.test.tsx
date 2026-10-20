import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage, useSession } from '@/sync/domains/state/storage';
import type { SessionCompanionController } from './state/useSessionCompanionController';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const runtime = installSessionPaneRuntimeTestHarness();
const { SessionCompanionContent } = await import('./SessionCompanionContent');
const { useSessionCompanionController } = await import('./state/useSessionCompanionController');
const { AGENT_PLAN_COMPANION_ITEM, SESSION_SUMMARY_COMPANION_ITEM } = await import('./state/sessionCompanionPreference');
const { SessionSummaryCard } = await import('./summary/SessionSummaryCard');

let controller: SessionCompanionController;
const openFullSurface = () => {};
const resolvePrimaryHost = () => 'companion' as const;
function RailFacts() {
    const session = useSession('s1', runtime.serverId);
    controller = useSessionCompanionController({ sessionId: 's1', serverId: runtime.serverId, openFullSurface });
    return session ? <SessionCompanionContent session={session} serverId={runtime.serverId}
        controller={controller} boardBinding={null} presentation="rail" resolvePrimaryHost={resolvePrimaryHost} /> : null;
}

describe('Companion rail real Session facts', () => {
    it('renders live status, the oldest permission, context metrics and the current Plan without a Board read', async () => {
        const { todos, latestUsage, ...session } = createSessionFixture({ id: 's1', serverId: runtime.serverId, active: true, activeAt: Date.now(),
            thinking: true, thinkingAt: Date.now(), presence: 'online',
            agentState: { controlledByUser: false, requests: { ask: { tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 1 } } },
            todos: [{ id: 'first', content: 'Read the owner', status: 'completed', priority: 'high' },
                { id: 'second', content: 'Verify the change', status: 'in_progress', priority: 'high' }],
            latestUsage: { inputTokens: 1, outputTokens: 1, cacheCreation: 0, cacheRead: 0, contextSize: 42000,
                timestamp: Date.now(), contextSnapshotStale: false, contextSnapshot: { v: 1, modelId: null,
                    usedTokens: 42000, windowTokens: 100000, totalProcessedTokens: null, baselineTokens: null,
                    isAutoCompactEnabled: null, categories: null, observedAtMs: Date.now(), source: 'provider_turn' } },
        });
        storage.getState().applySessions([session]);
        // Plan and usage are transcript projections; feed their real reducer producer.
        storage.getState().applyMessages('s1', [{
            id: 'companion-facts', localId: null, seq: 1, createdAt: Date.now(), role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id: 'companion-plan', name: 'TodoWrite', input: { todos },
                description: null, uuid: 'companion-plan', parentUUID: null }],
            usage: { input_tokens: latestUsage!.inputTokens, output_tokens: latestUsage!.outputTokens,
                contextSnapshot: latestUsage!.contextSnapshot ?? undefined },
        }]);
        const screen = await renderScreen(<runtime.Wrapper><RailFacts /></runtime.Wrapper>);
        try {
            await act(async () => { controller.show(SESSION_SUMMARY_COMPANION_ITEM); });
            await act(async () => { controller.addItem(AGENT_PLAN_COMPANION_ITEM); });
            await flushHookEffects({ cycles: 10 });
            const summary = screen.findByType(SessionSummaryCard);
            expect(summary.props.model).toMatchObject({ scope: 'exact', needsYou: { request: { requestId: 'ask' } },
                facts: expect.arrayContaining([{ kind: 'context', percent: 42, stale: false, destination: 'usage' }]),
                plan: { doneCount: 1, total: 2, currentStep: 2 } });
            expect(summary.props.model.status).not.toBeNull();
            expect(screen.findByTestId('session-companion-content-summary-ask')).not.toBeNull();
            expect(screen.findByTestId('session-companion-content-plan-step-second')).not.toBeNull();
        } finally { await screen.unmount(); }
    });
});
