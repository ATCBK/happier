import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';
import { compilePluginJsonSchema } from '../plugins/actions/jsonSchemaValidation.js';

describe('portable Zod string-check projection', () => {
  it('retains string-check constraints through the strict plugin consumer, including combined patterns and definitions', () => {
    const checks = z.strictObject({
      prefix: z.string().check(z.startsWith('/')),
      suffix: z.string().check(z.endsWith('.txt')),
      contains: z.string().check(z.includes('needle', { position: 2 })),
      lower: z.string().check(z.lowercase()),
      upper: z.string().check(z.uppercase()),
      combined: z.string().check(z.startsWith('/'), z.endsWith('.txt')),
    });
    const schema = z.strictObject({ first: checks, second: checks });
    const json = zodSchemaToJsonSchemaObject(schema, { target: 'draft-7', reused: 'ref' });
    const validate = compilePluginJsonSchema(json);
    const valid = { prefix: '/home', suffix: 'file.txt', contains: 'xxneedle', lower: 'abc', upper: 'ABC', combined: '/file.txt' };
    expect(validate({ first: valid, second: valid })).toBe(true);
    for (const [key, value] of Object.entries({ prefix: 'home', suffix: 'file.log', contains: 'needle', lower: 'Abc', upper: 'AbC', combined: '/file.log' })) {
      expect(validate({ first: { ...valid, [key]: value }, second: valid }), key).toBe(false);
    }
    // Actual portable formats and literal user data must not be normalized away.
    expect(zodSchemaToJsonSchemaObject(z.email(), { target: 'draft-7' })).toHaveProperty('format', 'email');
    const literal = { format: 'starts_with', pattern: '^literal' };
    expect(zodSchemaToJsonSchemaObject(z._default(z.unknown(), literal), { target: 'draft-7' })).toHaveProperty('default', literal);
    expect(() => compilePluginJsonSchema(zodSchemaToJsonSchemaObject(z.stringFormat('private-format', /^value$/), { target: 'draft-7' }))).toThrow();
  });
});
