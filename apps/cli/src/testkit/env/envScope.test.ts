import { describe, expect, it } from 'vitest';
import { createEnvKeyScope } from './envScope';

describe('env scope helpers', () => {
  it('patches and restores selected environment keys', async () => {
    const previous = process.env.HAPPIER_TESTKIT_ENV_SCOPE;
    const scope = createEnvKeyScope(['HAPPIER_TESTKIT_ENV_SCOPE']);

    try {
      scope.patch({ HAPPIER_TESTKIT_ENV_SCOPE: 'patched' });
      expect(process.env.HAPPIER_TESTKIT_ENV_SCOPE).toBe('patched');
    } finally {
      scope.restore();
      if (previous === undefined) {
        expect(process.env.HAPPIER_TESTKIT_ENV_SCOPE).toBeUndefined();
      } else {
        expect(process.env.HAPPIER_TESTKIT_ENV_SCOPE).toBe(previous);
      }
    }
  });
});
