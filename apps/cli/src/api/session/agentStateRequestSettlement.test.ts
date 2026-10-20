import { describe, expect, it } from 'vitest';
import { AgentStateRequestSettlementSchema, applyAgentStateRequestSettlement, buildAgentStateRequestSettlement } from './agentStateRequestSettlement';

const request = { tool: 'Bash', arguments: { command: 'work' }, createdAt: 10, turnId: 'turn-1' };
const completed = { ...request, completedAt: 20, status: 'canceled' as const };

describe('exact AgentState request settlement', () => {
    it('retires only the captured occurrence and preserves current neighboring state', () => {
        const intent = buildAgentStateRequestSettlement({ requests: { old: request } }, {
            requests: {}, completedRequests: { old: completed },
        });
        expect(applyAgentStateRequestSettlement({ requests: { old: request, background: { ...request, createdAt: 11 } },
            controlledByUser: true }, intent)).toEqual({ requests: { background: { ...request, createdAt: 11 } },
            completedRequests: { old: completed }, controlledByUser: true });
        const newer = { requests: { old: { ...request, turnId: 'turn-2' } } };
        expect(applyAgentStateRequestSettlement(newer, intent)).toBe(newer);
    });

    it('preserves a replacement with different canonical occurrence metadata', () => {
        const intent = buildAgentStateRequestSettlement({ requests: { old: request } }, {
            completedRequests: { old: completed },
        });
        const replacement = { requests: { old: { ...request, kind: 'user_action',
            responseTarget: { kind: 'external-response' } } } };
        expect(applyAgentStateRequestSettlement(replacement, intent)).toBe(replacement);
    });

    it('preserves first-answer claims and newer acknowledged completions', () => {
        const intent = buildAgentStateRequestSettlement({ requests: { old: request } }, {
            completedRequests: { old: completed },
        });
        const claimed = { requests: { old: { ...request, permissionResponseClaimV1: { opaque: true } } } };
        expect(applyAgentStateRequestSettlement(claimed, intent)).toBe(claimed);
        const newer = { completedRequests: { old: { ...completed, completedAt: 21 } } };
        expect(applyAgentStateRequestSettlement(newer, intent)).toBe(newer);
    });

    it('preserves the first acknowledged terminal when a later stale cancellation is replayed', () => {
        const staleCancellation = { ...completed, completedAt: 30 };
        const intent = buildAgentStateRequestSettlement({ requests: { old: request } }, {
            completedRequests: { old: staleCancellation },
        });
        const approved = { ...completed, status: 'approved' as const, completedAt: 21 };
        const acknowledged = { completedRequests: { old: approved } };
        expect(applyAgentStateRequestSettlement(acknowledged, intent)).toBe(acknowledged);
        const liveReplacement = { requests: { old: request }, completedRequests: { old: approved } };
        expect(applyAgentStateRequestSettlement(liveReplacement, intent)).toMatchObject({
            requests: {}, completedRequests: { old: staleCancellation },
        });
    });

    it('replays predecessor automatic history only while its request and completion remain absent', () => {
        const intent = AgentStateRequestSettlementSchema.parse({ v: 1, entries: [{ requestId: 'old', completed, removeRequest: true, requestAbsent: true }] });
        expect(applyAgentStateRequestSettlement({}, intent)).toEqual({ requests: {}, completedRequests: { old: completed } });
        const appeared = { requests: { old: request } };
        expect(applyAgentStateRequestSettlement(appeared, intent)).toBe(appeared);
        const acknowledged = { completedRequests: { old: { ...completed, completedAt: 19 } } };
        expect(applyAgentStateRequestSettlement(acknowledged, intent)).toBe(acknowledged);
    });
});
