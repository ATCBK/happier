import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { resolveMessageRouteIdForDisplay } from '@happier-dev/session-core/messages';
import { doesApprovalMatchToolCall, selectMatchingToolApprovalRequests, selectToolApprovalRequestsForMessages, usePreparedToolApprovalRequests } from './toolApprovalPromptMatching';

afterEach(standardCleanup);

function request(index: number): OpenApprovalArtifactForSession {
    return {
        artifact: { id: `approval-${index}`, title: null, isDecrypted: true, headerVersion: 1, bodyVersion: 1,
            seq: index, createdAt: 1, updatedAt: 1 },
        approval: ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'fixture' }, actionId: 'skills.rules.set',
            actionArgs: { id: String(index), state: 'on' }, summary: 'Change reach',
            origin: { kind: 'transcript_tool_call', sessionId: 'fixture', toolName: 'action_execute' } }),
    };
}

describe('transcript approval matching cost', () => {
    it('changes only the affected tool row when an approval arrives in a 1,000-row transcript', async () => {
        const requests = Array.from({ length: 12 }, (_, i) => request(i));
        const tools = Array.from({ length: 1000 }, (_, i) => createToolCallMessageFixture({ id: `message-${i}`,
            tool: { ...createToolCallMessageFixture({ id: 'base' }).tool, id: `tool-${i}`, name: 'mcp__happier__action_execute',
                input: { actionId: 'skills.rules.set', input: { id: String(i), state: 'on' } } } }).tool);
        let renders = 0;
        const Row = React.memo((_props: { requests: readonly OpenApprovalArtifactForSession[] }) => { renders++; return null; });
        function Transcript(props: { requests: readonly OpenApprovalArtifactForSession[] }) {
            const prepared = usePreparedToolApprovalRequests(props.requests);
            return React.createElement(React.Fragment, null, ...tools.map((tool, i) => React.createElement(Row, { key: i,
                requests: selectMatchingToolApprovalRequests({ requests: prepared, sessionId: 'fixture', messageId: `message-${i}`, tool, normalizedToolName: tool.name }),
            })));
        }
        const screen = await renderScreen(React.createElement(Transcript, { requests }));
        renders = 0;
        const incoming = request(12);
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            // The inventory's new publication reparses unchanged bodies but retains their Artifacts.
            await screen.update(React.createElement(Transcript, { requests: [...requests.map(x => ({ ...x, approval: { ...x.approval } })), incoming] }));
            expect(renders).toBe(1);
            expect(stringify.mock.calls.length).toBeLessThanOrEqual(1);
            renders = 0;
            await screen.update(React.createElement(Transcript, { requests: [...requests.slice(1), incoming] }));
            expect(renders).toBe(1);
        } finally { stringify.mockRestore(); }
    });

    it('keeps index selection equivalent to the correlation owner for explicit ids, fallback names and multiple approvals', () => {
        const base = request(1);
        const origin = base.approval.origin!;
        const requests = [
            { ...base, approval: { ...base.approval, origin: { ...origin, messageId: 'message', toolCallId: 'other' } } },
            { ...request(2), approval: { ...base.approval, origin: { ...origin, messageId: 'other', toolCallId: 'call' } } },
            { ...request(3), approval: { ...base.approval, origin: { ...origin, messageId: 'other' } } },
            { ...request(4), approval: { ...base.approval, origin: { ...origin, toolCallId: 'other' } } },
            { ...request(5), approval: { ...base.approval, origin: { ...origin, sessionId: 'another' } } },
            base,
            { ...request(6), approval: { ...base.approval, origin: { ...origin, toolName: 'normalized',
                toolInput: { actionId: 'skills.rules.set', input: { id: '1', state: 'on' } } } } },
        ];
        const tool = { ...createToolCallMessageFixture().tool, id: 'call', name: 'mcp__happier__action_execute',
            input: { input: { state: 'on', id: '1' }, actionId: 'skills.rules.set' } };
        for (const messageId of ['message', 'other', undefined]) {
            const params = { sessionId: 'fixture', messageId, tool, normalizedToolName: 'normalized' };
            const expected = requests.filter(request => doesApprovalMatchToolCall({ ...params, request }));
            expect(selectMatchingToolApprovalRequests({ ...params, requests })).toEqual(expected);
        }
        const message = createToolCallMessageFixture({ id: 'message', tool: { ...tool, name: 'unknown' } });
        const candidates = selectToolApprovalRequestsForMessages({ requests, sessionId: 'fixture', rowId: 'row', messages: [message] });
        // Parent narrowing must retain an input match that the leaf's name inference will resolve.
        expect(candidates).toContain(requests[6]);
        expect(selectMatchingToolApprovalRequests({ requests: candidates, sessionId: 'fixture', messageId: message.id,
            tool: message.tool, normalizedToolName: 'normalized' })).toContain(requests[6]);
        expect(selectMatchingToolApprovalRequests({ requests, sessionId: 'unrelated', messageId: 'message', tool, normalizedToolName: 'normalized' })).toHaveLength(0);
    });

    it('withdraws old associations when an approval changes its origin or disappears', async () => {
        const initial = request(1);
        const hook = await renderHook((props: { requests: readonly OpenApprovalArtifactForSession[] }) => usePreparedToolApprovalRequests(props.requests), { initialProps: { requests: [initial] } });
        const tool = { ...createToolCallMessageFixture().tool, id: 'call', name: 'mcp__happier__action_execute',
            input: { actionId: 'skills.rules.set', input: { id: '1', state: 'on' } } };
        const select = () => selectMatchingToolApprovalRequests({ requests: hook.getCurrent(), sessionId: 'fixture', messageId: 'message', tool, normalizedToolName: tool.name });
        expect(select()).toHaveLength(1);
        const changed = { artifact: { ...initial.artifact, bodyVersion: 2 }, approval: { ...initial.approval,
            origin: { ...initial.approval.origin!, toolCallId: 'other' } } };
        await hook.rerender({ requests: [changed] });
        expect(select()).toHaveLength(0);
        await hook.rerender({ requests: [] });
        expect(select()).toHaveLength(0);
    });

    it('retains approvals addressed by the displayed route rather than the internal message id', () => {
        const message = createToolCallMessageFixture({ id: 'internal-message',
            tool: { ...createToolCallMessageFixture().tool, id: 'call' } });
        const route = { messagesById: { [message.id]: message }, reducerState: null };
        const messageId = resolveMessageRouteIdForDisplay({ message, ...route });
        expect(messageId).not.toBe(message.id);
        const base = request(1);
        const approval = { ...base, approval: { ...base.approval, origin: { ...base.approval.origin!, messageId } } };
        const params = { requests: [approval], sessionId: 'fixture', rowId: 'row', messages: [message], messageId };
        const candidates = selectToolApprovalRequestsForMessages(params);
        expect(selectMatchingToolApprovalRequests({ requests: candidates, sessionId: 'fixture', messageId,
            tool: message.tool, normalizedToolName: message.tool.name })).toEqual([approval]);
    });

    it('serializes each unchanged reviewed input and tool input once across a long transcript', () => {
        const requests = Array.from({ length: 12 }, (_, i) => request(i));
        const tools = Array.from({ length: 1000 }, (_, i) => createToolCallMessageFixture({ id: `message-${i}`,
            tool: { ...createToolCallMessageFixture({ id: 'base' }).tool, id: `tool-${i}`, name: 'mcp__happier__action_execute',
                input: { actionId: 'skills.rules.set', input: { id: String(i), state: 'on' } } } }).tool);
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            const match = () => tools.map((tool, index) => requests.filter(request => doesApprovalMatchToolCall({
                request, sessionId: 'fixture', messageId: `message-${index}`, tool, normalizedToolName: tool.name,
            })));
            expect(match().filter(xs => xs.length > 0)).toHaveLength(12);
            expect(stringify.mock.calls.length).toBeLessThanOrEqual(1012);
            stringify.mockClear();
            expect(match().filter(xs => xs.length > 0)).toHaveLength(12);
            expect(stringify).not.toHaveBeenCalled();
            // The reducer replaces input while retaining the ToolCall identity; current input must win.
            tools[0]!.input = { actionId: 'skills.rules.set', input: { id: 'changed', state: 'on' } };
            expect(match()[0]).toHaveLength(0);
            expect(stringify).toHaveBeenCalledTimes(1);
        } finally { stringify.mockRestore(); }
    });

    it('reuses unchanged input across rendering-normalizer ToolCall projections', () => {
        const approval = request(1);
        const tool = { ...createToolCallMessageFixture().tool, id: 'call', name: 'mcp__happier__action_execute',
            input: { actionId: 'skills.rules.set', input: { id: '1', state: 'on' } } };
        const params = { request: approval, sessionId: 'fixture', messageId: 'message', normalizedToolName: tool.name };
        expect(doesApprovalMatchToolCall({ ...params, tool })).toBe(true);
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            expect(doesApprovalMatchToolCall({ ...params, tool: { ...tool, result: 'new output' } })).toBe(true);
            expect(stringify).not.toHaveBeenCalled();
        } finally { stringify.mockRestore(); }
    });
});
