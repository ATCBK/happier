import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod/mini';
import * as m from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AutomationDefinitionCreateRequestSchema } from '../automations/automationApiV3.js';
import { listActionSpecs } from './actionSpecs.js';
import { compileActionInputJsonSchema } from './actionInputJsonSchemaValidation.js';
import { compilePluginJsonSchema, createPluginJsonSchemaZodObjectAdapter } from '../plugins/actions/jsonSchemaValidation.js';

import {
  ActionJsonSchemaProjectionError,
  zodSchemaToJsonSchemaObject,
} from './actionInputJsonSchema.js';

describe('actionInputJsonSchema', () => {
  it('publishes Project Action schemas when the Project owner is imported before the Action catalog', async () => {
    vi.resetModules();
    await import('../projects/projectContextV1.js');
    const { getActionSpec } = await import('./actionSpecs.js');
    for (const id of ['projects.context.update', 'projects.visibility.set'] as const) {
      const spec = getActionSpec(id);
      expect(spec.inputSchema, id).toBeDefined();
      expect(spec.outputSchema, id).toBeDefined();
      expect(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' }), id)
        .toMatchObject({ type: 'object', required: expect.arrayContaining(['target', 'expectedRevision']) });
    }
  });
  it('compacts repeated Action schemas without weakening their advertised inputs', () => {
    const target = z.strictObject({ kind: z.literal('workspace'), path: z.string().check(z.minLength(1)) });
    const schema = z.strictObject({ source: target, destination: target,
      archives: z.optional(z.array(target)), alternatives: z.optional(z.array(target)),
    });
    const inline = zodSchemaToJsonSchemaObject(schema);
    const compact = zodSchemaToJsonSchemaObject(schema, { reused: 'ref' });
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(inline).length);
    const advertised = new Ajv2020({ strict: false }).compile(compact);
    expect(advertised({ source: { kind: 'workspace', path: '/a' }, destination: { kind: 'workspace', path: '/b' } })).toBe(true);
    expect(advertised({ source: { kind: 'workspace', path: '' }, destination: { kind: 'workspace', path: '/b' } })).toBe(false);
    expect(advertised({ source: { kind: 'workspace', path: '/a' }, destination: { kind: 'project', path: '/b' } })).toBe(false);
    expect(advertised({ source: { kind: 'workspace', path: '/a', secret: true }, destination: { kind: 'workspace', path: '/b' } })).toBe(false);
  });
  it('projects the MCP input and output for every advertised Action from the real registry', async () => {
    const { listActionSpecs } = await import('./actionSpecs.js');
    for (const spec of listActionSpecs().filter(spec => spec.surfaces.mcp)) {
      // MCP eagerly registers every advertised input; a missing export must
      // fail this census rather than being skipped and aborting initialize.
      expect(spec.inputSchema, spec.id).toBeDefined();
      for (const schema of [spec.inputSchema, spec.agentInputSchema, spec.outputSchema]) {
        if (!schema) continue;
        const projected = zodSchemaToJsonSchemaObject(schema, { target: 'draft-7' });
        expect(JSON.parse(JSON.stringify(projected))).toEqual(projected);
      }
    }
  });

  it('projects genuine Mini lazy children without losing their input constraints', () => {
    const schema = z.strictObject({
      name: m.lazy(() => m.string().check(m.minLength(2))),
    });
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      expect(zodSchemaToJsonSchemaObject(schema, { target })).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string', minLength: 2 } },
      });
    }
  });

  it('validates its published recursive dialect while keeping Plugin admission draft-07-only', () => {
    const item = z.strictObject({ name: z.string().check(z.minLength(1)) });
    const input = z.strictObject({ first: item, second: item, tuple: z.tuple([z.string(), z.number()]) });
    const published = zodSchemaToJsonSchemaObject(input);
    const validate = compileActionInputJsonSchema(published);
    expect(validate({ first: { name: 'one' }, second: { name: 'two' }, tuple: ['text', 1] })).toBe(true);
    expect(validate({ first: { name: '' }, second: { name: 'two' }, tuple: ['text', 1] })).toBe(false);
    expect(validate({ first: { name: 'one' }, second: { name: 'two' }, tuple: [1, 'text'] })).toBe(false);
    expect(() => compilePluginJsonSchema(published)).toThrow();
  });

  it('refuses non-local references in unused published Action definitions without interpreting literal JSON as schema', () => {
    for (const $ref of ['https://example.test/schema.json', 'other.json#/node', '#anchor']) {
      expect(() => compileActionInputJsonSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'string', $defs: { unused: { $ref } },
      })).toThrow();
    }
    const validate = compileActionInputJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      const: { $ref: 'https://example.test/literal' },
    });
    expect(validate({ $ref: 'https://example.test/literal' })).toBe(true);
    expect(() => compileActionInputJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string', $async: true,
    })).toThrow();
  });

  it('retains Protocol strict JSON equality and UTF8 semantics in the published Action dialect', () => {
    const native = createPluginJsonSchemaZodObjectAdapter({
      type: 'object', properties: {
        text: { type: 'string', 'x-happier-max-utf8-bytes': 4 },
        values: { type: 'array', uniqueItems: true, items: { enum: [{ a: 1, b: 2 }] } },
      }, required: ['text', 'values'], additionalProperties: false,
    });
    const validate = compileActionInputJsonSchema(zodSchemaToJsonSchemaObject(native));
    expect(validate({ text: 'éé', values: [{ b: 2, a: 1 }] })).toBe(true);
    expect(validate({ text: 'ééé', values: [{ a: 1, b: 2 }] })).toBe(false);
    expect(validate({ text: 'éé', values: [{ a: 1, b: 2 }, { b: 2, a: 1 }] })).toBe(false);
    expect(() => compileActionInputJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string', 'x-happier-unbounded-bytes': 4,
    })).toThrow();
  });
  it('preserves the canonical JSON Schema constraints and descriptions that Action inputs advertise', () => {
    const schema = z.strictObject({
      name: z.string().check(z.minLength(2), z.maxLength(12), z.regex(/^[a-z]+$/), z.describe('Lowercase action name')),
      retries: z.number().check(z.minimum(1), z.maximum(5), z.describe('Retry limit')),
      tags: z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.maxLength(3), z.describe('Action tags')),
      mode: z.enum(['safe', 'fast']).check(z.describe('Execution mode')),
      target: z.union([z.literal('workspace'), z.literal('project')]).check(z.describe('Execution target')),
    }).check(z.describe('Agent action input'));

    const json = zodSchemaToJsonSchemaObject(schema);

    expect(json).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      description: 'Agent action input',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          minLength: 2,
          maxLength: 12,
          pattern: '^[a-z]+$',
          description: 'Lowercase action name',
        },
        retries: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          description: 'Retry limit',
        },
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          description: 'Action tags',
          items: { type: 'string', minLength: 1 },
        },
        mode: {
          type: 'string',
          enum: ['safe', 'fast'],
          description: 'Execution mode',
        },
        target: {
          anyOf: [
            { type: 'string', const: 'workspace' },
            { type: 'string', const: 'project' },
          ],
          description: 'Execution target',
        },
      },
    });
    expect(json).toEqual(z.toJSONSchema(schema, {
      io: 'input',
      target: 'draft-2020-12',
      unrepresentable: 'throw',
    }));
  });

  it('projects the same Action contract to draft-07 for consumers that require that dialect', () => {
    const json = zodSchemaToJsonSchemaObject(
      z.strictObject({ value: z.string().check(z.trim(), z.minLength(1)) }),
      { target: 'draft-7' },
    );

    expect(json).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { value: { type: 'string', minLength: 1 } },
      required: ['value'],
      additionalProperties: false,
    });
  });

  it('uses the canonical open-object projection for passthrough schemas', () => {
    const json = zodSchemaToJsonSchemaObject(z.looseObject({ value: z.string() }));

    expect(json).toMatchObject({ type: 'object' });
    expect(json.additionalProperties).toEqual({});
  });

  it('does not leak Zod standard-schema metadata into the JSON boundary', () => {
    const json = zodSchemaToJsonSchemaObject(z.strictObject({ value: z.string() }));

    expect(Object.getOwnPropertyDescriptor(json, '~standard')).toBeUndefined();
  });

  it('rejects Zod constructs that cannot be represented by an Action JSON Schema', () => {
    let projectionError: unknown;
    try {
      zodSchemaToJsonSchemaObject(z.date());
    } catch (error) {
      projectionError = error;
    }

    expect(projectionError).toBeInstanceOf(ActionJsonSchemaProjectionError);
    expect(projectionError).toMatchObject({
      name: 'ActionJsonSchemaProjectionError',
      code: 'action_schema_unrepresentable',
    });
  });

  it('converts a zod object schema into a JSON schema object (no refs)', () => {
    const schema = z.looseObject({
        sessionId: z.optional(z.string().check(z.minLength(1))),
        message: z.string().check(z.minLength(1)),
        flags: z.optional(z.array(z.string().check(z.minLength(1)))),
      });

    const json = zodSchemaToJsonSchemaObject(schema);

    expect(json).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        sessionId: expect.any(Object),
        message: expect.any(Object),
      }),
    });
    expect((json as any).$ref).toBeUndefined();
    expect((json as any).definitions).toBeUndefined();
  });

  it('converts string literal unions through the canonical JSON Schema union', () => {
    const schema = z.object({
      kind: z.union([z.literal('none'), z.literal('branch')]),
    });

    const json = zodSchemaToJsonSchemaObject(schema);
    const kindSchema = (json as any)?.properties?.kind;

    // The Zod projection represents literal branches as JSON Schema constants.
    expect(kindSchema).toMatchObject({
      anyOf: expect.any(Array),
    });
    expect(kindSchema.anyOf?.[0]).toMatchObject({ type: 'string' });
    expect(JSON.stringify(kindSchema)).toContain('none');
    expect(JSON.stringify(kindSchema)).toContain('branch');
  });
});

it('projects lazy Mini roots and children without weakening typed refusals', () => {
 const wrapped = lazyZodSchema(() => z.strictObject({ name: m.string().check(m.trim(),m.minLength(1)), count: m._default(m.number().check(m.int()),3) }));
 const concrete = z.strictObject({ name: z.string().check(z.trim(), z.minLength(1)), count: z._default(z.number().check(z.int()), 3) });
 for(const target of ['draft-7','draft-2020-12'] as const) {
  expect(zodSchemaToJsonSchemaObject(wrapped,{target})).toEqual(zodSchemaToJsonSchemaObject(concrete,{target}));
  const unsupported = lazyZodSchema(() => z.strictObject({ value: m.date() }));
  expect(()=>zodSchemaToJsonSchemaObject(unsupported,{target})).toThrow(ActionJsonSchemaProjectionError);
  try { zodSchemaToJsonSchemaObject(unsupported,{target}); } catch(error) {
   expect(error).toMatchObject({name:'ActionJsonSchemaProjectionError',code:'action_schema_unrepresentable'});
  }
 }
 expect(wrapped.parse({name:' kept '})).toEqual(concrete.parse({name:' kept '}));
 expect(()=>wrapped.parse({name:''})).toThrow(z.core.$ZodError);
});
it('keeps ref-rich lazy Action roots at their concrete public projection', async () => {
 const { AutomationDefinitionCreateRequestSchema: automationDefinitionSchema } = await import('../automations/automationApiV3.js');
 const repeated=z.strictObject({id:z.string().check(z.minLength(1))}).check(z.describe('Repeated argument'));
 const concrete=z.strictObject({first:repeated,second:repeated});
 for(const target of ['draft-7','draft-2020-12'] as const) {
  expect(zodSchemaToJsonSchemaObject(lazyZodSchema(()=>concrete),{target})).toEqual(zodSchemaToJsonSchemaObject(concrete,{target}));
  const automation=zodSchemaToJsonSchemaObject(automationDefinitionSchema,{target});
  expect(automation).toMatchObject({type:'object',required:['automationId','name','enabled','executionRecipe','triggers']});
  expect(automation.$ref).toBeUndefined();
 }
});
