import { describe, expect, it } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import { ProviderCliError } from './types';
import { unwrapProviderSavedModelsRpcResult } from './actionDependencies';

describe('unwrapProviderSavedModelsRpcResult', () => {
  it('returns models from a successful provider catalog result', () => {
    const models = [{
      id: 'model-a',
      source: 'probe' as const,
      stale: false,
      loadState: 'loaded' as const,
      visibility: 'visible' as const,
    }];

    expect(unwrapProviderSavedModelsRpcResult({
      status: 'success',
      connectionId: 'pc_1',
      connectionRevision: 1,
      manualModelPolicy: 'allowed',
      modelLoadAction: 'descriptor_absent',
      models,
    })).toEqual(models);
  });

  it('preserves the canonical provider error on a failed catalog result', () => {
    const error = createProviderErrorV1('provider_connection_not_found', {
      connectionId: 'pc_missing',
      machineId: 'machine-a',
    });

    expect(() => unwrapProviderSavedModelsRpcResult({ status: 'error', error })).toThrowError(
      expect.objectContaining<Partial<ProviderCliError>>({
        code: error.code,
        details: error,
      }),
    );
  });
});
