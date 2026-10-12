import { describe, expect, it } from 'vitest';
import { normalizeEmailAddress } from './address.js';
describe('email principal identity', () => {
  it('normalizes one bare owner-entered mailbox', () => {
    expect(normalizeEmailAddress(' Alice+sales@Example.COM ')).toBe('alice+sales@example.com');
  });
  it.each(['alice@example.com\r\n', '\nalice@example.com', 'Alice <alice@example.com>', 'alice@example.com,bob@example.com', '.alice@example.com', 'alice..bob@example.com'])('rejects ambiguous or injected principal %j', (value) => {
    expect(normalizeEmailAddress(value)).toBeNull();
  });
});
