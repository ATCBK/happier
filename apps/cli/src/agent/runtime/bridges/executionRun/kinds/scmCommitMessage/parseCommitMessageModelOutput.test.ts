import { describe, expect, it } from 'vitest';

import { parseCommitMessageModelOutput } from './parseCommitMessageModelOutput';

describe('parseCommitMessageModelOutput', () => {
  it('reads the strict output a model wraps in leading prose and a code fence', () => {
    const reply = [
      'Here is the commit message:',
      '```json',
      JSON.stringify({ title: 'fix: keep drafts', body: 'Preserve drafts on rebind.', confidence: 0.8 }),
      '```',
    ].join('\n');

    expect(parseCommitMessageModelOutput(reply)).toMatchObject({
      title: 'fix: keep drafts',
      body: 'Preserve drafts on rebind.',
      message: 'fix: keep drafts\n\nPreserve drafts on rebind.',
      confidence: 0.8,
    });
  });

  it('still treats a plain-text reply as the title and body', () => {
    expect(parseCommitMessageModelOutput('fix: handle {} braces\n\nBody text')).toMatchObject({
      title: 'fix: handle {} braces',
      body: 'Body text',
    });
  });
});
