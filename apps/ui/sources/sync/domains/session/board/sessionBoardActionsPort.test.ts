import { describe, expect, it, vi } from 'vitest';

import { createSessionBoardActionsPort } from './sessionBoardActionsPort';

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const mutation = {
    v: 1,
    serverId: 'home-a',
    sessionId: 'session-a',
    result: { operation: 'update_layout', layoutRevision: revision, outcome: 'created' },
    destination: null,
} as const;

describe('createSessionBoardActionsPort', () => {
    it('stamps the captured Home and Session on every human Board mutation', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: mutation }));
        const actions = createSessionBoardActionsPort({ serverId: 'home-a', sessionId: 'session-a', execute });

        await expect(actions.updateLayout({
            sessionId: 'session-a',
            expectedLayoutRevision: null,
            operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
        })).resolves.toEqual({ status: 'ok', value: mutation });
        expect(execute).toHaveBeenCalledWith(
            'session.board.layout.update',
            expect.objectContaining({ sessionId: 'session-a' }),
            { serverId: 'home-a', defaultSessionId: 'session-a', surface: 'ui' },
        );
    });

    it('fails closed before dispatch when a caller attempts to retarget the captured Session', async () => {
        const execute = vi.fn();
        const actions = createSessionBoardActionsPort({ serverId: 'home-a', sessionId: 'session-a', execute });
        await expect(actions.removeItem({
            sessionId: 'session-b',
            itemId: 'note',
            expectedItemRevision: revision,
            expectedLayoutRevision: revision,
        })).resolves.toEqual({ status: 'refused', error: { error: 'session_board_forbidden' } });
        expect(execute).not.toHaveBeenCalled();
    });

    it('leaves removal approval to the Action without fabricating a caller confirmation', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: mutation }));
        const actions = createSessionBoardActionsPort({ serverId: 'home-a', sessionId: 'session-a', execute });
        const input = {
            sessionId: 'session-a',
            itemId: 'note',
            expectedItemRevision: revision,
            expectedLayoutRevision: revision,
        };

        await actions.removeItem(input);

        expect(execute).toHaveBeenNthCalledWith(1, 'session.board.item.remove', input, {
            serverId: 'home-a',
            defaultSessionId: 'session-a',
            surface: 'ui',
        });
    });

    it('preserves revision-conflict details and unknown write outcomes', async () => {
        const mutationRequest = {
            operation: 'update_layout' as const,
            expectedLayoutRevision: null,
            layoutContent: {
                t: 'plain' as const,
                v: {
                    v: 1 as const,
                    tabs: [{ id: 'overview', title: 'Overview', items: [] }],
                },
            },
        };
        const recovery = {
            v: 1 as const,
            actionId: 'session.board.layout.update' as const,
            serverId: 'home-a',
            sessionId: 'session-a',
            requestBody: JSON.stringify(mutationRequest),
            mutationRequest,
            intent: { sessionId: 'session-a', expectedLayoutRevision: null, operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' } },
        };
        const execute = vi.fn()
            .mockResolvedValueOnce({ ok: false, errorCode: 'session_board_revision_conflict', error: 'session_board_revision_conflict', details: { currentLayoutRevision: revision } })
            .mockResolvedValueOnce({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown', details: { recovery } });
        const actions = createSessionBoardActionsPort({ serverId: 'home-a', sessionId: 'session-a', execute });
        const input = { sessionId: 'session-a', expectedLayoutRevision: null, operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' } };
        await expect(actions.updateLayout(input)).resolves.toEqual({
            status: 'refused',
            error: { error: 'session_board_revision_conflict', currentLayoutRevision: revision },
        });
        await expect(actions.updateLayout(input)).resolves.toEqual({ status: 'outcome_unknown', recovery });
    });

    it('preserves a deferred approval as pending instead of treating it as applied', async () => {
        const approval = {
            kind: 'approval_request_created' as const,
            artifactId: 'approval-board-1',
            actionId: 'session.board.layout.update',
        };
        const execute = vi.fn(async () => ({ ok: true as const, result: approval }));
        const actions = createSessionBoardActionsPort({ serverId: 'home-a', sessionId: 'session-a', execute });

        await expect(actions.updateLayout({
            sessionId: 'session-a',
            expectedLayoutRevision: null,
            operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
        })).resolves.toEqual({ status: 'pending_approval', approval });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('rejects an otherwise valid applied result from another Home or Session', async () => {
        const execute = vi.fn()
            .mockResolvedValueOnce({ ok: true, result: { ...mutation, serverId: 'home-b' } })
            .mockResolvedValueOnce({ ok: true, result: { ...mutation, sessionId: 'session-b' } });
        const actions = createSessionBoardActionsPort({ serverId: 'home-a', sessionId: 'session-a', execute });
        const input = {
            sessionId: 'session-a',
            expectedLayoutRevision: null,
            operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
        };

        await expect(actions.updateLayout(input)).resolves.toEqual({
            status: 'unavailable',
            reason: 'board_actions_unavailable',
        });
        await expect(actions.updateLayout(input)).resolves.toEqual({
            status: 'unavailable',
            reason: 'board_actions_unavailable',
        });
        expect(execute).toHaveBeenCalledTimes(2);
    });

    it('preserves canonical feature, update, offline, and definite failure classifications', async () => {
        const execute = vi.fn()
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'feature_disabled',
                error: 'feature_disabled',
                details: { operation: 'session.board.layout.update' },
            })
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'update_required',
                error: 'update_required',
                details: {
                    kind: 'update_required',
                    operation: 'session.board.layout.update',
                    component: 'server',
                    reason: 'sessions_board_unsupported',
                },
            })
            .mockResolvedValueOnce({ ok: false, errorCode: 'offline', error: 'offline' })
            .mockResolvedValueOnce({ ok: false, errorCode: 'server_error', error: 'server_error' })
            .mockResolvedValueOnce({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' })
            .mockResolvedValueOnce({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
        const actions = createSessionBoardActionsPort({ serverId: 'home-a', sessionId: 'session-a', execute });
        const input = {
            sessionId: 'session-a',
            expectedLayoutRevision: null,
            operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
        };

        await expect(actions.updateLayout(input)).resolves.toEqual({ status: 'unavailable', reason: 'board_feature_unavailable' });
        await expect(actions.updateLayout(input)).resolves.toEqual({ status: 'unavailable', reason: 'update_required' });
        await expect(actions.updateLayout(input)).resolves.toEqual({ status: 'unavailable', reason: 'offline' });
        await expect(actions.updateLayout(input)).resolves.toEqual({ status: 'failed', code: 'server_error' });
        await expect(actions.updateLayout(input)).resolves.toEqual({ status: 'failed', code: 'not_authenticated' });
        await expect(actions.updateLayout(input)).resolves.toEqual({ status: 'cancelled' });
    });
});
