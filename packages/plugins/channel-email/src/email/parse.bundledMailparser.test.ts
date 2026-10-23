import { describe, expect, it, vi } from 'vitest';

vi.mock('mailparser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mailparser')>();
  return { default: { simpleParser: actual.simpleParser } };
});

import { parseEmail } from './parse.js';

describe('parseEmail under the bundled mailparser module shape', () => {
  it('parses MIME when CommonJS exports are exposed through default', async () => {
    const raw = Buffer.from('From: sender@example.com\r\nSubject: Hello\r\n\r\nBody');
    await expect(parseEmail(raw)).resolves.toMatchObject({ subject: 'Hello', text: 'Body' });
  });
});
