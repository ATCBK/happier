import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderWithSessionTranscriptSource as renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';
import {
  collectHostText,
  findPressableByText,
  installToolShellCommonModuleMocks,
  makeToolCall,
} from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
  sync: { ensureSidechainMessagesLoaded: vi.fn() },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

installToolShellCommonModuleMocks({
  storage: async (importOriginal) => {
    const { createStorageModuleMock } =
      await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
      importOriginal,
      overrides: {
        useSetting: createUseSettingMock({
          fallback: (key) =>
            key === 'toolViewShowDebugByDefault' ? false : null,
        }),
      },
    });
  },
});

const { ToolFullView } = await import('./ToolFullView');
const { ToolDetailsPageHeader } = await import('../presentation/ToolDetailsPageHeader');

function headerOutcome(screen: Awaited<ReturnType<typeof renderScreen>>): string | undefined {
  return screen.tree.root.findAll((node) => node.props.testID === 'tool-details-outcome'
    && typeof node.props.accessibilityLabel === 'string')[0]?.props.accessibilityLabel;
}

// The recorded shape of a Codex `action_execute` call (QA Bot, session.archive): operands at the top
// level, the transport envelope beside them, and an MCP text result holding the Action's JSON.
const archiveCall = makeToolCall({
  name: 'mcp__happier__action_execute',
  state: 'completed',
  input: {
    actionId: 'session.archive',
    input: { sessionId: 'session-archived-1' },
    _mcp: {
      serverId: 'happier',
      toolId: 'action_execute',
      display: { title: 'MCP: happier action execute' },
    },
    _happier: {
      v: 2,
      protocol: 'acp',
      provider: 'codex',
      rawToolName: 'mcp__happier__action_execute',
      canonicalToolName: 'mcp__happier__action_execute',
    },
    _raw: {
      actionId: 'session.archive',
      input: { sessionId: 'session-archived-1' },
    },
    _acp: {},
    locations: [],
  },
  result: {
    content: [
      {
        type: 'text',
        text: '{"success":true,"sessionId":"session-archived-1","archivedAt":1792557232467}',
      },
    ],
    structuredContent: null,
    _mcp: { serverId: 'happier', toolId: 'action_execute' },
    _happier: {
      v: 2,
      protocol: 'acp',
      provider: 'codex',
      rawToolName: 'mcp__happier__action_execute',
    },
  },
});

// The same call when the Action asked for approval first: the result is the request, not the effect.
const archiveAskedCall = makeToolCall({
  ...archiveCall,
  result: {
    content: [
      {
        type: 'text',
        text: '{"kind":"approval_request_created","artifactId":"approval-1","actionId":"session.archive"}',
      },
    ],
  },
});

// A Create session call the daemon accepted but had not settled when it returned (`type: 'pending'`).
const createSessionPendingCall = makeToolCall({
  name: 'mcp__happier__action_execute',
  state: 'completed',
  input: {
    actionId: 'session.spawn_new',
    input: {
      creationKey: 'fix-r45-auth-helper-20261021-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: { kind: 'path', path: '/home/happier' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna' }, updatedAt: 0 },
      title: 'Authorization check helper',
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 }, options: {} },
    },
  },
  result: {
    content: [
      {
        type: 'text',
        text: '{"type":"pending","retryWithSameCreationKey":true,"outcome":"accepted","operation":{"machineId":"machine-1","operationId":"operation-1"}}',
      },
    ],
  },
});

describe('ToolFullView as the tool-details page', () => {
  it('says a call that asked for approval was sent for approval, in its header too', async () => {
    const screen = await renderScreen(
      React.createElement(ToolFullView, {
        tool: archiveAskedCall,
        owningMessageId: 'tool-message-2',
        sessionId: 's1',
        metadata: null,
        messages: [],
        header: React.createElement(ToolDetailsPageHeader, { tool: archiveAskedCall, metadata: null }),
      }),
    );
    expect(headerOutcome(screen)).toBe('toolView.approvalRequested.title');
  });

  it('reads an accepted, unsettled Create session as in progress, by meaning, never as Completed', async () => {
    const screen = await renderScreen(
      React.createElement(ToolFullView, {
        tool: createSessionPendingCall,
        owningMessageId: 'tool-message-3',
        sessionId: 's1',
        metadata: null,
        messages: [],
        header: React.createElement(ToolDetailsPageHeader, { tool: createSessionPendingCall, metadata: null }),
      }),
    );
    expect(headerOutcome(screen)).toBe('toolView.outcome.pending');
    expect(screen.tree.root.findAll((node) => node.props.testID === 'tool-details-pending').length).toBeGreaterThan(0);
    const visible = collectHostText(screen.tree).join('\n');
    expect(visible).toContain('/home/happier');
    for (const mechanism of ['Creation key', 'fix-r45-auth-helper', 'Plugin id', 'Retry with same creation key', 'Updated at', 'null', 'toolView.outcome.completed']) {
      expect(visible).not.toContain(mechanism);
    }
  });

  it('reads an Action that asked for approval as that request, never its envelope', async () => {
    const screen = await renderScreen(
      React.createElement(ToolFullView, {
        tool: archiveAskedCall,
        owningMessageId: 'tool-message-2',
        sessionId: 's1',
        metadata: null,
        messages: [],
      }),
    );
    expect(
      screen.tree.root.findAll((node) => node.props.testID === 'tool-details-approval-request').length,
    ).toBeGreaterThan(0);
    const visible = collectHostText(screen.tree).join('\n');
    expect(visible).not.toContain('approval_request_created');
    expect(visible).not.toContain('approval-1');
  });

  afterEach(() => {
    standardCleanup();
  });

  it('leads an Action call with its header, arguments and result, and keeps the transport envelope behind Debug', async () => {
    const screen = await renderScreen(
      React.createElement(ToolFullView, {
        tool: archiveCall,
        owningMessageId: 'tool-message-1',
        sessionId: 's1',
        metadata: null,
        messages: [],
        header: React.createElement('PageHeaderProbe', {
          testID: 'page-header-probe',
        }),
      }),
    );

    expect(
      screen.tree.root.findAllByProps({ testID: 'page-header-probe' }).length,
    ).toBeGreaterThan(0);
    const visible = collectHostText(screen.tree).join('\n');
    // The result reads by meaning: the moment as a time under its readable name, without the success
    // flag the header's Completed already says or the Session id Details already names.
    expect(visible).toContain('Archived at');
    expect(visible).not.toContain('archivedAt');
    expect(visible).not.toContain('1792557232467');
    expect(visible).not.toMatch(/\bsuccess\b/);
    expect(visible).not.toContain('rawToolName');
    expect(visible).not.toContain('_mcp');

    const debugToggle = screen.tree.root.findAll((node) => node.props.testID === 'tool-details-debug-toggle' && typeof node.props.onPress === 'function')[0];
    await act(async () => {
      debugToggle?.props.onPress();
    });
    expect(collectHostText(screen.tree).join('\n')).toContain('rawToolName');
  });
});
