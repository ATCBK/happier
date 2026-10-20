import { describe, expect, it } from 'vitest';

import { PluginCompatibilityDiagnosticSchema } from './types';

describe('PluginCompatibilityDiagnosticSchema', () => {
  it('accepts optional canonical JSON details and diagnostic context', () => {
    expect(PluginCompatibilityDiagnosticSchema.parse({
      code: 'plugin_activation_failed',
      message: 'Activation failed',
    })).toEqual({ code: 'plugin_activation_failed', message: 'Activation failed' });
    expect(PluginCompatibilityDiagnosticSchema.parse({
      code: 'plugin_activation_failed',
      message: 'Activation failed',
      details: { attempts: 2, retryable: true, nested: [null, 'reason'] },
      stage: 'activation',
      stack: 'Activation stack',
    })).toMatchObject({
      details: { attempts: 2, retryable: true, nested: [null, 'reason'] },
      stage: 'activation',
      stack: 'Activation stack',
    });
  });

  it('rejects non-JSON details through the canonical validator', () => {
    expect(PluginCompatibilityDiagnosticSchema.safeParse({
      code: 'plugin_activation_failed',
      message: 'Activation failed',
      details: { invalid: Number.POSITIVE_INFINITY },
    }).success).toBe(false);
  });
});
