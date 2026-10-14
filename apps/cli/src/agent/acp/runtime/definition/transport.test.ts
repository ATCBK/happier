import { describe, expect, it } from 'vitest';

import { buildAcpToolNameResolverInput } from '@/agent/acp/toolCalls';

import { createAcpTransportHandlerFromDefinition } from './transport';

describe('ACP definition transport tool-name inference', () => {
  it('keeps a typed native correlation ahead of a canonical-looking display title', () => {
    const transport = createAcpTransportHandlerFromDefinition({
      backendId: 'acme.provider', mcpServerKeys: new Set(['docs', 'archive']),
      callbacks: { toolNameResolver: ({ toolCallId }) => toolCallId === 'native-docs-read' ? 'mcp__docs__read' : null },
    });
    expect(transport.determineToolName?.('other', 'native-docs-read',
      buildAcpToolNameResolverInput({}, 'mcp__archive__delete'),
      { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 1 })).toBe('mcp__docs__read');
  });

  it('keeps a known MCP identity ahead of native tool-name heuristics', () => {
    const transport = createAcpTransportHandlerFromDefinition({
      backendId: 'acme.provider',
      mcpServerKeys: new Set(['docs', 'docs__team']),
      toolNameInference: {
        patterns: [{ name: 'read', patterns: ['read_file'], inputFields: ['path'] }],
      },
    });
    expect(transport.determineToolName?.('mcp__docs__team__read_file', 'opaque', { path: 'a' }, {
      recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 1,
    })).toBe('mcp__docs__team__read_file');
  });

  it('keeps host-owned MCP session grants revocable by selecting only native allow_once', () => {
    const transport = createAcpTransportHandlerFromDefinition({
      backendId: 'acme.provider', mcpServerKeys: new Set(['docs']),
      mcpToolPolicyServerKeys: new Set(['docs']), permissionOptionSelection: { approved: 'allow_always' },
    });
    const options = [
      { optionId: 'persistent', kind: 'allow_always', name: 'Always' },
      { optionId: 'single', kind: 'allow_once', name: 'Once' },
    ];
    const context = { toolCallId: 'call', toolName: 'mcp__docs__read_file', input: {} };
    expect(transport.pickPermissionOptionId?.(options, 'approved_for_session', context)).toBe('single');
    expect(transport.pickPermissionOptionId?.([options[0]!], 'approved_for_session', context)).toBeNull();
    expect(transport.pickPermissionOptionId?.(options, 'approved', { ...context, toolName: 'read' })).toBe('persistent');
  });

  it('prefers a provider title hint over a generic input-field identity', () => {
    const transport = createAcpTransportHandlerFromDefinition({
      backendId: 'acme.provider',
      toolNameInference: {
        patterns: [{
          name: 'change_title',
          patterns: ['change_title'],
          inputFields: ['title'],
        }, {
          name: 'read',
          patterns: ['read', 'read_file'],
          inputFields: ['path'],
        }],
        unknownToolNames: ['other'],
        hintInputFields: ['title'],
        preferLongestPattern: true,
      },
    });

    const inferenceInput = buildAcpToolNameResolverInput({
      target_file: '/workspace/README.md',
    }, 'read_file');

    expect(transport.determineToolName?.('other', 'opaque-call-id', inferenceInput, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 1,
    })).toBe('read');
  });

  it('prefers a command input over additive ACP title metadata', () => {
    const transport = createAcpTransportHandlerFromDefinition({
      backendId: 'acme.provider',
      toolNameInference: {
        patterns: [{
          name: 'change_title',
          patterns: ['change_title'],
          inputFields: ['title'],
        }, {
          name: 'bash',
          patterns: ['bash', 'execute'],
          inputFields: ['command', 'cmd'],
        }],
        unknownToolNames: ['other'],
        hintInputFields: ['title', 'description'],
        preferLongestPattern: true,
      },
    });

    expect(transport.determineToolName?.('other', 'opaque-call-id', {
      command: 'echo TRACE_OK',
      description: 'Echo trace marker',
      title: 'run_terminal_command',
      _acp: { title: 'run_terminal_command' },
    }, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 2,
    })).toBe('bash');
  });

  it('does not treat provider observation titles as change-title input', () => {
    const transport = createAcpTransportHandlerFromDefinition({
      backendId: 'acme.provider',
      toolNameInference: {
        patterns: [{
          name: 'change_title',
          patterns: ['change_title'],
          inputFields: ['title'],
        }, {
          name: 'bash',
          patterns: ['bash', 'execute_command'],
          inputFields: ['command', 'cmd'],
        }],
        unknownToolNames: ['other'],
        hintInputFields: ['title', 'description'],
        preferLongestPattern: true,
      },
    });

    const inferenceInput = buildAcpToolNameResolverInput(
      { task_ids: ['call-1'], timeout_ms: 60_000 },
      'get_command_or_subagent_output',
    );

    expect(transport.determineToolName?.('other', 'opaque-call-id', inferenceInput, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 2,
    })).toBe('other');
  });
});
