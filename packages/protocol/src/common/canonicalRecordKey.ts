import { z } from 'zod/mini';

export function canonicalBoundedStringSchema(max: number) {
  return z.string().check(z.minLength(1), z.maxLength(max), z.refine((value) => value === value.trim(), 'Identifier must already be canonical without surrounding whitespace'), z.refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Identifier must not contain control characters'));
}

export function canonicalBoundedRecordKeySchema(max: number) {
  return canonicalBoundedStringSchema(max).check(z.refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value), 'Identifier is reserved and cannot be used as a record key'));
}
