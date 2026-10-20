import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { z } from 'zod/mini';
import * as mini from 'zod/mini';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';

const env = process.env;

describe('registerHappierBridgeTools', () => {
  it('projects discovered union inputs without wrapping forwarded arguments', async () => {
    const { registerHappierBridgeTools } = await import('./registerHappierBridgeTools');
    let registered: z.core.$ZodType | undefined;
    let handler: ((args: unknown) => Promise<unknown>) | undefined;
    const forwarded: unknown[] = [];
    registerHappierBridgeTools({ registerTool: (_name, definition, callback) => {
      registered = definition.inputSchema;
      handler = callback;
    } }, {
      tools: [{ name: 'upstream_union', inputSchema: { type: 'object', anyOf: [
        { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false },
      ] } }],
      callHttpTool: async (name, args) => { forwarded.push({ name, args }); return { content: [] }; },
    });
    if (!registered || !handler) throw new Error('Expected bridge registration');
    const schema = zodSchemaToJsonSchemaObject(registered);
    expect(schema).toMatchObject({ type: 'object', properties: { text: { type: 'string' }, count: { type: 'integer' } } });
    for (const key of ['oneOf', 'anyOf', 'allOf']) expect(schema).not.toHaveProperty(key);
    const input = { text: '  original bytes  ' };
    await handler(input);
    expect(forwarded).toEqual([{ name: 'upstream_union', args: input }]);
  });

  it('retains strict Mini validation and JSON projection at bridge registration', async () => {
    const { registerHappierBridgeTools } = await import('./registerHappierBridgeTools');
    const schema = mini.strictObject({ name: mini.string() });
    let registered: unknown;
    registerHappierBridgeTools({ registerTool: (_name, definition) => { registered = definition.inputSchema; } }, {
      tools: [{ name: 'mini_fixture', inputSchema: schema }],
      callHttpTool: async () => ({ content: [] }),
    });
    if (!(registered instanceof z.core.$ZodType)) throw new Error('Missing registered schema');
    expect(z.safeParse(registered, { name: 'valid' }).success).toBe(true);
    expect(z.safeParse(registered, {}).success).toBe(false);
    expect(z.safeParse(registered, { name: 'valid', extra: true }).success).toBe(false);
    expect(zodSchemaToJsonSchemaObject(registered)).toMatchObject({
      type: 'object', required: ['name'], additionalProperties: false,
    });
  });
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  it('registers only the currently enabled Happier MCP tools and forwards calls', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['agent'], disabledPlacements: [] },
      },
    });

    const { registerHappierBridgeTools } = await import('./registerHappierBridgeTools');
    const calls: any[] = [];
    const registrar = {
      registerTool: (name: string, _def: any, handler: (args: any) => Promise<any>) => {
        calls.push({ name, handler });
      },
    };

    const forwarded: any[] = [];
    registerHappierBridgeTools(registrar as any, {
      tools: listBuiltInHappierTools({ surface: 'agent', isServerFeatureEnabled: () => false }),
      callHttpTool: async (name: string, args: unknown) => {
        forwarded.push({ name, args });
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
    });

    const names = calls.map((c) => c.name);
    expect(names).toEqual(listBuiltInHappierTools({
      surface: 'agent',
      isServerFeatureEnabled: () => false,
    }).map((tool) => tool.name));
    expect(names).toContain('change_title');
    expect(names).not.toContain('happier__change_title');
    expect(names).not.toContain('happy__change_title');
    expect(names).not.toContain('review_start');
    expect(names).not.toContain('execution_run_start');

    const actionExecute = calls.find((c) => c.name === 'action_execute');
    expect(actionExecute).toBeTruthy();
    const res = await actionExecute.handler({
      actionId: 'execution.run.start',
      input: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
      },
    });
    expect(res.isError).toBe(false);
    expect(forwarded[0]).toEqual({
      name: 'action_execute',
      args: {
        actionId: 'execution.run.start',
        input: {
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Review.',
        },
      },
    });
  });

  it('registers the authoritative remote catalog exactly, including plugin tools', async () => {
    const { registerHappierBridgeTools } = await import('./registerHappierBridgeTools');
    const registered: Array<{
      name: string;
      definition: unknown;
      handler: (args: unknown) => Promise<any>;
    }> = [];
    const callHttpTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      isError: false,
    }));

    registerHappierBridgeTools({
      registerTool: (name, definition, handler) => {
        registered.push({ name, definition, handler });
      },
    }, {
      tools: [{
        name: 'acme_review_start',
        title: 'Acme Review Start',
        description: 'Start a plugin-defined review',
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
          properties: {
            completed: { type: 'boolean' },
          },
          required: ['completed'],
          additionalProperties: false,
        },
        annotations: { destructiveHint: true },
        _meta: {
          'happier.dev/pluginTool': {
            toolId: 'acme.review.plugin/review-tool',
            actionId: 'acme.review.plugin/review-start',
            safety: 'danger',
          },
        },
      }],
      callHttpTool,
    });

    expect(registered.map((entry) => entry.name)).toEqual(['acme_review_start']);
    const definition = registered[0]?.definition as {
      inputSchema?: z.ZodMiniType;
      outputSchema?: z.ZodMiniType;
      annotations?: unknown;
      _meta?: unknown;
    } | undefined;
    expect(definition?.inputSchema?.safeParse({ scope: 'diff' }).success).toBe(true);
    expect(definition?.inputSchema ? z.toJSONSchema(definition.inputSchema, { target: 'draft-7' }) : null).toMatchObject({
      type: 'object',
      properties: {
        scope: { type: 'string' },
      },
      required: ['scope'],
      additionalProperties: false,
    });
    expect(definition?.outputSchema ? z.toJSONSchema(definition.outputSchema, { target: 'draft-7' }) : null).toMatchObject({
      type: 'object',
      properties: {
        completed: { type: 'boolean' },
      },
      required: ['completed'],
      additionalProperties: false,
    });
    expect(definition?.annotations).toEqual({ destructiveHint: true });
    expect(definition?._meta).toEqual({
      'happier.dev/pluginTool': {
        toolId: 'acme.review.plugin/review-tool',
        actionId: 'acme.review.plugin/review-start',
        safety: 'danger',
      },
    });
    await registered[0]?.handler({ scope: 'diff' });
    expect(callHttpTool).toHaveBeenCalledWith('acme_review_start', { scope: 'diff' });
  });

  it('returns an MCP error result when the authoritative remote invocation fails', async () => {
    const { registerHappierBridgeTools } = await import('./registerHappierBridgeTools');
    const registered: Array<{
      name: string;
      handler: (args: unknown) => Promise<any>;
    }> = [];

    registerHappierBridgeTools({
      registerTool: (name, _definition, handler) => {
        registered.push({ name, handler });
      },
    }, {
      tools: [{
        name: 'acme_review_start',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
      }],
      callHttpTool: async () => {
        throw new Error('remote disconnected');
      },
    });

    await expect(registered[0]?.handler({})).resolves.toEqual({
      content: [{
        type: 'text',
        text: 'Failed to call tool acme_review_start: remote disconnected',
      }],
      isError: true,
    });
  });

  it('forwards the MCP request abort signal to the authoritative remote invocation', async () => {
    const { registerHappierBridgeTools } = await import('./registerHappierBridgeTools');
    const registered: Array<{
      handler: (args: unknown, extra?: { signal?: AbortSignal }) => Promise<any>;
    }> = [];
    const callHttpTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      isError: false,
    }));

    registerHappierBridgeTools({
      registerTool: (_name, _definition, handler) => {
        registered.push({ handler });
      },
    }, {
      tools: [{
        name: 'acme_review_start',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
      }],
      callHttpTool,
    });

    const controller = new AbortController();
    await registered[0]?.handler({}, { signal: controller.signal });

    expect(callHttpTool).toHaveBeenCalledWith(
      'acme_review_start',
      {},
      { signal: controller.signal },
    );
  });

  it('does not convert an aborted remote invocation into an ordinary tool failure', async () => {
    const { registerHappierBridgeTools } = await import('./registerHappierBridgeTools');
    const registered: Array<{
      handler: (args: unknown, extra?: { signal?: AbortSignal }) => Promise<any>;
    }> = [];
    const abortError = new DOMException('The request was aborted', 'AbortError');

    registerHappierBridgeTools({
      registerTool: (_name, _definition, handler) => {
        registered.push({ handler });
      },
    }, {
      tools: [{
        name: 'acme_review_start',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
      }],
      callHttpTool: async () => {
        throw abortError;
      },
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      registered[0]?.handler({}, { signal: controller.signal }),
    ).rejects.toBe(abortError);
  });

  it('forwards requested MCP progress across the bridge', async () => {
    const { registerHappierBridgeTools } = await import('./registerHappierBridgeTools');
    const registered: Array<{
      handler: (args: any, extra?: any) => Promise<any>;
    }> = [];
    const callHttpTool = vi.fn(async (_name: string, _args: unknown, options?: {
      onprogress?: (progress: { progress: number }) => void;
    }) => {
      options?.onprogress?.({ progress: 1 });
      return { content: [{ type: 'text' as const, text: 'ok' }], isError: false };
    });

    registerHappierBridgeTools({
      registerTool: (_name, _definition, handler) => {
        registered.push({ handler });
      },
    }, {
      tools: [{ name: 'long_running', inputSchema: { type: 'object' } }],
      callHttpTool,
    });

    const sendNotification = vi.fn(async () => undefined);
    await registered[0]?.handler({}, {
      _meta: { progressToken: 'progress-1' },
      sendNotification,
    });

    expect(sendNotification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 'progress-1', progress: 1 },
    });
  });
});
