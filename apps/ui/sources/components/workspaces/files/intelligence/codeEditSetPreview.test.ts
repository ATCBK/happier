import { describe, expect, it } from 'vitest';

import {
  buildEditSetPreviewDiff,
  countEditSetChanges,
} from './codeEditSetPreview';

const HASH = 'a'.repeat(64);
const text =
  'export function formatRetryLabel(attempt: number) {\n  return `Retry ${attempt}`;\n}\n\nconst label = formatRetryLabel(1);\n';
const rename = {
  path: 'src/retry.ts',
  expectedHash: HASH,
  edits: [
    {
      range: {
        start: { line: 0, character: 16 },
        end: { line: 0, character: 32 },
      },
      text: 'formatAttemptLabel',
    },
    {
      range: {
        start: { line: 4, character: 14 },
        end: { line: 4, character: 30 },
      },
      text: 'formatAttemptLabel',
    },
  ],
};

describe('buildEditSetPreviewDiff', () => {
  it('shows exactly the lines the guarded writer will change, with their old and new text', () => {
    const patch = buildEditSetPreviewDiff(rename, text);
    expect(patch).not.toBeNull();
    const changed = patch!
      .split('\n')
      .filter((line) => /^[-+](?![-+])/u.test(line));
    expect(changed).toEqual([
      '-export function formatRetryLabel(attempt: number) {',
      '+export function formatAttemptLabel(attempt: number) {',
      '-const label = formatRetryLabel(1);',
      '+const label = formatAttemptLabel(1);',
    ]);
  });

  it('shows no diff when the text on hand no longer takes the edits', () => {
    expect(buildEditSetPreviewDiff(rename, 'export {};\n')).toBeNull();
  });

  it('counts a move as one change beside its text edits', () => {
    expect(
      countEditSetChanges([
        rename,
        {
          path: 'src/a.ts',
          expectedHash: HASH,
          edits: [],
          renameTo: 'src/b.ts',
        },
      ]),
    ).toEqual({ changes: 3, files: 2 });
  });
});
