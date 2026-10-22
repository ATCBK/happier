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

describe('ToolFullView as the tool-details page', () => {
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
