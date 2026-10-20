import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { ACTION_IDS } from '@happier-dev/protocol/actions/actionIds';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

const boundary = vi.hoisted(() => ({
  daemonPost: vi.fn(async () => ({
    matched: true as const,
    result: {
      ok: true as const,
      result: { completed: true },
    },
  })),
}));

// Daemon HTTP is the system boundary; retain the real control-client contract.
vi.mock('@/daemon/controlHttp', () => ({
  daemonPost: boundary.daemonPost,
}));

import { createExternalMcpServer } from './createExternalMcpServer';
import { PLUGIN_ACTION_EXECUTE_PATH } from '@/plugins/daemon/controlRoutes';

describe('createExternalMcpServer plugin tools', () => {
  beforeEach(() => {
    // This composition exercises plugin inputs. The complete built-in inventory
    // has its own registrar test; use real Account Action policy to select this scenario.
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({
      v: 1, actions: Object.fromEntries(ACTION_IDS.map(id => [id, { enabled: false }])),
    }));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each(['oneOf', 'anyOf', 'allOf', 'references', 'rootReferences'] as const)('round-trips union arguments unchanged and refuses crossed variants or a mis-wired tool name (%s)', async combinator => {
    const branches: [ProjectedPluginToolCatalogEntry['inputSchema'], ProjectedPluginToolCatalogEntry['inputSchema']] = [
        { type: 'object', properties: { kind: { const: 'text' }, text: { type: 'string' } }, required: ['kind', 'text'], additionalProperties: false },
        { type: 'object', properties: { kind: { const: 'count' }, count: { type: 'integer' } }, required: ['kind', 'count'], additionalProperties: false },
    ];
    const inputSchema: ProjectedPluginToolCatalogEntry['inputSchema'] = combinator === 'references' ? {
      definitions: { text: branches[0], count: branches[1] }, oneOf: [{ $ref: '#/definitions/text' }, { $ref: '#/definitions/count' }],
    } : combinator === 'rootReferences' ? { oneOf: [branches[0], {
      ...branches[1], properties: { ...branches[1]!.properties, label: { $ref: '#/oneOf/0/properties/text' } },
    }] } : combinator === 'allOf' ? { allOf: [{ oneOf: branches }] } : { [combinator]: branches };
    const { mcp } = createExternalMcpServer({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) } },
      pluginToolCatalog: [{
        toolId: 'acme.union/union-tool', actionId: 'acme.union/actions/read', name: 'acme_union_read',
        title: 'Read variant', description: 'Read either variant', inputSchema, surfaces: ['mcp'],
      }],
    });
    const client = new Client({ name: 'union-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const advertised = (await client.listTools()).tools.find(tool => tool.name === 'acme_union_read')!;
      expect(advertised).toBeDefined();
      expect(advertised.inputSchema.type).toBe('object');
      expect(advertised.inputSchema.properties).toMatchObject({ kind: expect.any(Object), text: { type: 'string' }, count: { type: 'integer' } });
      for (const key of ['oneOf', 'anyOf', 'allOf']) expect(advertised.inputSchema).not.toHaveProperty(key);
      const validate = compilePluginJsonSchema(advertised.inputSchema);
      for (const input of [{ kind: 'text', text: '  exact bytes  ' }, { kind: 'count', count: 2,
        ...(combinator === 'rootReferences' ? { label: 'preserved reference' } : {}) }]) {
        expect(validate(input)).toBe(true);
        expect(await client.callTool({ name: advertised.name, arguments: input })).toMatchObject({
          isError: false, content: [{ type: 'text', text: JSON.stringify({ completed: true }) }],
        });
        expect(boundary.daemonPost).toHaveBeenLastCalledWith(PLUGIN_ACTION_EXECUTE_PATH, expect.objectContaining({
          actionId: 'acme.union/read', input,
        }), expect.objectContaining({ mutation: true, signal: expect.any(AbortSignal) }));
      }
      boundary.daemonPost.mockClear();
      // Projection omits cross-field correlations; the original validator must still reject them.
      for (const input of [{ kind: 'text', count: 2 }, { kind: 'count', count: 2, text: 'extra' }, { kind: 'unknown' }]) {
        expect(await client.callTool({ name: advertised.name, arguments: input })).toMatchObject({ isError: true });
      }
      expect(await client.callTool({ name: 'acme_union_missing', arguments: { kind: 'text', text: 'wrong route' } })).toMatchObject({ isError: true });
      expect(boundary.daemonPost).not.toHaveBeenCalled();
    } finally { await client.close(); await mcp.close(); }
  });

  it('advertises and dispatches a daemon-projected plugin tool through the MCP SDK boundary', async () => {
    const { mcp, toolNames } = createExternalMcpServer({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      pluginToolCatalog: [{
        toolId: 'acme.review.plugin/review-tool',
        actionId: 'acme.review.plugin/actions/review-start',
        name: 'acme_review_start',
        title: 'Acme Review Start',
        description: 'Start a plugin-defined review workflow',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string' },
          },
          required: ['scope'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { completed: { type: 'boolean' } }, required: ['completed'], additionalProperties: false,
        },
        safety: 'danger',
        inputHints: {
          fields: [{
            path: 'scope',
            title: 'Scope',
            widget: 'select',
            options: [{ value: 'diff', label: 'Diff' }],
          }],
        },
        examples: { mcp: { argsExample: '{"scope":"diff"}' } },
        promptSnippet: 'Start an Acme review.',
        promptGuidelines: ['Choose the narrowest applicable scope.'],
        availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
        surfaces: ['agent', 'mcp', 'cli'],
        expectedContributorOccurrenceId: 'occurrence-g',
      }],
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'plugin-tools-test', version: '1.0.0' }, { capabilities: {} });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(toolNames).toContain('acme_review_start');
      const listed = await client.listTools();
      expect(listed.tools.find((tool) => tool.name === 'acme_review_start')).toMatchObject({
        title: 'Acme Review Start',
        description: 'Start a plugin-defined review workflow',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string' },
          },
          required: ['scope'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          anyOf: expect.arrayContaining([expect.objectContaining({
            properties: { completed: { type: 'boolean' } }, required: ['completed'], additionalProperties: false,
          })]),
        },
        annotations: { destructiveHint: true },
        _meta: {
          'happier.dev/pluginTool': {
            toolId: 'acme.review.plugin/review-tool',
            actionId: 'acme.review.plugin/actions/review-start',
            safety: 'danger',
            inputHints: {
              fields: [{
                path: 'scope',
                title: 'Scope',
                widget: 'select',
                options: [{ value: 'diff', label: 'Diff' }],
              }],
            },
            examples: { mcp: { argsExample: '{"scope":"diff"}' } },
            promptSnippet: 'Start an Acme review.',
            promptGuidelines: ['Choose the narrowest applicable scope.'],
            availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
          },
        },
      });

      const result = await client.callTool({
        name: 'acme_review_start',
        arguments: { scope: 'diff' },
      });
      expect(result).toEqual({
        content: [{ type: 'text', text: '{"completed":true}' }],
        structuredContent: { completed: true },
        isError: false,
      });
      expect(boundary.daemonPost).toHaveBeenCalledWith(PLUGIN_ACTION_EXECUTE_PATH, {
        actionId: 'acme.review.plugin/review-start',
        input: { scope: 'diff' },
        surface: 'mcp',
        defaultSessionId: 'cli-global',
        expectedContributorOccurrenceId: 'occurrence-g',
      }, expect.objectContaining({ timeoutMs: null, mutation: true, signal: expect.any(AbortSignal) }));
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
