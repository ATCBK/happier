import { describe, expect, it } from 'vitest';

import { stripMarkdown } from './markdownPlainText.js';

describe('stripMarkdown', () => {
  // Golden outputs from ce7442f571's apps/ui/sources/utils/sessions/messageUtils.ts#stripMarkdown.
  it('preserves literal role prefixes in preview text', () => {
    expect(stripMarkdown('User: # Question\n- **Check** `scope`\nAssistant: ## Answer\n[Keep access](https://example.test)'))
      .toBe('User: # Question Check scope Assistant: ## Answer Keep access');
  });

  it('removes ordered-list markers and retains table values in previews', () => {
    expect(stripMarkdown('1. First\n\n| Name | State |\n| --- | :---: |\n| Grant | Ready |'))
      .toBe('First Name State Grant Ready');
  });
});
