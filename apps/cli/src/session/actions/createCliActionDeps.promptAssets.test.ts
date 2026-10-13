import { describe, expect, it } from 'vitest';

import { createCliActionDeps } from './createCliActionDeps';

describe('createCliActionDeps prompt library bindings', () => {
  it('binds all ordinary prompt-library ActionSpecs for authenticated production execution', () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });

    expect(deps.promptDocUpdate).toEqual(expect.any(Function));
    expect(deps.promptBundleUpdate).toEqual(expect.any(Function));
    expect(deps.promptAssetExport).toEqual(expect.any(Function));
    expect(deps.promptRegistryInstall).toEqual(expect.any(Function));
  });

});
