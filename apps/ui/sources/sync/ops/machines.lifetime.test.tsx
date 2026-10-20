import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createPlainSessionByIdResponseFixture, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { AgentTransitionHandedOverContextModal } = await import('@/components/sessions/transcript/agentTransition/AgentTransitionHandedOverContextModal');
const sessions = await import('./sessions');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('mounted machine request lifetime', () => {
    it('cancels a nonreplying brief on navigation and the next open receives its answer', async () => {
        const reply = createDeferred<void>();
        fixture = await createSessionFilesViewFixture({ rpc: async request => {
            if (request.method !== 'session.agentTransition.briefPreview') return undefined;
            await reply.promise;
            return { type: 'empty', protocolVersion: 1 };
        } });
        const props = { machineId: 'm1', serverId: fixture.home.id, sessionId: 's1', sourceAgentId: 'claude', targetAgentId: 'codex',
            sourceCutoffSeqInclusive: 0, returningAgentLastSeenSeqInclusive: null, onClose: () => {}, onJumpToCutoff: null };
        const first = await renderScreen(React.createElement(AgentTransitionHandedOverContextModal, props));
        try {
            await vi.waitFor(() => expect(fixture.requests.some(request => request.method === 'session.agentTransition.briefPreview')).toBe(true));
            await first.unmount();
            await vi.waitFor(() => expect(fixture.emissions.some(event => event.event === 'rpc-cancel')).toBe(true));
            reply.resolve();
            const next = await renderScreen(React.createElement(AgentTransitionHandedOverContextModal, props));
            try {
                const { t } = await import('@/text');
                await vi.waitFor(() => expect(next.getTextContent()).toContain(t('session.agentContinuation.handedOver.empty')));
            } finally { await next.unmount(); }
        } finally { reply.resolve(); }
    });

    it.each(['permission', 'rollback', 'checkpoint', 'switch', 'switch_retire', 'usage', 'bash', 'log'] as const)(
        'settles a nonreplying %s request when its owner cancels', async (kind) => {
            const reply = createDeferred<void>();
            fixture = await createSessionFilesViewFixture({ rpc: async () => { await reply.promise; return {}; },
                request: async url => new URL(String(url)).pathname === '/v2/sessions/s1'
                    ? Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id: 's1', active: true })))
                    : Response.json({}, { status: 404 }),
            });
            const controller = new AbortController();
            const options = { serverId: fixture.home.id, signal: controller.signal };
            let retire = () => {};
            let current = true;
            const run = () => {
                switch (kind) {
                    case 'permission': return sessions.sessionRespondToPermission('s1', { id: 'p1', approved: false }, options);
                    case 'rollback': return sessions.rollbackSessionConversation({ sessionId: 's1', ...options });
                    case 'checkpoint': return sessions.rollbackSessionCheckpointCode({ request: { v: 1, sessionId: 's1', turnId: 't1', cwd: '/repo',
                        codeMode: 'conversation_and_code_without_stash', backupMode: 'happier_checkpoint_only', expectedStartRef: 'a', expectedFinalRef: 'b' }, ...options });
                    case 'switch': return sessions.sessionSwitch('s1', 'remote', options);
                    case 'switch_retire': return sessions.sessionSwitch('s1', 'remote', { serverId: fixture.home.id,
                        accountLifetime: { scope: { serverId: fixture.home.id, accountId: 'alice' }, isCurrent: () => current,
                            onRetire(cancel) { retire = () => { current = false; cancel(); }; return { dispose() {} }; } } });
                    case 'usage': return import('./sessionUsageLimitRecovery').then(({ sessionUsageLimitCheckNow }) => sessionUsageLimitCheckNow('s1', options));
                    case 'bash': return sessions.sessionBash('s1', { command: 'pwd' }, options);
                    case 'log': return sessions.sessionReadLogTail('s1', options);
                }
            };
            let settled = false;
            const pending = run().catch(() => {}).finally(() => { settled = true; });
            try {
                await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
                if (kind === 'switch_retire') retire();
                else controller.abort();
                await vi.waitFor(() => expect(settled).toBe(true));
                expect(fixture.emissions.some(event => event.event === 'rpc-cancel')).toBe(true);
            } finally { reply.resolve(); await pending; }
        },
    );
});
