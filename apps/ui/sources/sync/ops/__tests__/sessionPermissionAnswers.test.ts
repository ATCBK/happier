import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSessionRpcWithPreferredSessionScope } = vi.hoisted(() => ({
    mockSessionRpcWithPreferredSessionScope: vi.fn(),
}));

// The session RPC transport is the system boundary; the decision mapping,
// turn-id projection and request shaping above it stay real.
vi.mock('../../runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
    sessionRpcWithPreferredSessionScope: (...args: unknown[]) => mockSessionRpcWithPreferredSessionScope(...args),
}));

vi.mock('../../sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
        },
    },
}));

import { sessionRespondToPermission } from '../sessions';
import {
    answerSessionPermission,
    resolveSessionPermissionAnswers,
} from '../sessionPermissionAnswers';

const respondToPermission: Parameters<typeof answerSessionPermission>[0]['respondToPermission'] =
    (params) => sessionRespondToPermission('s1', params);

type RpcCall = Readonly<{ sessionId: string; method: string; payload: Record<string, unknown> }>;

function lastRpcCall(): RpcCall {
    const call = mockSessionRpcWithPreferredSessionScope.mock.calls.at(-1)?.[0] as RpcCall | undefined;
    if (!call) throw new Error('no session RPC was issued');
    return call;
}

describe('answerSessionPermission', () => {
    beforeEach(() => {
        mockSessionRpcWithPreferredSessionScope.mockReset();
        mockSessionRpcWithPreferredSessionScope.mockResolvedValue(undefined);
    });

    it('delivers its provider decision through the injected source responder', async () => {
        const respondToPermission = vi.fn(async () => {});
        await answerSessionPermission({
            requestId: 'req-source',
            toolName: 'bash',
            turnId: 'turn-source',
            answer: 'allowForSession',
            policy: { protocol: 'codexDecision', usePermissionUpdates: false },
            respondToPermission,
        });
        expect(respondToPermission).toHaveBeenCalledWith({
            id: 'req-source', turnId: 'turn-source', approved: true, decision: 'approved_for_session',
        });
        expect(mockSessionRpcWithPreferredSessionScope).not.toHaveBeenCalled();
    });

    it('answers a decision-protocol request with the exact provider decision for each answer', async () => {
        const base = {
            requestId: 'req-1',
            turnId: 'turn-1',
            toolName: 'bash',
            policy: { protocol: 'codexDecision', usePermissionUpdates: false },
            respondToPermission,
        } as const;

        await answerSessionPermission({ ...base, answer: 'allowOnce' });
        expect(lastRpcCall().payload).toMatchObject({ id: 'req-1', turnId: 'turn-1', approved: true, decision: 'approved' });

        await answerSessionPermission({ ...base, answer: 'allowForSession' });
        expect(lastRpcCall().payload).toMatchObject({ approved: true, decision: 'approved_for_session' });

        await answerSessionPermission({ ...base, answer: 'deny' });
        expect(lastRpcCall().payload).toMatchObject({ approved: false, decision: 'denied' });
    });

    it('grants a standard-protocol session allowance as a tool rule, not a one-shot approval', async () => {
        await answerSessionPermission({
            requestId: 'req-2',
            toolName: 'Bash(git status)',
            answer: 'allowForSession',
            policy: { protocol: 'standard', usePermissionUpdates: false },
            respondToPermission,
        });
        expect(lastRpcCall().payload).toMatchObject({
            id: 'req-2',
            approved: true,
            allowedTools: ['Bash(git status)'],
        });
        expect(lastRpcCall().payload.decision).toBeUndefined();

        await answerSessionPermission({
            requestId: 'req-3',
            toolName: 'Bash(git status)',
            answer: 'allowForSession',
            policy: { protocol: 'standard', usePermissionUpdates: true },
            respondToPermission,
        });
        expect(lastRpcCall().payload).toMatchObject({
            approved: true,
            allowedTools: ['Bash(git status)'],
            updatedPermissions: [{
                type: 'addRules',
                rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
                behavior: 'allow',
                destination: 'session',
            }],
        });
    });

    it('offers no session allowance where the session UI offers none', () => {
        expect(resolveSessionPermissionAnswers({ toolName: 'Edit', protocol: 'standard' }))
            .toEqual(['allowOnce', 'deny']);
        expect(resolveSessionPermissionAnswers({ toolName: 'Bash', protocol: 'standard' }))
            .toEqual(['allowOnce', 'allowForSession', 'deny']);
        expect(resolveSessionPermissionAnswers({ toolName: 'Edit', protocol: 'codexDecision' }))
            .toEqual(['allowOnce', 'allowForSession', 'deny']);
    });

    it.each(['standard', 'codexDecision'] as const)('keeps a request-owned once-only scope for %s answers', async protocol => {
        expect(resolveSessionPermissionAnswers({ toolName: 'Bash', protocol, source: 'native_tool_approval_once' }))
            .toEqual(['allowOnce', 'deny']);
        const respond = vi.fn(async () => {});
        const request = { requestId: 'native-bash', turnId: 'native-turn', toolName: 'Bash',
            source: 'native_tool_approval_once', policy: { protocol, usePermissionUpdates: true }, respondToPermission: respond };
        await expect(answerSessionPermission({ ...request, answer: 'allowForSession' }))
            .rejects.toMatchObject({ code: 'permission_answer_unavailable' });
        expect(respond).not.toHaveBeenCalled();
        await answerSessionPermission({ ...request, answer: 'allowOnce' });
        expect(respond).toHaveBeenCalledWith({ id: 'native-bash', turnId: 'native-turn', approved: true,
            ...(protocol === 'codexDecision' ? { decision: 'approved' } : {}) });
    });
});
