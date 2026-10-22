import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import { actionInputValidationFailure } from './actionInputValidation.js';

describe('Action input validation diagnostics', () => {
  it('keeps full field and array paths through nested union branches without exposing input', () => {
    const schema = z.strictObject({
      items: z.array(z.union([
        z.strictObject({ choice: z.union([z.literal('auto'), z.number()]) }),
        z.boolean(),
      ])),
    });
    const parsed = schema.safeParse({ items: [{ choice: 'private-input', 'private-key': 'private-value' }] });
    if (parsed.success) throw new Error('Fixture must violate the real input schema');

    expect(actionInputValidationFailure(parsed.error)).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: {
        issues: [
          { code: 'invalid_union', path: ['items', 0] },
          { code: 'invalid_union', path: ['items', 0, 'choice'] },
          { code: 'invalid_value', path: ['items', 0, 'choice'], acceptedValues: ['auto'] },
          { code: 'invalid_type', path: ['items', 0, 'choice'], expected: 'number' },
          { code: 'unrecognized_keys', path: ['items', 0] },
          { code: 'invalid_type', path: ['items', 0], expected: 'boolean' },
        ],
      },
    });
  });

  it('keeps repair facts without rejected values, unknown-key lists or input-bearing custom prose', () => {
    const baseSchema = z.strictObject({ title: z.string() });
    const schema = baseSchema.check(z.superRefine((value, ctx) => {
      ctx.addIssue({ code: 'custom', path: ['title'], message: `Rejected private title: ${value.title}` });
    }));
    const custom = schema.safeParse({ title: 'private-input' });
    const unknown = baseSchema.safeParse({ title: 'private-input', 'private-unknown-key': 'private-value' });
    if (custom.success || unknown.success) throw new Error('Fixture must violate the real input schemas');
    expect(actionInputValidationFailure(custom.error)).toEqual({
      ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
      details: { issues: [{ code: 'custom', path: ['title'] }] },
    });
    expect(actionInputValidationFailure(unknown.error)).toEqual({
      ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
      details: { issues: [{ code: 'unrecognized_keys', path: [] }] },
    });
  });
});
