import { describe, expect, it } from 'vitest';

import type { Message } from "@happier-dev/session-core/messages";

import {
    deriveSessionSubagentPendingAttentionKinds,
    listSessionSubagentPendingPrompts,
} from './deriveSessionSubagentPendingAttentionKinds';
import type { SessionSubagent } from './types';

const subagent: SessionSubagent = {
    id: 'subagent_sidechain:toolu_alpha',
    kind: 'subagent_sidechain',
    status: 'running',
    display: { title: 'alpha', providerLabel: 'Claude' },
    transcript: { sidechainId: 'toolu_alpha', toolMessageRouteId: 'tool-msg-1', toolId: 'toolu_alpha' },
    recipient: null,
    capabilities: {
        canOpen: true,
        canSend: false,
        canStop: false,
        canLaunchChild: false,
        canDelete: false,
        canOpenAdvancedRun: false,
    },
    timestamps: {},
};

function sidechainState(permissions: readonly Readonly<{
    id: string;
    status: string;
    kind?: string;
}>[], resolved?: ReadonlyMap<string, { status: string }>) {
    return {
        sidechains: new Map([
            ['toolu_alpha', permissions.map((permission) => ({ tool: { permission } }))],
        ]),
        permissions: resolved ?? new Map<string, { status: string }>(),
    };
}

describe('deriveSessionSubagentPendingAttentionKinds', () => {
    it('finds a Run startup question in the parent request table even with a loaded sidechain', () => {
        const requestId = 'execution-run:review-run:occurrence:folder%3Aquestion';
        const run = { ...subagent, kind: 'execution_run' as const, runRef: { runId: 'review-run' } };
        const reducerState = { sidechains: new Map([['toolu_alpha', [{ tool: {} }]]]), permissions: new Map([
            [requestId, { status: 'pending', kind: 'user_action' }],
            ['execution-run:review-run-other:occurrence:question', { status: 'pending', kind: 'permission' }],
            ['execution-run:review-run:occurrence:answered', { status: 'approved', kind: 'permission' }],
        ]) };
        expect(deriveSessionSubagentPendingAttentionKinds({ subagent: run, reducerState })).toEqual(['user_action']);
        expect(listSessionSubagentPendingPrompts({ subagent: run, reducerState })).toEqual([{ id: requestId, kind: 'user_action' }]);
        expect(deriveSessionSubagentPendingAttentionKinds({ subagent, reducerState })).toEqual([]);
        reducerState.permissions.set(requestId, { status: 'approved', kind: 'user_action' });
        expect(listSessionSubagentPendingPrompts({ subagent: run, reducerState })).toEqual([]);
    });

    it('reports permission attention for a pending tool approval', () => {
        expect(deriveSessionSubagentPendingAttentionKinds({
            subagent,
            reducerState: sidechainState([{ id: 'perm-1', status: 'pending', kind: 'permission' }]),
        })).toEqual(['permission']);
    });

    it('reports user_action attention for a pending agent question the predecessor discarded', () => {
        expect(deriveSessionSubagentPendingAttentionKinds({
            subagent,
            reducerState: sidechainState([{ id: 'perm-1', status: 'pending', kind: 'user_action' }]),
        })).toEqual(['user_action']);
    });

    it('reports both kinds once, in canonical order, when both are pending', () => {
        expect(deriveSessionSubagentPendingAttentionKinds({
            subagent,
            reducerState: sidechainState([
                { id: 'perm-2', status: 'pending', kind: 'user_action' },
                { id: 'perm-3', status: 'pending', kind: 'user_action' },
                { id: 'perm-1', status: 'pending', kind: 'permission' },
            ]),
        })).toEqual(['permission', 'user_action']);
    });

    it('drops a kind whose stored decision is no longer pending', () => {
        expect(deriveSessionSubagentPendingAttentionKinds({
            subagent,
            reducerState: sidechainState(
                [
                    { id: 'perm-1', status: 'pending', kind: 'permission' },
                    { id: 'perm-2', status: 'pending', kind: 'user_action' },
                ],
                new Map([['perm-1', { status: 'approved' }]]),
            ),
        })).toEqual(['user_action']);
    });

    it('returns the shared empty value when nothing is waiting on a person', () => {
        const first = deriveSessionSubagentPendingAttentionKinds({
            subagent,
            reducerState: sidechainState([{ id: 'perm-1', status: 'approved', kind: 'permission' }]),
        });
        const second = deriveSessionSubagentPendingAttentionKinds({
            subagent,
            reducerState: { sidechains: new Map(), permissions: new Map() },
        });

        expect(first).toEqual([]);
        // One frozen instance, so an unchanged row keeps its array identity and stays memoized.
        expect(second).toBe(first);
    });

    it('ignores an unrecognised permission kind rather than announcing an approval', () => {
        expect(deriveSessionSubagentPendingAttentionKinds({
            subagent,
            reducerState: sidechainState([{ id: 'perm-1', status: 'pending', kind: 'something_new' }]),
        })).toEqual([]);
    });

    it('falls back to the parent transcript children when the sidechain has not been loaded yet', () => {
        const messages: readonly Message[] = [
            {
                kind: 'tool-call',
                id: 'msg-1',
                localId: null,
                createdAt: 1,
                tool: {
                    id: 'toolu_alpha',
                    name: 'SubAgent',
                    state: 'running',
                    input: {},
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: null,
                    description: 'Subagent',
                },
                children: [
                    {
                        kind: 'tool-call',
                        id: 'msg-1-child',
                        localId: null,
                        createdAt: 2,
                        tool: {
                            id: 'perm-tool-1',
                            name: 'bash',
                            state: 'running',
                            input: {},
                            createdAt: 2,
                            startedAt: 2,
                            completedAt: null,
                            description: 'pwd',
                            permission: {
                                id: 'perm-2',
                                status: 'pending',
                                kind: 'user_action',
                            },
                        },
                        children: [],
                    },
                ],
            },
        ];

        expect(deriveSessionSubagentPendingAttentionKinds({
            subagent,
            reducerState: { sidechains: new Map(), permissions: new Map() },
            messages,
        })).toEqual(['user_action']);
    });

    it('names the prompts it waits on by the Session request ids that answer them, still-pending only', () => {
        expect(listSessionSubagentPendingPrompts({
            subagent,
            reducerState: sidechainState([
                { id: 'perm-question', status: 'pending', kind: 'user_action' },
                { id: 'perm-done', status: 'pending', kind: 'permission' },
                { id: 'perm-run', status: 'pending', kind: 'permission' },
            ], new Map([['perm-done', { status: 'approved' }]])),
        })).toEqual([
            { id: 'perm-question', kind: 'user_action' },
            { id: 'perm-run', kind: 'permission' },
        ]);
    });
});
