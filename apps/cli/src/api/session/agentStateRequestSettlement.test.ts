import { describe, expect, it } from 'vitest';
import type { AgentState } from '@/api/types';
import { applyAgentStateRequestSettlement, buildAgentStateRequestSettlement } from './agentStateRequestSettlement';

describe('exact AgentState request settlement', () => {
    const foreground = { tool: 'Write', arguments: { path: 'foreground' }, createdAt: 10 };
    const background = { tool: 'Write', arguments: { path: 'background' }, createdAt: 11 };
    const original: AgentState = { requests: { foreground, background } };
    const completed = { ...foreground, completedAt: 20, status: 'approved' as const };
    const intent = buildAgentStateRequestSettlement(original, {
        requests: { background }, completedRequests: { foreground: completed },
    });

    it('rebases a completion without dropping background or newly published requests and is idempotent', () => {
        const current: AgentState = {
            ...original, controlledByUser: true,
            requests: { ...original.requests, newer: { ...foreground, createdAt: 30 } },
        };
        const settled = applyAgentStateRequestSettlement(current, intent);
        expect(settled).toEqual({
            controlledByUser: true,
            requests: { background, newer: { ...foreground, createdAt: 30 } },
            completedRequests: { foreground: completed },
        });
        expect(applyAgentStateRequestSettlement(settled, intent)).toEqual(settled);
    });

    it('does not settle a replacement occurrence with the same request id or a claimed request', () => {
        const replacement = { ...foreground, createdAt: 30 };
        expect(applyAgentStateRequestSettlement({ requests: { foreground: replacement } }, intent).requests)
            .toEqual({ foreground: replacement });
        const claimed = { ...foreground, permissionResponseClaimV1: { owner: 'new-runtime' } };
        expect(applyAgentStateRequestSettlement({ requests: { foreground: claimed } }, intent).requests)
            .toEqual({ foreground: claimed });
    });
});
