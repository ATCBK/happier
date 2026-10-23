import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ActionsSettingsV1Schema, ApprovalRequestV2Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { normalizeToolCallV2 } from '@/agent/tools/normalization';
import { registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';
import { doesApprovalMatchToolCall } from '../../../../ui/sources/components/tools/shell/views/toolApprovalPromptMatching';
import { listTranscriptApprovalArtifactsForSession } from '../../../../ui/sources/sync/domains/artifacts/approvalArtifacts';
import { TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS } from '../../../../ui/sources/components/tools/shell/approvals/transcriptSettledApprovalPresentations';

describe('MCP approval origin to stored transcript review', () => {
  it.each([
    { label: 'Codex 0.162.1', meta: { callId: 'exec-owned-call', itemId: 'fc-distinct-item' }, correlated: true },
    { label: 'Claude Code 2.1.304', meta: { 'claudecode/toolUseId': 'exec-owned-call' }, correlated: true },
    { label: 'client without native correlation', meta: { progressToken: 1 }, correlated: false },
  ])('keeps the $label pending and declined review at its native call', async ({ meta, correlated }) => {
    let stored: string | undefined;
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'session.title.set': { approvalRequiredSurfaces: ['agent'] },
    } });
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      // The Artifact persistence/decision transports are external boundaries.
      approvalsCreate: async ({ request }) => { stored = JSON.stringify(request); return { artifactId: 'approval-owned' }; },
      approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request: ApprovalRequestV2Schema.parse({
        ...request, status: 'rejected', updatedAtMs: request.updatedAtMs + 1,
        decision: { kind: 'reject', decidedAtMs: request.updatedAtMs + 1 },
      }) }),
    });
    const bridge = createActionToolExecutorBridge({ surface: 'agent', actionsSettings, executor: {
      execute: (id, input, context) => executor.execute(id, input, { ...context, serverId: 'home-owned', runtimeAccountId: 'account-owned' }),
    } });
    const server = new McpServer({ name: 'happier', version: '1' });
    registerHappierMcpBuiltInTools(server, { sessionId: 'session-owned', sessionMachineId: 'machine-owned', surface: 'agent', actionsSettings,
      deps: { ...bridge, changeTitle: async () => { throw new Error('Unexpected title transport'); },
        resolveActionOptions: args => bridge.resolveActionOptions(args, 'session-owned') } });
    const client = new Client({ name: 'native-correlation', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      await client.callTool({ name: 'action_execute', arguments: { actionId: 'session.title.set', input: { sessionId: 'session-owned', title: 'Owned title' } }, _meta: meta });
      expect(stored).toBeDefined();
      const open = ApprovalRequestV2Schema.parse(JSON.parse(stored!));
      expect(open.origin).toMatchObject({ toolName: 'action_execute', mcpRequestId: expect.any(String) });
      expect(open.origin?.toolCallId).toBe(correlated ? 'exec-owned-call' : undefined);
      expect(open.origin?.mcpRequestId).not.toBe('exec-owned-call');
      const rawInput = { actionId: 'session.title.set', input: { sessionId: 'session-owned', title: 'Owned title' } };
      const normalized = normalizeToolCallV2({ protocol: 'codex', provider: 'codex', toolName: 'mcp__happier__action_execute', rawInput, callId: 'exec-owned-call' });
      const tool = { id: 'exec-owned-call', name: normalized.canonicalToolName, input: normalized.input,
        state: 'completed', createdAt: 1, startedAt: 1, completedAt: 2, description: null } as const;
      for (const approval of [open, ApprovalRequestV2Schema.parse({ ...open, status: 'rejected', updatedAtMs: open.updatedAtMs + 1,
        decision: { kind: 'reject', decidedAtMs: open.updatedAtMs + 1 } })]) {
        const header = buildApprovalRequestArtifactHeaderV1(approval);
        const selected = listTranscriptApprovalArtifactsForSession([{ id: 'approval-owned', header, title: header.title ?? null,
          sessions: header.sessions, draft: header.draft, body: JSON.stringify(approval), headerVersion: 1, bodyVersion: 1,
          seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true }], { serverId: 'home-owned', sessionId: 'session-owned' },
        { settledPresentations: TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS });
        expect(selected).toHaveLength(1);
        const match = (id: string) => doesApprovalMatchToolCall({ request: selected[0]!, sessionId: 'session-owned', messageId: 'message-owned', tool: { ...tool, id }, normalizedToolName: 'MCP' });
        expect(match('exec-owned-call')).toBe(true);
        if (correlated) {
          expect(match('exec-other-call')).toBe(false);
          expect(match(open.origin!.mcpRequestId!)).toBe(false);
        }
        const otherInput = normalizeToolCallV2({ protocol: 'codex', provider: 'codex', toolName: 'mcp__happier__action_execute',
          rawInput: { ...rawInput, input: { ...rawInput.input, title: 'Another title' } }, callId: 'exec-other-call' });
        expect(doesApprovalMatchToolCall({ request: selected[0]!, sessionId: 'session-owned', messageId: 'message-owned',
          tool: { ...tool, id: 'exec-other-call', input: otherInput.input }, normalizedToolName: 'MCP' })).toBe(false);
      }
    } finally { await client.close(); await server.close(); }
  });
});
