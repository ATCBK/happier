import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as mini from 'zod/mini';
import { compile } from 'zod/v4/core';

import { maxCodeUnits } from './maxCodeUnits.js';

describe('maxCodeUnits', () => {
  it('enforces UTF-16 bounds in classic and mini schemas while preserving maxLength metadata', () => {
    const classic = z.string().check(maxCodeUnits(4));
    const small = mini.string().check(maxCodeUnits(4));
    for (const schema of [classic, small, compile(classic, { strict: true }), compile(small, { strict: true })]) {
      for (const value of ['abcd', '😀ab', '😀😀', '\ud800abc']) {
        expect(schema.parse(value)).toBe(value);
      }
      for (const value of ['abcde', '😀abc', '😀😀a']) {
        const result = schema.safeParse(value);
        expect(result.success, `${JSON.stringify(value)} has ${value.length} code units`).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toMatchObject([
            { code: 'too_big', maximum: 4, origin: 'string', inclusive: true },
          ]);
          expect(result.error.issues).toHaveLength(1);
        }
      }
      expect(schema.safeParse(42).success).toBe(false);
      expect(z.toJSONSchema(schema)).toMatchObject({ type: 'string', maxLength: 4 });
    }
    expect(z.string().max(4).parse('😀abc')).toBe('😀abc');
    expect(mini.string().check(maxCodeUnits(0)).parse('')).toBe('');
    expect(mini.string().check(maxCodeUnits(0)).safeParse('a').success).toBe(false);
    expect(z.toJSONSchema(classic.check(maxCodeUnits(3), maxCodeUnits(5)))).toMatchObject({ maxLength: 3 });
  });
});
