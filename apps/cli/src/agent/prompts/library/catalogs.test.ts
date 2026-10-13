import { describe, expect, it } from 'vitest';

import { createPromptProviderCatalog } from './providers';

describe('prompt catalog contracts', () => {
  it('creates an empty prompt provider catalog without scanning runtime sources', () => {
    expect(createPromptProviderCatalog().entries).toEqual([]);
  });

  it('preserves explicit prompt provider entries as catalog data', () => {
    expect(createPromptProviderCatalog([
      {
        id: 'prompt-provider-1',
        pluginId: 'plugin.prompts',
        adapterExportName: 'registerPromptProvider',
      },
    ]).entries).toEqual([
      {
        id: 'prompt-provider-1',
        pluginId: 'plugin.prompts',
        adapterExportName: 'registerPromptProvider',
      },
    ]);
  });
});
