import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import { actionInputValidationFailure } from './actionInputValidation.js';

describe('Action input validation diagnostics', () => {
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
